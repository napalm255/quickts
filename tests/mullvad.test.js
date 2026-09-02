import { describe, expect, it } from 'vitest';

import {
    UNKNOWN_COUNTRY,
    cityOf,
    countryOf,
    flagFor,
    groupByCountry,
    partitionMullvad,
} from '../modules/mullvad.js';

const mullvadNode = (overrides = {}) => ({
    id: 'n1',
    name: 'se-sto-wg-001',
    isMullvad: true,
    isExitNode: false,
    location: { Country: 'Sweden', CountryCode: 'se', City: 'Stockholm' },
    ...overrides,
});

describe('flagFor', () => {
    it.each([
        ['se', '🇸🇪'],
        ['SE', '🇸🇪'],
        ['us', '🇺🇸'],
        ['jp', '🇯🇵'],
    ])('turns %s into a flag', (code, flag) => {
        expect(flagFor(code)).toBe(flag);
    });

    it.each([
        ['a three-letter code', 'swe'],
        ['one letter', 's'],
        ['digits', '12'],
        ['an empty string', ''],
        ['null', null],
        ['undefined', undefined],
    ])('returns nothing for %s', (_reason, code) => {
        expect(flagFor(code)).toBe('');
    });
});

describe('countryOf', () => {
    it('reads the location when there is one', () => {
        expect(countryOf(mullvadNode())).toEqual({
            code: 'se',
            name: 'Sweden',
            flag: '🇸🇪',
        });
    });

    // Location is omitempty and could not be verified against a live tailnet,
    // so the hostname convention is the fallback rather than "Other".
    it('recovers the country from the hostname when there is no location', () => {
        const node = mullvadNode({ location: null, name: 'us-nyc-wg-301' });

        expect(countryOf(node)).toEqual({ code: 'us', name: 'US', flag: '🇺🇸' });
    });

    it('uses the code when the location names no country', () => {
        const node = mullvadNode({ location: { CountryCode: 'no' } });

        expect(countryOf(node).name).toBe('NO');
    });

    // Only when both signals are gone. An empty Location still falls through
    // to the hostname, which is the degradation working rather than failing.
    it('still recovers the country from an empty location', () => {
        expect(countryOf(mullvadNode({ location: {} })).code).toBe('se');
    });

    it.each([
        ['a name that is not Mullvad-shaped', { location: null, name: 'my-laptop' }],
        ['no name at all', { location: null, name: '' }],
        ['a name with the wrong shape', { location: null, name: 'se_sto_wg_001' }],
        ['an uppercase name', { location: null, name: 'SE-STO-WG-001' }],
    ])('falls back to the unknown country for %s', (_reason, overrides) => {
        expect(countryOf(mullvadNode(overrides))).toEqual(UNKNOWN_COUNTRY);
    });

    it.each([
        ['null', null],
        ['undefined', undefined],
    ])('does not throw on %s', (_reason, node) => {
        expect(() => countryOf(node)).not.toThrow();
    });
});

describe('cityOf', () => {
    it('prefers the city', () => {
        expect(cityOf(mullvadNode())).toBe('Stockholm');
    });

    it('falls back to the node name', () => {
        expect(cityOf(mullvadNode({ location: null }))).toBe('se-sto-wg-001');
    });

    it('returns a string for nothing', () => {
        expect(cityOf(null)).toBe('');
    });
});

describe('partitionMullvad', () => {
    it('splits the two kinds', () => {
        const nodes = [
            { name: 'laptop', isMullvad: false },
            mullvadNode(),
            { name: 'desktop', isMullvad: false },
        ];
        const { regular, mullvad } = partitionMullvad(nodes);

        expect(regular.map(n => n.name)).toEqual(['laptop', 'desktop']);
        expect(mullvad).toHaveLength(1);
    });

    it.each([
        ['null', null],
        ['undefined', undefined],
        ['an empty list', []],
    ])('handles %s', (_reason, nodes) => {
        expect(partitionMullvad(nodes)).toEqual({ regular: [], mullvad: [] });
    });
});

describe('groupByCountry', () => {
    const se = (city, extra = {}) =>
        mullvadNode({
            id: `se-${city}`,
            name: `se-${city}-wg-001`,
            location: { Country: 'Sweden', CountryCode: 'se', City: city },
            ...extra,
        });
    const us = (city, extra = {}) =>
        mullvadNode({
            id: `us-${city}`,
            name: `us-${city}-wg-001`,
            location: { Country: 'United States', CountryCode: 'us', City: city },
            ...extra,
        });

    it('groups by country', () => {
        const groups = groupByCountry([se('Stockholm'), us('New York'), se('Malmo')]);

        expect(groups.map(g => g.country.code)).toEqual(['se', 'us']);
        expect(groups.at(0).nodes).toHaveLength(2);
    });

    it('sorts cities within a country', () => {
        const groups = groupByCountry([se('Stockholm'), se('Gothenburg'), se('Malmo')]);

        expect(groups.at(0).nodes.map(cityOf)).toEqual([
            'Gothenburg',
            'Malmo',
            'Stockholm',
        ]);
    });

    // The same reasoning as sorting the exit node to the top of the main list:
    // it is the one thing a person opens this menu to check.
    it('puts the country holding the exit node first', () => {
        const groups = groupByCountry([
            se('Stockholm'),
            us('New York', { isExitNode: true }),
        ]);

        expect(groups.at(0).country.code).toBe('us');
    });

    it('sorts countries by name otherwise', () => {
        const groups = groupByCountry([us('New York'), se('Stockholm')]);

        expect(groups.map(g => g.country.name)).toEqual(['Sweden', 'United States']);
    });

    it('puts ungrouped nodes last', () => {
        const orphan = mullvadNode({ id: 'x', name: 'mystery', location: null });
        const groups = groupByCountry([orphan, se('Stockholm')]);

        expect(groups.at(-1).country).toEqual(UNKNOWN_COUNTRY);
    });

    // The whole point of degrading rather than guessing: an unrecognised node
    // is still reachable from the menu.
    it('loses no node, whatever its shape', () => {
        const nodes = [
            se('Stockholm'),
            mullvadNode({ id: 'a', location: null, name: 'mystery' }),
            mullvadNode({ id: 'b', location: undefined, name: '' }),
        ];
        const total = groupByCountry(nodes).reduce((n, g) => n + g.nodes.length, 0);

        expect(total).toBe(nodes.length);
    });

    it.each([
        ['null', null],
        ['an empty list', []],
    ])('returns no groups for %s', (_reason, nodes) => {
        expect(groupByCountry(nodes)).toEqual([]);
    });
});
