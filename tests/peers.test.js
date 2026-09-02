import { describe, expect, it } from 'vitest';

import {
    MULLVAD_TAG,
    displayName,
    exitNodeOf,
    iconNameFor,
    isMullvad,
    normalisePeer,
    normalisePeers,
    sortNodes,
} from '../modules/peers.js';
import { SUFFIX, rawPeer, rawPeerMap } from './fixtures/peers.js';

describe('displayName', () => {
    it('drops the trailing dot and the tailnet suffix', () => {
        expect(displayName(rawPeer(), SUFFIX)).toBe('laptop');
    });

    // A node shared in from another tailnet keeps its own suffix. Taking the
    // first label would render two unrelated machines under one name, and the
    // rows are clickable, so that is a correctness problem.
    it('keeps enough of a foreign name to tell it apart', () => {
        const peer = rawPeer({ DNSName: 'laptop.other-tailnet.ts.net.' });

        expect(displayName(peer, SUFFIX)).toBe('laptop.other-tailnet');
    });

    it('takes the first label when the name is not a tailscale one', () => {
        expect(displayName(rawPeer({ DNSName: 'host.internal.example.com.' }))).toBe(
            'host',
        );
    });

    // With no suffix known, "which tailnet" cannot be answered, so the label
    // is kept. Verbose beats ambiguous, and /status carries MagicDNSSuffix on
    // every response, so this is the rare path rather than the usual one.
    it('keeps the tailnet label when the suffix is unknown', () => {
        expect(displayName(rawPeer())).toBe('laptop.example-tailnet');
    });

    it('tolerates a suffix given with dots around it', () => {
        expect(displayName(rawPeer(), `.${SUFFIX}.`)).toBe('laptop');
    });

    it('falls back to the hostname when there is no DNS name', () => {
        expect(displayName(rawPeer({ DNSName: '', HostName: 'fallback' }))).toBe(
            'fallback',
        );
    });

    it('falls back to the id when there is neither', () => {
        expect(displayName({ ID: 'nABC', DNSName: '', HostName: '' })).toBe('nABC');
    });

    it.each([
        ['null', null],
        ['undefined', undefined],
        ['an empty object', {}],
    ])('returns a string for %s', (_reason, peer) => {
        expect(typeof displayName(peer)).toBe('string');
    });
});

describe('isMullvad', () => {
    it('recognises the tag', () => {
        expect(isMullvad(rawPeer({ Tags: [MULLVAD_TAG] }))).toBe(true);
    });

    // Tags is omitted entirely for an untagged peer, and this could not be
    // checked against a tailnet with Mullvad enabled, so either signal alone
    // is taken as enough rather than requiring both.
    it('recognises a peer that only carries a location', () => {
        expect(isMullvad(rawPeer({ Location: { CountryCode: 'se' } }))).toBe(true);
    });

    it('does not treat an ordinary peer as Mullvad', () => {
        expect(isMullvad(rawPeer())).toBe(false);
    });

    // Upstream reads Tags?.includes(...) directly; a peer whose Tags is a
    // string rather than an array would throw there.
    it.each([
        ['null Tags', { Tags: null }],
        ['Tags as a string', { Tags: 'tag:mullvad-exit-node' }],
        ['an empty location', { Location: {} }],
    ])('does not throw on %s', (_reason, overrides) => {
        expect(() => isMullvad(rawPeer(overrides))).not.toThrow();
    });
});

describe('iconNameFor', () => {
    // Offline wins: a phone that cannot be reached is more usefully drawn as
    // unreachable than as a phone.
    it('draws an offline phone as offline', () => {
        expect(iconNameFor({ online: false, os: 'android', isMullvad: false })).toBe(
            'network-offline-symbolic',
        );
    });

    it.each([
        ['android', { online: true, os: 'android' }, 'phone-symbolic'],
        ['iOS', { online: true, os: 'iOS' }, 'phone-symbolic'],
        ['a Mullvad node', { online: true, isMullvad: true }, 'network-vpn-symbolic'],
        ['a computer', { online: true, os: 'linux' }, 'computer-symbolic'],
        ['an unknown OS', { online: true, os: '' }, 'computer-symbolic'],
    ])('draws %s correctly', (_reason, node, icon) => {
        expect(iconNameFor(node)).toBe(icon);
    });
});

describe('normalisePeer', () => {
    it('produces the shape the rest of QuickTS uses', () => {
        const node = normalisePeer(rawPeer(), { magicDNSSuffix: SUFFIX });

        expect(node).toMatchObject({
            id: 'nSOMEID1CNTRL',
            name: 'laptop',
            hostName: 'laptop',
            os: 'linux',
            online: true,
            isExitNode: false,
            canBeExitNode: false,
            isMullvad: false,
            icon: 'computer-symbolic',
        });
        expect(node.ips).toEqual(['100.64.0.1', 'fd7a:115c:a1e0::1']);
    });

    // The preference is what flips the instant the user clicks; the peer's own
    // ExitNode field lags until the route change takes effect.
    it('marks the exit node from the preference, not the peer', () => {
        const peer = rawPeer({ ExitNode: false });

        expect(normalisePeer(peer, { exitNodeId: 'nSOMEID1CNTRL' }).isExitNode).toBe(
            true,
        );
    });

    it('does not mark a peer whose id is empty', () => {
        expect(normalisePeer(rawPeer({ ID: '' }), { exitNodeId: '' }).isExitNode).toBe(
            false,
        );
    });

    // Online is omitted rather than set false for a peer never reached.
    it('treats an absent Online as offline', () => {
        expect(normalisePeer(rawPeer({ Online: undefined })).online).toBe(false);
    });

    // Where upstream's empty rows came from: a peer with no addresses yet.
    it.each([
        ['absent TailscaleIPs', { TailscaleIPs: undefined }],
        ['null TailscaleIPs', { TailscaleIPs: null }],
    ])('gives %s an empty address list rather than undefined', (_reason, overrides) => {
        expect(normalisePeer(rawPeer(overrides)).ips).toEqual([]);
    });

    it.each([
        ['null', null],
        ['undefined', undefined],
        ['an empty object', {}],
    ])('normalises %s without throwing', (_reason, peer) => {
        expect(() => normalisePeer(peer)).not.toThrow();
    });

    it('carries the taildrop number through untouched', () => {
        expect(normalisePeer(rawPeer({ TaildropTarget: 9 })).taildropTarget).toBe(9);
    });

    it('defaults a missing taildrop number to unknown', () => {
        expect(
            normalisePeer(rawPeer({ TaildropTarget: undefined })).taildropTarget,
        ).toBe(0);
    });
});

describe('normalisePeers', () => {
    it('reads the peer map', () => {
        const nodes = normalisePeers(
            rawPeerMap(
                rawPeer({ DNSName: `b.${SUFFIX}.` }),
                rawPeer({ DNSName: `a.${SUFFIX}.` }),
            ),
            { magicDNSSuffix: SUFFIX },
        );

        expect(nodes.map(node => node.name)).toEqual(['a', 'b']);
    });

    // Peer is null on a single-node tailnet and whenever ?peers=false was used.
    it.each([
        ['null', null],
        ['undefined', undefined],
        ['an empty map', {}],
    ])('returns an empty list for %s', (_reason, peers) => {
        expect(normalisePeers(peers)).toEqual([]);
    });
});

describe('sortNodes', () => {
    const node = (name, extra = {}) => ({
        name,
        online: true,
        isExitNode: false,
        ...extra,
    });

    it('puts the exit node first', () => {
        const sorted = sortNodes([node('a'), node('z', { isExitNode: true })]);

        expect(sorted.map(n => n.name)).toEqual(['z', 'a']);
    });

    it('puts reachable nodes above unreachable ones', () => {
        const sorted = sortNodes([node('a', { online: false }), node('z')]);

        expect(sorted.map(n => n.name)).toEqual(['z', 'a']);
    });

    it('sorts the rest by name', () => {
        expect(sortNodes([node('c'), node('a'), node('b')]).map(n => n.name)).toEqual([
            'a',
            'b',
            'c',
        ]);
    });

    // So that accented names land where a reader expects rather than after z.
    it('sorts accented names where a reader expects', () => {
        expect(sortNodes([node('zeta'), node('Ätna')]).map(n => n.name)).toEqual([
            'Ätna',
            'zeta',
        ]);
    });

    it('does not modify the array it was given', () => {
        const nodes = [node('b'), node('a')];
        sortNodes(nodes);

        expect(nodes.map(n => n.name)).toEqual(['b', 'a']);
    });
});

describe('exitNodeOf', () => {
    it('finds the exit node', () => {
        const nodes = [{ isExitNode: false }, { isExitNode: true, name: 'gateway' }];

        expect(exitNodeOf(nodes).name).toBe('gateway');
    });

    it('returns null when there is none', () => {
        expect(exitNodeOf([{ isExitNode: false }])).toBeNull();
    });

    it('returns null for an empty list', () => {
        expect(exitNodeOf([])).toBeNull();
    });
});
