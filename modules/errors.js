// What went wrong talking to tailscaled, as a value rather than a string.
//
// This file imports nothing. modules/io.js is the only place that can tell a
// Gio.IOErrorEnum apart from an HTTP status, because it is the only place with
// Gio in scope, so it does that translation and throws one of these. Everything
// downstream — the reducer, the menu, the tests — reasons about the symbol.
//
// The division is deliberate: io.js knows Gio, this file knows what to say.

/**
 * Why a request failed.
 *
 * These are the cases QuickTS can say something useful about. Anything else is
 * UNKNOWN, which is reported verbatim rather than guessed at.
 */
export const REASON = Object.freeze({
    /** tailscaled is not installed, or has never run. No socket on disk. */
    SOCKET_MISSING: 'socket-missing',
    /** The socket exists but nothing is listening. The daemon is stopped. */
    CONNECTION_REFUSED: 'connection-refused',
    /** The socket refused us. Almost always the operator is not set. */
    PERMISSION_DENIED: 'permission-denied',
    /** The daemon answered, with a status we cannot use. */
    HTTP: 'http',
    /** The daemon answered with something that is not what it claimed to be. */
    PROTOCOL: 'protocol',
    /** Anything else. */
    UNKNOWN: 'unknown',
});

/** A request to tailscaled that did not produce a usable answer. */
export class TransportError extends Error {
    /**
     * @param {string} reason One of {@link REASON}.
     * @param {string} message Description, for the log rather than the menu.
     * @param {object} [details] Details.
     * @param {number} [details.status] HTTP status, when there was one.
     * @param {unknown} [details.cause] The GError or exception underneath.
     */
    constructor(reason, message, { status = 0, cause = undefined } = {}) {
        // `cause` keeps the original GError reachable. Without it the Gio
        // domain and code — the only things that say *which* syscall failed —
        // are flattened into the message and gone.
        super(message, { cause });

        // Set explicitly so it survives a realm boundary, as CancelledError does.
        this.name = 'TransportError';
        this.reason = reason;
        this.status = status;
    }
}

/**
 * The reason to report for a caught value.
 *
 * @param {unknown} error Caught value.
 * @returns {string} One of {@link REASON}.
 */
export function reasonOf(error) {
    return error?.name === 'TransportError' ? error.reason : REASON.UNKNOWN;
}

/**
 * What to tell the user, untranslated.
 *
 * Untranslated because this file may not import gettext — the same rule that
 * keeps it importable from Vitest. modules/panel.js runs the result through _().
 *
 * PERMISSION_DENIED is the one that earns its place. The daemon returns 403 to
 * a user who is not the tailscale operator, and the extension QuickTS replaces
 * logged that to the journal and rendered an empty, apparently-disconnected
 * menu — leaving no way to discover that one command fixes it.
 *
 * @param {string} reason One of {@link REASON}.
 * @returns {string} A sentence for the menu.
 */
export function messageFor(reason) {
    switch (reason) {
        case REASON.SOCKET_MISSING:
            return 'Tailscale is not installed, or has never been started.';
        case REASON.CONNECTION_REFUSED:
            return 'The Tailscale daemon is not running.';
        case REASON.PERMISSION_DENIED:
            return 'Not permitted. Run: sudo tailscale set --operator=$USER';
        case REASON.HTTP:
            return 'The Tailscale daemon refused the request.';
        case REASON.PROTOCOL:
            return 'The Tailscale daemon sent an unexpected response.';
        default:
            return 'Could not reach the Tailscale daemon.';
    }
}

/**
 * Whether the reason is something the user can act on.
 *
 * Drives whether the menu offers the message as a prominent row or keeps it as
 * a subtitle: telling someone the daemon is unreachable is noise, telling them
 * they need to be the operator is not.
 *
 * @param {string} reason One of {@link REASON}.
 * @returns {boolean} True if there is something to do about it.
 */
export function isActionable(reason) {
    return reason === REASON.PERMISSION_DENIED || reason === REASON.SOCKET_MISSING;
}
