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

// Removing the URL leaves a lead-in with nothing to lead to: "may not work.
// See", or "until it is signed. For more info, see".
//
// One character class on each side rather than \s*[.,;:]*\s* — overlapping
// quantifiers over the same characters are what make a pattern backtrack
// catastrophically, and this one runs over text the daemon controls.
const DANGLING_LEAD_IN =
    /[\s.,;:]*\b(?:for more info|more info|see|at|visit|details?)[\s.,;:]*$/i;

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

    const url = match[0].replace(/[.,;:)\]]+$/, '');
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
        current = current.replace(DANGLING_LEAD_IN, '');
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

/**
 * Whether a message offers somewhere to go.
 *
 * @param {string} message One line from the daemon's health list.
 * @returns {boolean} True if it carries a link.
 */
export function hasLink(message) {
    return describeWarning(message).url !== '';
}
