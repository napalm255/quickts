import { describe, expect, it } from 'vitest';

import { REASON } from '../modules/errors.js';
import {
    BACKEND,
    applyError,
    applyPrefs,
    applyProfiles,
    applyStatus,
    changed,
    initialState,
} from '../modules/state.js';
import { SUFFIX, rawPeer, rawPeerMap } from './fixtures/peers.js';

const status = (overrides = {}) => ({
    BackendState: BACKEND.RUNNING,
    AuthURL: '',
    Health: [],
    MagicDNSSuffix: SUFFIX,
    CurrentTailnet: { Name: 'example@example.com' },
    Self: { HostName: 'desktop', TailscaleIPs: ['100.64.0.9'] },
    Peer: rawPeerMap(rawPeer()),
    ...overrides,
});

const prefs = (overrides = {}) => ({
    WantRunning: true,
    RouteAll: false,
    CorpDNS: true,
    ExitNodeAllowLANAccess: false,
    ShieldsUp: false,
    RunSSH: false,
    ExitNodeID: '',
    ...overrides,
});

describe('initialState', () => {
    it('is reachable-false and empty', () => {
        const state = initialState();

        expect(state.reachable).toBe(false);
        expect(state.nodes).toEqual([]);
        expect(state.backendState).toBe(BACKEND.NO_STATE);
    });

    // Upstream declares exit-node-name a string GObject property and then
    // assigns null to it whenever no peer matches.
    it('types exitNodeName as a string', () => {
        expect(initialState().exitNodeName).toBe('');
    });

    it('is frozen', () => {
        expect(Object.isFrozen(initialState())).toBe(true);
    });
});

describe('applyStatus', () => {
    it('reads the fields the menu renders', () => {
        const state = applyStatus(initialState(), status());

        expect(state).toMatchObject({
            reachable: true,
            backendState: BACKEND.RUNNING,
            magicDNSSuffix: SUFFIX,
            tailnetName: 'example@example.com',
            selfName: 'desktop',
        });
        expect(state.nodes).toHaveLength(1);
    });

    // ?peers=false answers with Peer: null. Emptying the menu on the cheap
    // poll would make the node list flicker every few seconds.
    it('leaves the nodes alone when the peer map was not requested', () => {
        const loaded = applyStatus(initialState(), status());
        const polled = applyStatus(loaded, status({ Peer: null }));

        expect(polled.nodes).toHaveLength(1);
    });

    // An actually-empty tailnet sends {}, which must clear.
    it('clears the nodes for a tailnet with no peers', () => {
        const loaded = applyStatus(initialState(), status());

        expect(applyStatus(loaded, status({ Peer: {} })).nodes).toEqual([]);
    });

    it('treats absent Health as nothing wrong', () => {
        expect(
            applyStatus(initialState(), status({ Health: undefined })).health,
        ).toEqual([]);
    });

    it('carries health warnings through', () => {
        const state = applyStatus(initialState(), status({ Health: ['a', 'b'] }));

        expect(state.health).toEqual(['a', 'b']);
    });

    it.each([
        ['null', null],
        ['undefined', undefined],
        ['an empty object', {}],
    ])('survives %s', (_reason, value) => {
        expect(() => applyStatus(initialState(), value)).not.toThrow();
    });

    it('clears a previous error', () => {
        const failed = applyError(initialState(), REASON.CONNECTION_REFUSED);
        const recovered = applyStatus(failed, status());

        expect(recovered.reachable).toBe(true);
        expect(recovered.errorReason).toBe('');
    });
});

describe('applyPrefs', () => {
    it('reads every preference the menu shows', () => {
        const state = applyPrefs(
            initialState(),
            prefs({ RouteAll: true, ShieldsUp: true, RunSSH: true }),
        );

        expect(state).toMatchObject({
            running: true,
            acceptRoutes: true,
            acceptDNS: true,
            allowLanAccess: false,
            shieldsUp: true,
            ssh: true,
        });
    });

    it('treats a missing preference as off rather than undefined', () => {
        expect(applyPrefs(initialState(), {}).running).toBe(false);
    });

    it.each([
        ['null', null],
        ['undefined', undefined],
    ])('survives %s', (_reason, value) => {
        expect(() => applyPrefs(initialState(), value)).not.toThrow();
    });
});

// The invariant this whole reducer exists for.
describe('exitNodeName', () => {
    const withPeers = () =>
        applyStatus(
            initialState(),
            status({
                Peer: rawPeerMap(
                    rawPeer({
                        ID: 'nGATE',
                        DNSName: `gateway.${SUFFIX}.`,
                        ExitNodeOption: true,
                    }),
                    rawPeer({ ID: 'nLAP', DNSName: `laptop.${SUFFIX}.` }),
                ),
            }),
        );

    it('follows the exit node preference', () => {
        const state = applyPrefs(withPeers(), prefs({ ExitNodeID: 'nGATE' }));

        expect(state.exitNodeId).toBe('nGATE');
        expect(state.exitNodeName).toBe('gateway');
    });

    // Upstream recomputes the name only inside the branch that notices the id
    // changed, so peers arriving after the preferences leave it empty until
    // the id happens to change again.
    it('fills in when the peers arrive after the preferences', () => {
        const prefsFirst = applyPrefs(initialState(), prefs({ ExitNodeID: 'nGATE' }));

        expect(prefsFirst.exitNodeName).toBe('');

        const withNodes = applyStatus(
            prefsFirst,
            status({
                Peer: rawPeerMap(
                    rawPeer({ ID: 'nGATE', DNSName: `gateway.${SUFFIX}.` }),
                ),
            }),
        );

        expect(withNodes.exitNodeName).toBe('gateway');
    });

    // There is no intermediate snapshot in which the id has moved and the name
    // has not: they are computed together or not at all.
    it('is never observed disagreeing with the id', () => {
        let state = withPeers();

        for (const id of ['nGATE', 'nLAP', '', 'nGATE']) {
            state = applyPrefs(state, prefs({ ExitNodeID: id }));
            const marked = state.nodes.find(node => node.isExitNode) ?? null;

            expect(state.exitNodeName).toBe(marked?.name ?? '');
            expect(marked?.id ?? '').toBe(id);
        }
    });

    it('is an empty string, not null, when the exit node is unknown', () => {
        const state = applyPrefs(withPeers(), prefs({ ExitNodeID: 'nGONE' }));

        expect(state.exitNodeName).toBe('');
    });

    it('sorts the exit node to the front after a preference change', () => {
        const state = applyPrefs(withPeers(), prefs({ ExitNodeID: 'nLAP' }));

        expect(state.nodes.at(0).id).toBe('nLAP');
    });
});

describe('applyProfiles', () => {
    const list = [
        { ID: '1', Name: 'work', NetworkProfile: { DisplayName: 'WorkNet' } },
        { ID: '2', Name: 'home', NetworkProfile: { DomainName: 'home.example' } },
    ];

    it('reads the list and the active profile', () => {
        const state = applyProfiles(initialState(), list, { ID: '2' });

        expect(state.profiles).toEqual([
            { id: '1', name: 'work', tailnet: 'WorkNet' },
            { id: '2', name: 'home', tailnet: 'home.example' },
        ]);
        expect(state.currentProfileId).toBe('2');
    });

    // Upstream dereferences p.NetworkProfile.DomainName unguarded, which is
    // exactly upstream issue #42.
    it.each([
        ['a missing NetworkProfile', { ID: '3', Name: 'bare' }],
        ['a null NetworkProfile', { ID: '3', Name: 'bare', NetworkProfile: null }],
        ['an empty NetworkProfile', { ID: '3', Name: 'bare', NetworkProfile: {} }],
    ])('survives %s', (_reason, profile) => {
        const state = applyProfiles(initialState(), [profile]);

        expect(state.profiles).toEqual([{ id: '3', name: 'bare', tailnet: '' }]);
    });

    it.each([
        ['null', null],
        ['undefined', undefined],
        ['a non-array', {}],
    ])('treats %s as no profiles', (_reason, value) => {
        expect(applyProfiles(initialState(), value).profiles).toEqual([]);
    });

    it('keeps the known active profile when current was not re-read', () => {
        const state = applyProfiles(initialState(), list, { ID: '1' });

        expect(applyProfiles(state, list).currentProfileId).toBe('1');
    });
});

describe('applyError', () => {
    // A menu that empties itself when tailscaled restarts is less useful than
    // one that says it has lost contact and still shows what it last knew.
    it('keeps what was already known', () => {
        const loaded = applyPrefs(applyStatus(initialState(), status()), prefs());
        const failed = applyError(loaded, REASON.CONNECTION_REFUSED);

        expect(failed.reachable).toBe(false);
        expect(failed.errorReason).toBe(REASON.CONNECTION_REFUSED);
        expect(failed.nodes).toHaveLength(1);
        expect(failed.running).toBe(true);
    });

    it('falls back to unknown for an empty reason', () => {
        expect(applyError(initialState(), '').errorReason).toBe(REASON.UNKNOWN);
    });
});

describe('changed', () => {
    it('reports nothing for identical snapshots', () => {
        const state = applyStatus(initialState(), status());

        expect(changed(state, applyStatus(state, status()))).toEqual([]);
    });

    it('names a scalar that moved', () => {
        const before = applyPrefs(initialState(), prefs({ ShieldsUp: false }));
        const after = applyPrefs(before, prefs({ ShieldsUp: true }));

        expect(changed(before, after)).toEqual(['shieldsUp']);
    });

    it('names both the id and the derived name together', () => {
        const loaded = applyStatus(initialState(), status());
        const before = applyPrefs(loaded, prefs());
        const after = applyPrefs(before, prefs({ ExitNodeID: 'nSOMEID1CNTRL' }));

        expect(changed(before, after)).toEqual(
            expect.arrayContaining(['exitNodeId', 'exitNodeName', 'nodes']),
        );
    });

    it('notices a peer going offline', () => {
        const before = applyStatus(initialState(), status());
        const after = applyStatus(
            before,
            status({ Peer: rawPeerMap(rawPeer({ Online: false })) }),
        );

        expect(changed(before, after)).toContain('nodes');
    });

    it('notices a peer appearing', () => {
        const before = applyStatus(initialState(), status());
        const after = applyStatus(
            before,
            status({ Peer: rawPeerMap(rawPeer(), rawPeer({ ID: 'nNEW' })) }),
        );

        expect(changed(before, after)).toContain('nodes');
    });

    it('notices health changing', () => {
        const before = applyStatus(initialState(), status());
        const after = applyStatus(before, status({ Health: ['something'] }));

        expect(changed(before, after)).toEqual(['health']);
    });

    it('ignores a field the menu does not render', () => {
        const before = applyStatus(initialState(), status());
        const after = applyStatus(
            before,
            status({ Peer: rawPeerMap(rawPeer({ RxBytes: 999 })) }),
        );

        expect(changed(before, after)).toEqual([]);
    });

    it('notices profiles changing', () => {
        const before = applyProfiles(initialState(), [{ ID: '1', Name: 'a' }]);
        const after = applyProfiles(before, [{ ID: '1', Name: 'renamed' }]);

        expect(changed(before, after)).toEqual(['profiles']);
    });
});

describe('immutability', () => {
    it.each([
        ['applyStatus', state => applyStatus(state, status())],
        ['applyPrefs', state => applyPrefs(state, prefs({ ShieldsUp: true }))],
        ['applyProfiles', state => applyProfiles(state, [{ ID: '1' }])],
        ['applyError', state => applyError(state, REASON.HTTP)],
    ])('%s returns a new frozen state without touching the old one', (_name, apply) => {
        const before = applyStatus(initialState(), status());
        const snapshot = JSON.stringify(before);
        const after = apply(before);

        expect(after).not.toBe(before);
        expect(Object.isFrozen(after)).toBe(true);
        expect(JSON.stringify(before)).toBe(snapshot);
    });
});
