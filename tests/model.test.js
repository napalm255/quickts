import { describe, expect, it, vi } from 'vitest';

import { CancelledError } from '../modules/cancel.js';
import { REASON, TransportError } from '../modules/errors.js';
import { PEERS_STALE_MS, TailscaleModel } from '../modules/model.js';
import { rawPeer, rawPeerMap, SUFFIX } from './fixtures/peers.js';
import { createClock, createDaemon, createScheduler } from './support/daemon.js';

/**
 * Build a model wired to a fake daemon.
 *
 * @param {object} [seed] Daemon responses.
 * @returns {object} The model and everything needed to drive it.
 */
function setup(seed) {
    const daemon = createDaemon(seed);
    const clock = createClock();
    const { scheduler, waits } = createScheduler(daemon.token, clock);
    const model = new TailscaleModel({
        client: daemon.client,
        scheduler,
        token: daemon.token,
        now: clock.now,
    });

    return { daemon, model, clock, waits };
}

/**
 * Let the event loop drain, without any real time passing.
 *
 * Macrotasks rather than microtasks, because the fake scheduler resolves on a
 * timer so that a burst of bus lines is delivered before the flush behind it
 * fires — see createScheduler.
 */
const settle = async (turns = 12) => {
    for (let i = 0; i < turns; i += 1)
        await new Promise(resolve => setTimeout(resolve, 0));
};

describe('reading', () => {
    it('loads status, preferences and profiles on start', async () => {
        const { model, daemon } = setup();
        await model.start();

        expect(model.state.reachable).toBe(true);
        expect(model.state.running).toBe(true);
        expect(model.state.nodes).toHaveLength(1);
        expect(model.state.profiles).toHaveLength(1);
        expect(model.state.currentProfileId).toBe('1');
        expect(daemon.pathsMatching('/status')).toHaveLength(1);
    });

    it('surfaces an unreachable daemon rather than staying blank', async () => {
        const { model, daemon } = setup();
        daemon.failures.set(
            '/localapi/v0/prefs',
            new TransportError(REASON.PERMISSION_DENIED, '403'),
        );

        await model.start();

        expect(model.state.reachable).toBe(false);
        expect(model.state.errorReason).toBe(REASON.PERMISSION_DENIED);
    });
});

describe('subscribers', () => {
    it('receives the snapshot and what moved', async () => {
        const { model } = setup();
        await model.start();

        const seen = [];
        model.subscribe((state, fields) => seen.push([state.shieldsUp, fields]));

        await model.setShieldsUp(true);

        expect(seen).toEqual([[true, ['shieldsUp']]]);
    });

    it('says nothing when nothing moved', async () => {
        const { model } = setup();
        await model.start();
        const listener = vi.fn();
        model.subscribe(listener);

        await model.refresh({ peers: true });

        expect(listener).not.toHaveBeenCalled();
    });

    it('stops telling an unsubscribed listener', async () => {
        const { model } = setup();
        await model.start();
        const listener = vi.fn();
        const off = model.subscribe(listener);

        off();
        await model.setShieldsUp(true);

        expect(listener).not.toHaveBeenCalled();
        expect(model.subscriberCount).toBe(0);
    });

    it('tolerates unsubscribing twice', async () => {
        const { model } = setup();
        const off = model.subscribe(() => {});
        off();

        expect(() => off()).not.toThrow();
    });

    // A widget destroyed in response to a change unsubscribes during the
    // notification; mutating the set mid-iteration would skip the next one.
    it('still notifies the rest when one unsubscribes mid-notification', async () => {
        const { model } = setup();
        await model.start();
        const second = vi.fn();
        const off = model.subscribe(() => off());
        model.subscribe(second);

        await model.setShieldsUp(true);

        expect(second).toHaveBeenCalledTimes(1);
    });

    it('still notifies the rest when one throws', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { model } = setup();
        await model.start();
        const second = vi.fn();
        model.subscribe(() => {
            throw new Error('bad widget');
        });
        model.subscribe(second);

        await model.setShieldsUp(true);

        expect(second).toHaveBeenCalledTimes(1);
        vi.restoreAllMocks();
    });
});

describe('destroy', () => {
    it('drops every subscriber', async () => {
        const { model } = setup();
        model.subscribe(() => {});
        model.subscribe(() => {});

        model.destroy();

        expect(model.subscriberCount).toBe(0);
    });

    // The disable-order race: a request already in flight resolves after the
    // model is gone. Nothing may reach a widget that has been destroyed.
    it('says nothing once destroyed, even for a request already in flight', async () => {
        const { model } = setup();
        await model.start();
        const listener = vi.fn();
        model.subscribe(listener);

        const inFlight = model.setShieldsUp(true);
        model.destroy();
        await inFlight;

        expect(listener).not.toHaveBeenCalled();
    });

    it('refuses further commands', async () => {
        const { model, daemon } = setup();
        await model.start();
        daemon.reset();

        model.destroy();
        await model.setRunning(false);
        await model.refresh({ peers: true });

        expect(daemon.paths).toEqual([]);
    });

    it('gives a subscriber added after destroy a no-op disposer', () => {
        const { model } = setup();
        model.destroy();

        expect(() => model.subscribe(() => {})()).not.toThrow();
        expect(model.subscriberCount).toBe(0);
    });
});

describe('commands', () => {
    it.each([
        ['setRunning', model => model.setRunning(false), { WantRunning: false }],
        ['setAcceptRoutes', model => model.setAcceptRoutes(true), { RouteAll: true }],
        ['setAcceptDNS', model => model.setAcceptDNS(false), { CorpDNS: false }],
        [
            'setAllowLanAccess',
            model => model.setAllowLanAccess(true),
            { ExitNodeAllowLANAccess: true },
        ],
        ['setShieldsUp', model => model.setShieldsUp(true), { ShieldsUp: true }],
        ['setSsh', model => model.setSsh(true), { RunSSH: true }],
        ['setExitNode', model => model.setExitNode('nGATE'), { ExitNodeID: 'nGATE' }],
    ])('%s patches the preference it names', async (_name, run, expected) => {
        const { model, daemon } = setup();
        await model.start();

        await run(model);

        expect(daemon.patches.at(-1)).toMatchObject(expected);
    });

    // The daemon answers a PATCH with the resulting preferences, so a
    // user-initiated change never waits on the bus.
    it('adopts the answer to a change without a further read', async () => {
        const { model, daemon } = setup();
        await model.start();
        daemon.reset();

        await model.setShieldsUp(true);

        expect(model.state.shieldsUp).toBe(true);
        expect(daemon.paths).toEqual(['/localapi/v0/prefs']);
    });

    it('clears the exit node with an empty id', async () => {
        const { model, daemon } = setup();
        await model.start();

        await model.setExitNode('');

        expect(daemon.patches.at(-1)).toEqual({ ExitNodeID: '', ExitNodeIDSet: true });
    });

    // A profile switch replaces the tailnet, the peers and every preference,
    // so nothing on screen survives it.
    it('re-reads everything after a profile switch', async () => {
        const { model, daemon } = setup();
        await model.start();
        daemon.reset();

        await model.switchProfile('2');

        expect(daemon.paths).toContain('/localapi/v0/profiles/2');
        expect(daemon.pathsMatching('/status?peers=false')).toHaveLength(0);
        expect(daemon.pathsMatching('/localapi/v0/status')).toHaveLength(1);
        expect(daemon.paths).toContain('/localapi/v0/profiles/current');
    });

    it('does not re-read after a failed profile switch', async () => {
        const { model, daemon } = setup();
        await model.start();
        daemon.failures.set(
            '/localapi/v0/profiles/2',
            new TransportError(REASON.HTTP, '500'),
        );
        daemon.reset();

        await model.switchProfile('2');

        expect(daemon.pathsMatching('/localapi/v0/status')).toHaveLength(0);
        expect(model.state.errorReason).toBe(REASON.HTTP);
    });

    it('reports a failed command instead of throwing', async () => {
        const { model, daemon } = setup();
        await model.start();
        daemon.failures.set(
            '/localapi/v0/prefs',
            new TransportError(REASON.PERMISSION_DENIED, '403'),
        );

        await expect(model.setRunning(false)).resolves.toBeUndefined();
        expect(model.state.errorReason).toBe(REASON.PERMISSION_DENIED);
    });

    it('reads status after a login so the auth URL can arrive', async () => {
        const { model, daemon } = setup();
        await model.start();
        daemon.reset();

        await model.login();

        expect(daemon.paths).toContain('/localapi/v0/login-interactive');
        expect(daemon.pathsMatching('/localapi/v0/status')).toHaveLength(1);
    });

    it('re-reads the peers after a logout', async () => {
        const { model, daemon } = setup();
        await model.start();
        daemon.reset();

        await model.logout();

        expect(daemon.paths).toContain('/localapi/v0/logout');
        expect(daemon.pathsMatching('peers=false')).toHaveLength(0);
    });
});

describe('the refresh policy', () => {
    it('coalesces a burst of signals into one read', async () => {
        const { model, daemon } = setup();
        await model.start();
        await settle();
        daemon.reset();

        daemon.emit({ Prefs: { WantRunning: true } });
        daemon.emit({ Prefs: { WantRunning: true } });
        daemon.emit({ Prefs: { WantRunning: true } });
        await settle();

        expect(daemon.pathsMatching('/localapi/v0/prefs')).toHaveLength(1);
    });

    // The expensive read, deferred until someone is looking at the answer.
    it('does not read the peer map for a netmap change while the menu is shut', async () => {
        const { model, daemon } = setup();
        await model.start();
        await settle();
        daemon.reset();

        daemon.emit({ NetMap: { Peers: [] } });
        await settle();

        expect(daemon.pathsMatching('peers=false')).toHaveLength(1);
        expect(daemon.pathsMatching('/localapi/v0/status?peers=false')).toHaveLength(1);
    });

    it('reads the peer map when the menu is open', async () => {
        const { model, daemon } = setup();
        await model.start();
        model.setMenuOpen(true);
        await settle();
        daemon.reset();

        daemon.emit({ NetMap: { Peers: [] } });
        await settle();

        expect(daemon.pathsMatching('peers=false')).toHaveLength(0);
    });

    // Deferred, not dropped: opening the menu has to pick up what was skipped.
    it('picks up a deferred netmap change when the menu opens', async () => {
        const { model, daemon } = setup();
        await model.start();
        await settle();

        daemon.emit({ NetMap: { Peers: [] } });
        await settle();
        daemon.reset();

        model.setMenuOpen(true);
        await settle();

        expect(daemon.pathsMatching('/localapi/v0/status')).toHaveLength(1);
        expect(daemon.pathsMatching('peers=false')).toHaveLength(0);
    });

    it('does not re-read on opening the menu when nothing changed', async () => {
        const { model, daemon } = setup();
        await model.start();
        await settle();
        daemon.reset();

        model.setMenuOpen(true);
        await settle();

        expect(daemon.paths).toEqual([]);
    });

    it('reads the peer map anyway once it has gone stale', async () => {
        const { model, daemon, clock } = setup();
        await model.start();
        await settle();
        clock.advance(PEERS_STALE_MS + 1);
        daemon.reset();

        daemon.emit({ NetMap: { Peers: [] } });
        await settle();

        expect(daemon.pathsMatching('peers=false')).toHaveLength(0);
    });

    it('reads only the preferences for a preferences change', async () => {
        const { model, daemon } = setup();
        await model.start();
        await settle();
        daemon.reset();

        daemon.emit({ Prefs: { WantRunning: false } });
        await settle();

        expect(daemon.pathsMatching('/localapi/v0/status')).toHaveLength(0);
        expect(daemon.pathsMatching('/localapi/v0/prefs')).toHaveLength(1);
    });

    it('reads only the cheap status for a state change', async () => {
        const { model, daemon } = setup();
        await model.start();
        await settle();
        daemon.reset();

        daemon.emit({ State: 2 });
        await settle();

        expect(daemon.pathsMatching('/localapi/v0/prefs')).toHaveLength(0);
        expect(daemon.pathsMatching('peers=false')).toHaveLength(1);
    });

    it('ignores a notification that changes nothing it renders', async () => {
        const { model, daemon } = setup();
        await model.start();
        await settle();
        daemon.reset();

        daemon.emit({ Engine: { RBytes: 1 } });
        await settle();

        expect(daemon.paths).toEqual([]);
    });

    it('ignores a malformed line without giving up the stream', async () => {
        const { model, daemon } = setup();
        await model.start();
        await settle();
        daemon.reset();

        daemon.emit('not json');
        daemon.emit({ Prefs: {} });
        await settle();

        expect(daemon.pathsMatching('/localapi/v0/prefs')).toHaveLength(1);
    });
});

describe('bus updates reaching the state', () => {
    it('applies a change the daemon reports', async () => {
        const { model, daemon } = setup();
        await model.start();
        await settle();

        daemon.responses.prefs.ShieldsUp = true;
        daemon.emit({ Prefs: {} });
        await settle();

        expect(model.state.shieldsUp).toBe(true);
    });

    it('notices a peer arriving while the menu is open', async () => {
        const { model, daemon } = setup();
        await model.start();
        model.setMenuOpen(true);
        await settle();

        daemon.responses.status.Peer = rawPeerMap(
            rawPeer(),
            rawPeer({ ID: 'nNEW', DNSName: `newcomer.${SUFFIX}.` }),
        );
        daemon.emit({ NetMap: {} });
        await settle();

        expect(model.state.nodes.map(node => node.name)).toContain('newcomer');
    });

    // A cancellation is teardown, not a fault, and drawing it into the menu
    // would make every disable() flash an error on the way out.
    it('does not record a cancellation as an error', async () => {
        const { model, daemon } = setup();
        await model.start();
        daemon.failures.set('/localapi/v0/prefs', new CancelledError());

        await model.refresh();

        expect(model.state.errorReason).toBe('');
        expect(model.state.reachable).toBe(true);
    });
});

describe('fileTargets', () => {
    it('returns what the daemon lists', async () => {
        const { model } = setup({ fileTargets: [{ Node: { StableID: 'nA' } }] });
        await model.start();

        expect(await model.fileTargets()).toHaveLength(1);
    });

    it('returns nothing rather than throwing when the daemon refuses', async () => {
        const { model, daemon } = setup();
        await model.start();
        daemon.failures.set(
            '/localapi/v0/file-targets',
            new TransportError(REASON.HTTP, '500'),
        );

        expect(await model.fileTargets()).toEqual([]);
    });

    it('returns nothing once destroyed', async () => {
        const { model } = setup({ fileTargets: [{ Node: { StableID: 'nA' } }] });
        await model.start();
        model.destroy();

        expect(await model.fileTargets()).toEqual([]);
    });
});
