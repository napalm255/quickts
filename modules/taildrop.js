// Who can receive a file, and why the rest cannot.
//
// Two sources have to be reconciled. /localapi/v0/file-targets is the
// authoritative list — only a node named there can actually be sent to — but
// it says nothing about the ones it omits. A /status peer carries
// TaildropTarget, which says exactly why a node is or is not eligible. Using
// only the first gives a menu that silently drops most of the tailnet; using
// only the second gives one that offers sends the daemon will refuse.
//
// So the menu is built from the intersection: eligible nodes are actionable,
// and the rest are shown greyed out with the daemon's own reason.
//
// This file imports nothing.

/**
 * ipnstate.TaildropTargetStatus.
 *
 * Wire values, so they are written out rather than derived from a list order.
 */
export const TAILDROP = Object.freeze({
    UNKNOWN: 0,
    AVAILABLE: 1,
    NO_NETMAP: 2,
    NOT_RUNNING: 3,
    MISSING_CAP: 4,
    OFFLINE: 5,
    NO_PEER_INFO: 6,
    UNSUPPORTED_OS: 7,
    NO_PEER_API: 8,
    OWNED_BY_OTHER_USER: 9,
});

/**
 * Why a node cannot receive a file, untranslated.
 *
 * modules/panel.js applies gettext; see the note at the top of
 * modules/health.js for why that split exists.
 *
 * @param {number} status A TaildropTargetStatus.
 * @returns {string} A reason, or '' if the node can receive.
 */
export function reasonFor(status) {
    switch (status) {
        case TAILDROP.AVAILABLE:
            return '';
        case TAILDROP.OFFLINE:
            return 'Offline';
        case TAILDROP.NOT_RUNNING:
            return 'Tailscale is not running there';
        case TAILDROP.MISSING_CAP:
            return 'Taildrop is not enabled for this tailnet';
        case TAILDROP.UNSUPPORTED_OS:
            return 'Not supported on that system';
        case TAILDROP.OWNED_BY_OTHER_USER:
            return 'Owned by another user';
        case TAILDROP.NO_PEER_API:
        case TAILDROP.NO_PEER_INFO:
        case TAILDROP.NO_NETMAP:
            return 'Cannot be reached right now';
        default:
            return 'Cannot receive files';
    }
}

/**
 * Whether a node can receive a file.
 *
 * @param {object} node A normalised node.
 * @returns {boolean} True if the daemon would accept a send.
 */
export function canReceive(node) {
    return node?.taildropTarget === TAILDROP.AVAILABLE;
}

/**
 * The nodes to list, annotated with whether they can be sent to.
 *
 * A node is only actionable if the daemon lists it in file-targets *and*
 * reports it available. The two agreeing is the whole point of intersecting
 * them: file-targets can name a node whose status has since changed, and a
 * status of AVAILABLE means nothing if the daemon will not route the send.
 *
 * Eligible nodes come first, then the rest by name, so the useful half of the
 * list is not buried under a tailnet's worth of sleeping laptops.
 *
 * @param {object[]} nodes Normalised nodes.
 * @param {object[]} fileTargets The /file-targets response.
 * @returns {Array<{node: object, eligible: boolean, reason: string}>} Rows to show.
 */
export function sendTargets(nodes, fileTargets) {
    const listed = new Set(
        (Array.isArray(fileTargets) ? fileTargets : [])
            .map(target => target?.Node?.StableID)
            .filter(Boolean),
    );

    return (nodes ?? [])
        .map(node => {
            const eligible = listed.has(node.id) && canReceive(node);

            return {
                node,
                eligible,
                // A node the daemon left out of file-targets while still
                // calling it available has no more specific explanation to
                // offer than that it cannot be reached.
                reason: eligible
                    ? ''
                    : reasonFor(
                          canReceive(node) ? TAILDROP.NO_PEER_API : node.taildropTarget,
                      ),
            };
        })
        .sort(
            (a, b) =>
                Number(b.eligible) - Number(a.eligible) ||
                a.node.name.localeCompare(b.node.name),
        );
}

/**
 * Whether anything at all can be sent to.
 *
 * The Taildrop submenu hides itself when this is false, rather than offering
 * a list of things that cannot be done.
 *
 * @param {Array<{eligible: boolean}>} targets From {@link sendTargets}.
 * @returns {boolean} True if at least one node can receive.
 */
export function hasEligibleTarget(targets) {
    return (targets ?? []).some(target => target.eligible);
}

/**
 * The file name to send a URI under.
 *
 * The receiver sees this, and it is the last point at which a path could turn
 * into something other than a name — modules/localapi.js percent-encodes it
 * before it reaches a URL, but stripping the directories here means a
 * malformed URI cannot present as a path at all.
 *
 * @param {string} uri A file:// URI.
 * @returns {string} A bare file name.
 */
export function fileNameOf(uri) {
    const path = decodeURIComponent(String(uri ?? '').replace(/^file:\/\//, ''));
    const name = path.split('/').filter(Boolean).at(-1) ?? '';

    return name === '' ? 'file' : name;
}
