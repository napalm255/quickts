// Peer fixtures, written from the observed schema rather than captured.
//
// A real /status response carries the tailnet name, node keys, public
// addresses and the account's email. This repository is public, so nothing
// here is copied from a live daemon; the field names and the shapes are what
// scripts/localapi-check.sh verifies against the real one.

export const SUFFIX = 'example-tailnet.ts.net';

/**
 * Build a raw /status peer.
 *
 * @param {object} [overrides] Fields to replace.
 * @returns {object} A peer in the shape /status returns.
 */
export function rawPeer(overrides = {}) {
    return {
        ID: 'nSOMEID1CNTRL',
        DNSName: `laptop.${SUFFIX}.`,
        HostName: 'laptop',
        OS: 'linux',
        Online: true,
        ExitNode: false,
        ExitNodeOption: false,
        TailscaleIPs: ['100.64.0.1', 'fd7a:115c:a1e0::1'],
        Tags: null,
        TaildropTarget: 1,
        NoFileSharingReason: '',
        ...overrides,
    };
}

/** A peer map keyed the way /status keys it, by public key. */
export function rawPeerMap(...peers) {
    return Object.fromEntries(peers.map((peer, index) => [`nodekey:${index}`, peer]));
}
