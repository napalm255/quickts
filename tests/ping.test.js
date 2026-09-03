import { describe, expect, it } from 'vitest';

import { PING_TYPE, ROUTE, describePing } from '../modules/ping.js';
import { pingRequest } from '../modules/localapi.js';

// Shapes captured from a live daemon's /localapi/v0/ping, retyped here.
const DIRECT = {
    Err: '',
    LatencySeconds: 0.000757188,
    Endpoint: '172.18.255.30:53068',
    DERPRegionCode: '',
    NodeName: 'somewhere',
};

describe('pingRequest', () => {
    // The endpoint reads its parameters with FormValue and takes no body.
    it('puts the parameters in the query string of a POST', () => {
        expect(pingRequest('100.64.0.1', PING_TYPE.DISCO)).toEqual({
            method: 'POST',
            path: '/localapi/v0/ping?ip=100.64.0.1&type=disco',
        });
    });

    it('escapes what it is given', () => {
        expect(pingRequest('a b&c', 'x y').path).toBe(
            '/localapi/v0/ping?ip=a%20b%26c&type=x%20y',
        );
    });
});

describe('describePing', () => {
    it('reads a direct reply', () => {
        expect(describePing(DIRECT)).toEqual({
            ok: true,
            error: '',
            latencyMs: 0.76,
            route: ROUTE.DIRECT,
            relay: '',
        });
    });

    it('reads a relayed reply', () => {
        const result = describePing({
            Err: '',
            LatencySeconds: 0.042,
            Endpoint: '',
            DERPRegionCode: 'lhr',
        });

        expect(result).toMatchObject({ ok: true, route: ROUTE.RELAY, relay: 'lhr' });
    });

    it('reports a reply that did not say how it got there', () => {
        expect(
            describePing({
                Err: '',
                LatencySeconds: 0.01,
                Endpoint: '',
                DERPRegionCode: '',
            }).route,
        ).toBe(ROUTE.UNKNOWN);
    });

    // The daemon answers a failed ping with HTTP 200 and Err set, so a caller
    // that only checks the status code sees every ping succeed.
    it('treats a 200 carrying Err as a failure', () => {
        expect(
            describePing({ Err: 'no matching peer', LatencySeconds: 0 }),
        ).toMatchObject({
            ok: false,
            error: 'no matching peer',
        });
    });

    it('reads a reply that carries no Err field at all', () => {
        expect(describePing({ LatencySeconds: 0.002, Endpoint: 'x:1' })).toMatchObject({
            ok: true,
            latencyMs: 2,
        });
    });

    it.each([
        ['no latency at all', { Err: '', LatencySeconds: 0 }],
        ['a missing latency', { Err: '' }],
        ['a negative latency', { Err: '', LatencySeconds: -1 }],
        ['a latency that is not a number', { Err: '', LatencySeconds: 'soon' }],
    ])('treats %s as no reply', (_reason, response) => {
        const result = describePing(response);

        expect(result.ok).toBe(false);
        expect(result.error).toBe('No reply');
    });

    // A direct hop on a local network is well under a millisecond, so whole
    // numbers would report a working link as "0 ms".
    it('keeps sub-millisecond precision', () => {
        expect(describePing({ Err: '', LatencySeconds: 0.000123 }).latencyMs).toBe(
            0.12,
        );
    });

    it('rounds a slow reply to whole milliseconds', () => {
        expect(describePing({ Err: '', LatencySeconds: 0.1234 }).latencyMs).toBe(123);
    });

    it.each([
        ['null', null],
        ['undefined', undefined],
        ['a string', 'pong'],
        ['a number', 42],
    ])('survives %s', (_reason, response) => {
        const result = describePing(response);

        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/\S/);
    });
});
