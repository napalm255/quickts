// Turning a health message into something a menu can show.
//
// tailscaled's health list is free-form English, and some of the messages
// carry a URL — "SELinux is enabled; Tailscale SSH may not work. See
// https://tailscale.com/s/ssh-selinux". Three of the four constants in
// tailscale's health/healthmsg package do.
//
// A URL is worth pulling out for two reasons. It is the longest and least
// readable part of the message in a menu barely wide enough for the prose, and
// it is the only actionable thing in a warning that is otherwise purely
// informational.
//
// Pulling out a URL is also the one thing that can safely be done to these
// messages. Matching on their English — to offer "turn on accept routes", say
// — would break the moment Tailscale reworded anything, and would break
// silently. A URL is a URL in every release and in every locale.
//
// This file imports nothing.

// http and https only, stopping at whitespace.
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"']+/;

// Prose puts a full stop after a URL; the URL does not own it.
const isUrlPunctuation = character => /[.,;:)\]]/.test(character);

// Removing the URL leaves a lead-in with nothing to lead to: "may not work.
// See", or "until it is signed. For more info, see".
//
// The separators that can sit between the prose and its dangling lead-in.
const isSeparator = character => /[\s.,;:]/.test(character);

// Anchored to the end, so it cannot rescan from every position.
const LEAD_IN = /\b(?:for more info|more info|see|at|visit|details?)$/i;

/**
 * Drop trailing characters a predicate accepts.
 *
 * A scan rather than a `[chars]+$` replace. That idiom is quadratic in the
 * worst case — at every start position the engine matches greedily and then
 * backtracks looking for the anchor — and this runs over text the daemon
 * controls. Walking backwards once is linear and obviously so.
 *
 * @param {string} text Text to trim.
 * @param {(character: string) => boolean} matches Whether to drop a character.
 * @returns {string} The text without its trailing run.
 */
function trimEndWhile(text, matches) {
    let end = text.length;

    while (end > 0 && matches(text.at(end - 1))) end -= 1;

    return text.slice(0, end);
}

/**
 * Split a health message into what to show and what to open.
 *
 * @param {string} message One line from the daemon's health list.
 * @returns {{text: string, url: string}} The prose, and the link if there was one.
 */
export function describeWarning(message) {
    const raw = String(message ?? '').trim();
    const match = URL_PATTERN.exec(raw);

    if (!match) return { text: raw, url: '' };

    const url = trimEndWhile(match[0], isUrlPunctuation);
    const text = stripLeadIns(raw.replace(match[0], '').trim());

    // If removing the URL left nothing worth reading, keep the original rather
    // than showing an empty row.
    return { text: text === '' ? raw : ensureStop(text), url };
}

/**
 * Strip trailing lead-ins until none is left.
 *
 * Repeated because they chain: "For more info, see" is two of them, and one
 * pass would leave the dangling "For more info,". Each pass strictly shortens
 * the string or changes nothing, so this terminates.
 *
 * @param {string} text Prose with the URL already removed.
 * @returns {string} Prose without a dangling lead-in.
 */
function stripLeadIns(text) {
    let current = text;
    let previous;

    do {
        previous = current;
        current = trimEndWhile(current, isSeparator).replace(LEAD_IN, '');
    } while (current !== previous);

    return current;
}

/**
 * Put back the full stop that removing a trailing clause took away.
 *
 * @param {string} text Prose.
 * @returns {string} Prose ending in punctuation.
 */
function ensureStop(text) {
    return /[.!?]$/.test(text) ? text : `${text}.`;
}
