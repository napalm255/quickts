// The IPN bus, read strictly as a change signal.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: the bus tells us *that* something
// changed. /status and /prefs tell us *what* it is. No value is ever read out
// of a notification and shown to the user.
//
// That is not fastidiousness. The extension QuickTS replaces translates the
// bus's NetMap peers into its own shape and renders them, and that shape
// disagrees with the one /status returns for the same peers:
//
//   Tags            absent from a NetMap peer, so every Mullvad exit node
//                   disappears the moment the first bus update arrives
//                   (upstream issue #35)
//   ExitNodeOption  re-derived by sniffing AllowedIPs for 0.0.0.0/0 rather
//                   than read, so it disagrees with the daemon's own answer
//   Online          means something different in each payload, which is where
//                   the empty rows in upstream issue #28 come from
//
// Two translations of one dataset cannot be kept in agreement, so this file
// offers no way to get a peer out of a notification. There is nothing to
// misuse. The cost is one small re-read per burst over a Unix socket, and
// statusRequest({peers: false}) makes even that cheap while the menu is shut.
//
// This file imports nothing.

/** Nothing has changed. */
export const NOTHING_DIRTY = Object.freeze({
    prefs: false,
    peers: false,
    state: false,
    health: false,
});

/**
 * Parse one line of the newline-delimited stream.
 *
 * A malformed line must not take down the subscription. The daemon is not
 * expected to send one, but a truncated read at the moment tailscaled restarts
 * looks exactly like this, and reconnecting the whole stream because of it
 * would turn a hiccup into a visible outage.
 *
 * @param {string} line One line, without its terminator.
 * @returns {{ok: true, notify: object}|{ok: false, error: string}} Outcome.
 */
export function parseBusLine(line) {
    if (typeof line !== 'string' || line.trim() === '')
        return { ok: false, error: 'empty line' };

    let notify;
    try {
        notify = JSON.parse(line);
    } catch (error) {
        return { ok: false, error: `${error}` };
    }

    if (notify === null || typeof notify !== 'object' || Array.isArray(notify))
        return { ok: false, error: 'not an object' };

    return { ok: true, notify };
}

/**
 * Which reads a notification makes necessary.
 *
 * Keyed on *which fields carry a value*, never on what the value is. The
 * daemon sends every field on every notification and leaves the irrelevant
 * ones null — the initial message is `State` set and the other nine null — so
 * "present" has to mean "not null" for this to discriminate at all.
 *
 * @param {object} notify A parsed notification.
 * @returns {{prefs: boolean, peers: boolean, state: boolean, health: boolean}} What to re-read.
 */
export function dirtyFrom(notify) {
    // Named rather than indexed, so the field list is fixed at author time.
    // Indexing by a variable would also make this the one place in QuickTS
    // where a notification could reach a property name.
    const carries = value => (value ?? null) !== null;

    return {
        // Prefs changed. Read /prefs, which is small.
        prefs: carries(notify?.Prefs),

        // The netmap moved: a peer appeared, went offline, or changed name.
        // Read the full /status, but only when someone is looking — see the
        // refresh policy in modules/model.js.
        peers: carries(notify?.NetMap),

        // Backend state, a finished login, or a URL to visit. Any of these
        // changes what the toggle says, so read the cheap /status.
        state:
            carries(notify?.State) ||
            carries(notify?.LoginFinished) ||
            carries(notify?.BrowseToURL),

        // The daemon reported a problem. /status carries the full Health list.
        health: carries(notify?.ErrMessage),
    };
}

/**
 * Combine two sets of dirty flags.
 *
 * A burst is coalesced into one flush, so what the flush must read is the
 * union of what every signal in the burst asked for.
 *
 * @param {object} left Flags.
 * @param {object} right Flags.
 * @returns {{prefs: boolean, peers: boolean, state: boolean, health: boolean}} The union.
 */
export function mergeDirty(left, right) {
    return {
        prefs: Boolean(left.prefs || right.prefs),
        peers: Boolean(left.peers || right.peers),
        state: Boolean(left.state || right.state),
        health: Boolean(left.health || right.health),
    };
}

/**
 * Whether anything needs reading.
 *
 * @param {object} dirty Flags.
 * @returns {boolean} True if at least one flag is set.
 */
export function isDirty(dirty) {
    return Boolean(dirty.prefs || dirty.peers || dirty.state || dirty.health);
}
