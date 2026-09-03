// Grouping Mullvad's exit nodes so the list is usable.
//
// A tailnet with Mullvad enabled gains several thousand exit nodes. Listing
// them flat is not a menu, it is a wall, so they are pulled out of the main
// list and grouped by country.
//
// THIS COULD NOT BE VERIFIED AGAINST A LIVE TAILNET. The tailnet QuickTS was
// developed on has no Mullvad nodes, so the Location field — which
// ipn/ipnstate.go declares omitempty — never appeared in a real response.
// Everything here is therefore written to degrade rather than to guess: if
// Location is missing, the country is recovered from Mullvad's own hostname
// convention, and if that fails too the node still appears, just ungrouped.
// Nothing throws and nothing disappears.
//
// This file imports nothing.

// One collator, built once. Its compare() orders exactly as localeCompare()
// does, but a bare localeCompare() call resolves a collator every time — and
// these comparators run over several thousand Mullvad nodes.
const collator = new Intl.Collator();

/** Where a node goes when its country cannot be determined. */
export const UNKNOWN_COUNTRY = Object.freeze({
    code: '',
    name: 'Other',
    flag: '',
});

/**
 * Mullvad names its nodes `<country>-<city>-wg-<n>`, e.g. `se-sto-wg-001`.
 * Used only when Location is absent.
 */
const MULLVAD_NAME = /^([a-z]{2})-([a-z]{3})-/;

/**
 * The flag emoji for an ISO 3166-1 alpha-2 country code.
 *
 * Built from regional indicator symbols, which are the letters A-Z offset into
 * a dedicated Unicode block; a pair of them is rendered as one flag. This
 * needs no lookup table and no data to go stale.
 *
 * @param {string} code Two-letter country code, any case.
 * @returns {string} A flag, or '' if the code is not two ASCII letters.
 */
export function flagFor(code) {
    const letters = (code ?? '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(letters)) return '';

    const A = 'A'.codePointAt(0);
    const INDICATOR = 0x1f1e6;

    return String.fromCodePoint(
        ...[...letters].map(letter => INDICATOR + (letter.codePointAt(0) - A)),
    );
}

/**
 * Where a Mullvad node is, as best as can be determined.
 *
 * @param {object} node A normalised node.
 * @returns {{code: string, name: string, flag: string}} The country.
 */
export function countryOf(node) {
    const location = node?.location ?? null;

    if (location?.CountryCode) {
        const code = String(location.CountryCode).toLowerCase();
        return Object.freeze({
            code,
            name: location.Country || code.toUpperCase(),
            flag: flagFor(code),
        });
    }

    // No Location. Mullvad's hostnames carry the same information, so use it
    // rather than dropping the node into "Other".
    const match = MULLVAD_NAME.exec(node?.name ?? '');
    if (match) {
        const code = match[1];
        return Object.freeze({ code, name: code.toUpperCase(), flag: flagFor(code) });
    }

    return UNKNOWN_COUNTRY;
}

/**
 * The label for a Mullvad node inside its country group.
 *
 * The country is already the group heading, so repeating it in every row
 * wastes the width the city needs.
 *
 * @param {object} node A normalised node.
 * @returns {string} A label.
 */
export function cityOf(node) {
    return node?.location?.City || node?.name || '';
}

/**
 * Split the ordinary nodes from Mullvad's.
 *
 * @param {object[]} nodes Normalised nodes.
 * @returns {{regular: object[], mullvad: object[]}} The two lists, order preserved.
 */
export function partitionMullvad(nodes) {
    const regular = [];
    const mullvad = [];

    for (const node of nodes ?? []) (node.isMullvad ? mullvad : regular).push(node);

    return { regular, mullvad };
}

/**
 * Group Mullvad nodes by country.
 *
 * Countries are ordered by name so the list is scannable, except that a
 * country holding the node currently in use comes first — the same reasoning
 * as sorting the exit node to the top of the main list.
 *
 * @param {object[]} nodes Mullvad nodes, from {@link partitionMullvad}.
 * @returns {Array<{country: object, nodes: object[]}>} Groups.
 */
export function groupByCountry(nodes) {
    const groups = new Map();

    for (const node of nodes ?? []) {
        const country = countryOf(node);
        if (!groups.has(country.code)) groups.set(country.code, { country, nodes: [] });
        groups.get(country.code).nodes.push(node);
    }

    // Both sorts decorate first. A comparator runs O(n log n) times, so
    // calling cityOf() and hasExitNode() inside one re-derives the same
    // answers thousands of times over — and hasExitNode walks a whole group's
    // node array on each call. Computing each once is the same order as
    // reading the list.
    for (const group of groups.values()) {
        const cities = new Map(group.nodes.map(node => [node, cityOf(node)]));
        group.nodes.sort((a, b) => collator.compare(cities.get(a), cities.get(b)));
    }

    return [...groups.values()]
        .map(group => ({ group, inUse: hasExitNode(group) }))
        .sort(
            (a, b) =>
                Number(b.inUse) - Number(a.inUse) ||
                // "Other" last, whatever it is called.
                Number(a.group.country.code === '') -
                    Number(b.group.country.code === '') ||
                collator.compare(a.group.country.name, b.group.country.name),
        )
        .map(({ group }) => group);
}

/**
 * Whether a group holds the node currently in use.
 *
 * @param {{nodes: object[]}} group A group.
 * @returns {boolean} True if the exit node is in it.
 */
function hasExitNode(group) {
    return group.nodes.some(node => node.isExitNode);
}
