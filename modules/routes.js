// Advertising routes: acting as an exit node, and offering subnets.
//
// Both are one preference. AdvertiseRoutes is a list of CIDR prefixes, and a
// node is an exit node exactly when that list contains both default routes —
// 0.0.0.0/0 and ::/0. tailscale's own Prefs.SetAdvertiseExitNode does the same
// thing: strip every /0, then append the pair back if the node should be one.
//
// Keeping the two halves in one place is what stops turning off "run as exit
// node" from taking the subnet routes with it, which is the obvious way to get
// this wrong.
//
// This file imports nothing.

/** The two prefixes that together mean "this node is an exit node". */
export const EXIT_ROUTES = Object.freeze(['0.0.0.0/0', '::/0']);

/**
 * Whether a route list advertises this node as an exit node.
 *
 * Both are required, matching tsaddr.ContainsExitRoutes. A node offering only
 * the v4 default is not an exit node to Tailscale, and reporting it as one
 * would make the switch disagree with the daemon.
 *
 * @param {string[]|null} routes AdvertiseRoutes from /prefs.
 * @returns {boolean} True if both default routes are present.
 */
export function advertisesExitNode(routes) {
    const list = normaliseRoutes(routes);

    return EXIT_ROUTES.every(route => list.includes(route));
}

/**
 * The subnet routes, with the exit-node prefixes removed.
 *
 * @param {string[]|null} routes AdvertiseRoutes from /prefs.
 * @returns {string[]} Everything that is not a default route.
 */
export function subnetRoutes(routes) {
    return normaliseRoutes(routes).filter(route => !isDefaultRoute(route));
}

/**
 * A new route list that advertises, or stops advertising, this node as an exit node.
 *
 * The subnet routes are preserved either way. Turning the switch off must not
 * silently withdraw a subnet this machine is routing for.
 *
 * @param {string[]|null} routes Current AdvertiseRoutes.
 * @param {boolean} enabled Whether to be an exit node.
 * @returns {string[]} The list to send.
 */
export function withExitNode(routes, enabled) {
    const subnets = subnetRoutes(routes);

    return enabled ? [...subnets, ...EXIT_ROUTES] : subnets;
}

/**
 * A new route list with these subnets, keeping the exit-node setting.
 *
 * @param {string[]|null} routes Current AdvertiseRoutes.
 * @param {string[]} subnets Subnets to advertise.
 * @returns {string[]} The list to send.
 */
export function withSubnets(routes, subnets) {
    const exit = advertisesExitNode(routes) ? EXIT_ROUTES : [];

    return [...normaliseRoutes(subnets).filter(r => !isDefaultRoute(r)), ...exit];
}

/**
 * Whether a prefix is one of the two default routes.
 *
 * Compared on the prefix length rather than the text, because ::/0 and
 * 0000::/0 are the same route written differently and tailscale compares them
 * as parsed prefixes.
 *
 * @param {string} route A CIDR prefix.
 * @returns {boolean} True if it is a default route.
 */
function isDefaultRoute(route) {
    return /\/0$/.test(String(route).trim());
}

/**
 * A route list as an array of trimmed strings.
 *
 * AdvertiseRoutes is null rather than empty when nothing is advertised, which
 * is the shape that makes a caller reaching straight for .includes throw.
 *
 * @param {string[]|null} routes Possibly-absent list.
 * @returns {string[]} A usable list.
 */
function normaliseRoutes(routes) {
    if (!Array.isArray(routes)) return [];

    return routes.map(route => String(route).trim()).filter(Boolean);
}

/**
 * Whether a string is a CIDR prefix tailscaled will accept.
 *
 * Deliberately strict, because this is user input on its way into a routing
 * table: four decimal octets and a length of 0-32, or a colon-bearing v6
 * address and a length of 0-128. It does not attempt to be a full IPv6 parser;
 * the daemon does that, and rejects what it does not like. What this catches
 * is the typo before it is sent.
 *
 * @param {string} route A CIDR prefix.
 * @returns {boolean} True if it looks like a prefix.
 */
export function isValidRoute(route) {
    const text = String(route ?? '').trim();
    const slash = text.lastIndexOf('/');
    if (slash < 1) return false;

    const address = text.slice(0, slash);
    const bits = text.slice(slash + 1);

    if (!/^\d{1,3}$/.test(bits)) return false;

    if (address.includes(':'))
        return Number(bits) <= 128 && /^[0-9a-fA-F:]+$/.test(address);

    const octets = address.split('.');

    return (
        Number(bits) <= 32 &&
        octets.length === 4 &&
        octets.every(octet => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
    );
}

/**
 * Split a user-entered list into routes, keeping the invalid ones separate.
 *
 * @param {string} text Comma or whitespace separated prefixes.
 * @returns {{routes: string[], invalid: string[]}} What was understood, and what was not.
 */
export function parseRoutes(text) {
    const parts = String(text ?? '')
        .split(/[\s,]+/)
        .map(part => part.trim())
        .filter(Boolean);

    return {
        routes: parts.filter(isValidRoute),
        invalid: parts.filter(part => !isValidRoute(part)),
    };
}
