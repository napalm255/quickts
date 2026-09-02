// Keep a stream open for as long as the token is live.
//
// This file imports nothing but modules/cancel.js, and takes the connection,
// the clock and the schedule as arguments — so the entire retry behaviour is
// exercised in Vitest on plain Node, with no timers and no sockets.

import { isCancelled } from './cancel.js';

/**
 * Consume a stream, reconnecting until cancelled.
 *
 * Three things here that the extension QuickTS replaces gets wrong.
 *
 * It breaks out of `while (true)` from inside its own catch, so after any
 * error that is not a cancellation it stops reconnecting entirely and the menu
 * silently stops updating for the rest of the session.
 *
 * It awaits a delay whose GLib source disable() removes from somewhere else,
 * so on teardown the promise never settles and the loop is stranded — the
 * paired remove-and-reject in modules/io.js is the other half of that fix, and
 * this loop relies on the delay rejecting to get out.
 *
 * It has no notion of attempts at all, so a daemon that is down is retried
 * every five seconds forever.
 *
 * The attempt counter is driven by whether a connection *produced anything*,
 * not by whether it threw. A socket that accepts and immediately hangs up
 * exits the for-await cleanly, and treating that as success would hold the
 * backoff at its floor and hammer a half-open daemon. A stream that delivered
 * events and was then closed is a different thing and comes straight back.
 * QuickTS subscribes with NotifyInitialState, so a healthy subscription
 * produces an event immediately and the distinction costs nothing.
 *
 * @param {object} options Options.
 * @param {import('./cancel.js').CancelToken} options.token Lifetime.
 * @param {() => AsyncIterable<string>} options.connect Opens the stream.
 * @param {(event: string) => void} options.onEvent Receives each line.
 * @param {(error: unknown) => void} options.onError Receives each failure.
 * @param {(ms: number) => Promise<void>} options.delay Waits, rejecting on cancel.
 * @param {(attempt: number) => number} options.backoff How long to wait before retry n.
 * @returns {Promise<void>} Resolves once the token is cancelled.
 */
export async function runWithReconnect({
    token,
    connect,
    onEvent,
    onError,
    delay,
    backoff,
}) {
    let attempt = 0;

    while (!token.cancelled) {
        // Whether this connection produced anything at all. That, rather than
        // whether it threw, is what separates a healthy stream the daemon
        // closed from a socket that accepts and immediately hangs up — the
        // second must back off, the first should come straight back.
        let productive = false;

        try {
            // `for await` gives correct teardown for free: breaking out of it,
            // or throwing through it, calls the generator's return(), which
            // runs the finally that closes the stream.
            for await (const event of connect()) {
                if (token.cancelled) break;

                productive = true;
                attempt = 0;
                onEvent(event);
            }
        } catch (error) {
            // Checked before isCancelled, so a Gio cancellation that escaped
            // untranslated still ends the loop rather than being retried.
            if (token.cancelled) return;
            if (isCancelled(error)) return;

            onError(error);
        }

        if (token.cancelled) return;

        try {
            await delay(backoff(attempt));
        } catch {
            // The only thing delay rejects with is cancellation.
            return;
        }

        if (!productive) attempt += 1;
    }
}
