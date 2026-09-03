// Reading a ping result.
//
// tailscaled will ping a peer for us — the same thing `tailscale ping` does —
// so QuickTS needs no subprocess and no ICMP privileges of its own. A disco
// ping is the informative one: it reports the round trip and, through which of
// two fields is set, whether the packets went straight to the peer or through
// a relay. That second part is usually what someone is actually asking when
// they ping a machine on a tailnet.
//
// This file imports nothing.

/** How to ping. Wire values from tailscale's LocalAPI. */
export const PING_TYPE = Object.freeze({
    /** Peer-to-peer path discovery. Reports the route as well as the latency. */
    DISCO: 'disco',
    /** Tailscale's own transport-layer ping; needs the peer to be running Tailscale. */
    TSMP: 'TSMP',
    /** An ICMP echo inside the tunnel. */
    ICMP: 'ICMP',
});

/** How the packets got there. */
export const ROUTE = Object.freeze({
    /** Straight to the peer. */
    DIRECT: 'direct',
    /** Through one of Tailscale's relays. */
    RELAY: 'relay',
    /** It answered, but did not say how. */
    UNKNOWN: 'unknown',
});

/**
 * Interpret a /localapi/v0/ping response.
 *
 * The daemon reports a failed ping as a 200 with `Err` set rather than as an
 * HTTP error, so a caller that only checks the status code sees every ping
 * succeed.
 *
 * @param {object} response Parsed ping response.
 * @returns {{ok: boolean, error: string, latencyMs: number, route: string, relay: string}} What happened.
 */
export function describePing(response) {
    const nothing = {
        ok: false,
        error: '',
        latencyMs: 0,
        route: ROUTE.UNKNOWN,
        relay: '',
    };

    if (response === null || typeof response !== 'object')
        return { ...nothing, error: 'No response' };

    const error = String(response.Err ?? '').trim();
    if (error !== '') return { ...nothing, error };

    const seconds = Number(response.LatencySeconds);

    // A reply with no latency is not a reply. The daemon returns this shape
    // when the ping timed out without an explicit error.
    if (!Number.isFinite(seconds) || seconds <= 0)
        return { ...nothing, error: 'No reply' };

    const relay = String(response.DERPRegionCode ?? '').trim();
    const endpoint = String(response.Endpoint ?? '').trim();

    return {
        ok: true,
        error: '',
        latencyMs: roundLatency(seconds * 1000),
        route: routeOf(endpoint, relay),
        relay,
    };
}

/**
 * How the packets got there, from whichever field the daemon filled in.
 *
 * A disco ping reports a direct hop by naming the endpoint it reached, and a
 * relayed one by naming the DERP region. Exactly one is set on a success.
 *
 * @param {string} endpoint The peer address that answered, if it was direct.
 * @param {string} relay The DERP region code, if it was relayed.
 * @returns {string} One of {@link ROUTE}.
 */
function routeOf(endpoint, relay) {
    if (endpoint !== '') return ROUTE.DIRECT;
    if (relay !== '') return ROUTE.RELAY;

    return ROUTE.UNKNOWN;
}

/**
 * Round a latency to a sensible number of digits.
 *
 * A direct hop on a local network comes back in well under a millisecond, so
 * a whole number would round most of them to zero and report a working link as
 * "0 ms". Anything over ten is not interesting below the millisecond.
 *
 * @param {number} ms Milliseconds.
 * @returns {number} Milliseconds, rounded for display.
 */
function roundLatency(ms) {
    return ms < 10 ? Math.round(ms * 100) / 100 : Math.round(ms);
}
