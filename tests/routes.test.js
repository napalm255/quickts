import { describe, expect, it } from 'vitest';

import {
    EXIT_ROUTES,
    advertisesExitNode,
    isValidRoute,
    parseRoutes,
    subnetRoutes,
    withExitNode,
    withSubnets,
} from '../modules/routes.js';

const SUBNET = '192.168.1.0/24';

describe('advertisesExitNode', () => {
    it('is true only with both default routes', () => {
        expect(advertisesExitNode(EXIT_ROUTES)).toBe(true);
    });

    // tsaddr.ContainsExitRoutes requires both; a node offering only the v4
    // default is not an exit node to Tailscale, and saying it is would make
    // the switch disagree with the daemon.
    it.each([
        ['only the v4 default', ['0.0.0.0/0']],
        ['only the v6 default', ['::/0']],
        ['no routes', []],
        ['only subnets', [SUBNET]],
    ])('is false with %s', (_reason, routes) => {
        expect(advertisesExitNode(routes)).toBe(false);
    });

    // AdvertiseRoutes is null, not [], when nothing is advertised.
    it.each([
        ['null', null],
        ['undefined', undefined],
        ['a non-array', 'nonsense'],
    ])('survives %s', (_reason, routes) => {
        expect(advertisesExitNode(routes)).toBe(false);
    });
});

describe('subnetRoutes', () => {
    it('drops the default routes', () => {
        expect(subnetRoutes([...EXIT_ROUTES, SUBNET])).toEqual([SUBNET]);
    });

    it('drops a default route written differently', () => {
        expect(subnetRoutes(['0000::/0', SUBNET])).toEqual([SUBNET]);
    });

    it('returns nothing for null', () => {
        expect(subnetRoutes(null)).toEqual([]);
    });
});

describe('withExitNode', () => {
    it('adds both default routes', () => {
        expect(withExitNode([], true).sort()).toEqual([...EXIT_ROUTES].sort());
    });

    // Turning the switch off must not silently withdraw a subnet this machine
    // is routing for.
    it('keeps the subnets when turning off', () => {
        expect(withExitNode([...EXIT_ROUTES, SUBNET], false)).toEqual([SUBNET]);
    });

    it('keeps the subnets when turning on', () => {
        expect(withExitNode([SUBNET], true)).toContain(SUBNET);
        expect(advertisesExitNode(withExitNode([SUBNET], true))).toBe(true);
    });

    it('does not duplicate the default routes', () => {
        const twice = withExitNode(withExitNode([], true), true);

        expect(twice).toHaveLength(2);
    });

    it('is a no-op turning off when already off', () => {
        expect(withExitNode([SUBNET], false)).toEqual([SUBNET]);
    });
});

describe('withSubnets', () => {
    it('replaces the subnets', () => {
        expect(withSubnets([SUBNET], ['10.0.0.0/8'])).toEqual(['10.0.0.0/8']);
    });

    it('keeps the exit-node setting', () => {
        const result = withSubnets([...EXIT_ROUTES, SUBNET], ['10.0.0.0/8']);

        expect(advertisesExitNode(result)).toBe(true);
        expect(result).toContain('10.0.0.0/8');
    });

    // Otherwise a subnet field could turn the machine into an exit node.
    it('refuses to smuggle a default route in through the subnets', () => {
        expect(advertisesExitNode(withSubnets([], ['0.0.0.0/0', '::/0']))).toBe(false);
    });
});

describe('isValidRoute', () => {
    it.each([
        ['192.168.1.0/24'],
        ['10.0.0.0/8'],
        ['0.0.0.0/0'],
        ['100.64.0.1/32'],
        ['fd7a:115c:a1e0::/48'],
        ['::/0'],
    ])('accepts %s', route => {
        expect(isValidRoute(route)).toBe(true);
    });

    it.each([
        ['no prefix length', '192.168.1.0'],
        ['an empty length', '192.168.1.0/'],
        ['a length past 32', '192.168.1.0/33'],
        ['a length past 128', 'fd7a::/129'],
        ['an octet past 255', '192.168.300.0/24'],
        ['three octets', '192.168.1/24'],
        ['five octets', '1.2.3.4.5/24'],
        ['a hostname', 'example.com/24'],
        ['a non-numeric length', '10.0.0.0/eight'],
        ['nothing', ''],
        ['null', null],
        ['a bare slash', '/'],
    ])('rejects %s', (_reason, route) => {
        expect(isValidRoute(route)).toBe(false);
    });
});

describe('parseRoutes', () => {
    it('splits on commas and whitespace', () => {
        expect(parseRoutes('10.0.0.0/8, 192.168.1.0/24\n172.16.0.0/12').routes).toEqual(
            ['10.0.0.0/8', '192.168.1.0/24', '172.16.0.0/12'],
        );
    });

    // Reported rather than dropped: silently discarding a typo would leave the
    // user believing a subnet is advertised when it is not.
    it('keeps the invalid entries separate', () => {
        const { routes, invalid } = parseRoutes('10.0.0.0/8, nonsense, 192.168.1.0/99');

        expect(routes).toEqual(['10.0.0.0/8']);
        expect(invalid).toEqual(['nonsense', '192.168.1.0/99']);
    });

    it.each([
        ['an empty string', ''],
        ['only separators', ' , , '],
        ['null', null],
    ])('returns nothing for %s', (_reason, text) => {
        expect(parseRoutes(text)).toEqual({ routes: [], invalid: [] });
    });
});
