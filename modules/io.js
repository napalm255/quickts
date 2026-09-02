// The only file that speaks to the outside world.
//
// It imports Gio, GLib and Soup, and nothing from resource:///. That is what
// lets scripts/localapi-check.sh run it under plain gjs, against the real
// tailscaled, with no compositor in the loop — the only check that catches
// Tailscale changing its JSON.
//
// It makes no decisions. Every path, body, delay and retry is computed by a
// pure module and handed here to be carried out. If a branch worth testing ever
// appears below, it belongs in modules/localapi.js, modules/timing.js or
// modules/reconnect.js instead — which is also why this file is excluded from
// coverage, with the reasoning recorded in vitest.config.js.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import { CancelledError } from './cancel.js';
import { REASON, TransportError } from './errors.js';
import { HOST, SOCKET_PATHS, pickSocket } from './localapi.js';

// Promisified once, at module scope, because gnome-shell caches ESM modules for
// the life of the session — so this runs exactly once however many times the
// extension is enabled. The extension QuickTS replaces called _promisify inside
// its read loop, re-patching the prototype on every line of the stream.
Gio._promisify(Soup.Session.prototype, 'send_async', 'send_finish');
Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');
Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async', 'read_line_finish');
Gio._promisify(Gio.File.prototype, 'read_async', 'read_finish');
Gio._promisify(Gio.File.prototype, 'query_info_async', 'query_info_finish');

const decoder = new TextDecoder();
const encoder = new TextEncoder();

const JSON_TYPE = 'application/json';

/**
 * Translate a caught value into the vocabulary the rest of QuickTS reasons in.
 *
 * Gio reports cancellation as a GError rather than by any other means, so this
 * is also where a cancelled operation stops looking like a failure. Getting
 * that wrong would make every disable() log an error.
 *
 * @param {unknown} error Caught value.
 * @returns {Error} A CancelledError or a TransportError.
 */
function translate(error) {
    if (error?.name === 'CancelledError' || error?.name === 'TransportError')
        return error;

    if (error instanceof Gio.IOErrorEnum || typeof error?.matches === 'function') {
        if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            return new CancelledError();
        if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            return new TransportError(REASON.SOCKET_MISSING, `${error}`, {
                cause: error,
            });
        if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CONNECTION_REFUSED))
            return new TransportError(REASON.CONNECTION_REFUSED, `${error}`, {
                cause: error,
            });
        if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.PERMISSION_DENIED))
            return new TransportError(REASON.PERMISSION_DENIED, `${error}`, {
                cause: error,
            });
    }

    return new TransportError(REASON.UNKNOWN, `${error}`, { cause: error });
}

/**
 * Turn a non-2xx answer into an error carrying a reason.
 *
 * 403 is the interesting one: it is what tailscaled returns to a user who is
 * not the tailscale operator, and it is the single most common reason this
 * extension appears to do nothing at all.
 *
 * @param {Soup.Message} message Message that has been sent.
 * @returns {TransportError|null} An error, or null if the answer was usable.
 */
function statusError(message) {
    const status = message.get_status();
    if (status >= 200 && status < 300) return null;

    const reason =
        status === Soup.Status.FORBIDDEN || status === Soup.Status.UNAUTHORIZED
            ? REASON.PERMISSION_DENIED
            : REASON.HTTP;

    return new TransportError(reason, `HTTP ${status} ${message.get_reason_phrase()}`, {
        status,
    });
}

/**
 * Decode a response body according to what the daemon said it is.
 *
 * @param {Soup.Message} message Message that has been sent.
 * @param {Uint8Array} bytes Raw body.
 * @returns {unknown} Parsed JSON, or the text.
 */
function decode(message, bytes) {
    const text = decoder.decode(bytes);
    if (message.response_headers.get_one('Content-Type') !== JSON_TYPE) return text;

    try {
        return JSON.parse(text);
    } catch (error) {
        throw new TransportError(REASON.PROTOCOL, `malformed JSON: ${error}`);
    }
}

/**
 * Build the transport for one enable/disable lifetime.
 *
 * Everything it returns is bound to `token`. Cancelling the token aborts every
 * request in flight, settles every pending wait, and drops every GLib source —
 * see the note on delay() for why the last two must happen together.
 *
 * @param {object} options Options.
 * @param {import('./cancel.js').CancelToken} options.token Lifetime of this transport.
 * @returns {object} The client, the scheduler, and a dispose().
 */
export function createIo({ token }) {
    const socket = pickSocket(SOCKET_PATHS, path =>
        GLib.file_test(path, GLib.FileTest.EXISTS),
    );

    // One Cancellable for the lifetime, bridged from the token once. Every
    // async call below is handed it; none is ever handed null, which is what
    // left the previous extension unable to interrupt a request at all.
    const cancellable = new Gio.Cancellable();
    token.onCancel(() => cancellable.cancel());

    const session = socket
        ? new Soup.Session({
              // Every request goes to this socket regardless of the URL's host.
              'remote-connectable': new Gio.UnixSocketAddress({ path: socket }),
              // The IPN bus is a long poll that is idle most of the time.
              // Either timeout would tear it down on a quiet tailnet.
              timeout: 0,
              'idle-timeout': 0,
          })
        : null;

    /** Live GLib source ids, so dispose() can prove none outlived the token. */
    const sources = new Set();

    const url = path => `http://${HOST}${path}`;

    const ready = () => {
        if (!socket)
            throw new TransportError(
                REASON.SOCKET_MISSING,
                `no tailscaled socket at ${SOCKET_PATHS.join(' or ')}`,
            );
        token.throwIfCancelled();
    };

    const build = ({ method, path, body }) => {
        const message = Soup.Message.new(method, url(path));
        if (body !== undefined) {
            const bytes = encoder.encode(JSON.stringify(body));
            message.set_request_body_from_bytes(JSON_TYPE, new GLib.Bytes(bytes));
        }
        return message;
    };

    return {
        /** The socket in use, or null. Reported by scripts/localapi-check.sh. */
        socket,

        client: {
            /**
             * Send one request and read the whole answer.
             *
             * @param {{method: string, path: string, body?: unknown}} descriptor From modules/localapi.js.
             * @returns {Promise<unknown>} Parsed body.
             */
            async request(descriptor) {
                ready();
                const message = build(descriptor);

                try {
                    const bytes = await session.send_and_read_async(
                        message,
                        GLib.PRIORITY_DEFAULT,
                        cancellable,
                    );

                    const failure = statusError(message);
                    if (failure) throw failure;

                    return decode(message, bytes.get_data() ?? new Uint8Array());
                } catch (error) {
                    throw translate(error);
                }
            },

            /**
             * Open a newline-delimited stream and yield its lines.
             *
             * @param {{method: string, path: string}} descriptor From modules/localapi.js.
             * @yields {string} One line, without its terminator.
             */
            async *stream(descriptor) {
                ready();
                const message = build(descriptor);

                let input;
                try {
                    input = await session.send_async(
                        message,
                        GLib.PRIORITY_DEFAULT,
                        cancellable,
                    );

                    const failure = statusError(message);
                    if (failure) throw failure;
                } catch (error) {
                    throw translate(error);
                }

                const lines = new Gio.DataInputStream({ base_stream: input });
                try {
                    for (;;) {
                        const [bytes, length] = await lines.read_line_async(
                            GLib.PRIORITY_DEFAULT,
                            cancellable,
                        );

                        // null is end of stream; zero length is a blank line,
                        // which the bus sends as a keep-alive.
                        if (bytes === null) return;
                        if (length === 0) continue;

                        yield decoder.decode(bytes);
                    }
                } catch (error) {
                    throw translate(error);
                } finally {
                    // Deliberately null, not `cancellable`. By the time this
                    // runs during a disable the cancellable is already
                    // cancelled, and g_input_stream_close on a cancelled
                    // cancellable fails immediately — throwing out of a finally
                    // block, which would replace the real error with a bogus
                    // one and skip the rest of teardown.
                    try {
                        lines.close(null);
                    } catch {
                        // Closing a stream that is already gone is not a fault.
                    }
                }
            },

            /**
             * Send a file as a request body, without reading it into memory.
             *
             * Soup takes the GInputStream and the length and pumps it itself,
             * so a multi-gigabyte Taildrop transfer costs a buffer, not a copy
             * of the file on the JS heap.
             *
             * @param {{method: string, path: string}} descriptor From modules/localapi.js.
             * @param {string} uri file:// URI to send.
             * @returns {Promise<void>} Resolves once the daemon has accepted it.
             */
            async putFile(descriptor, uri) {
                ready();

                try {
                    const file = Gio.File.new_for_uri(uri);
                    const info = await file.query_info_async(
                        'standard::size',
                        Gio.FileQueryInfoFlags.NONE,
                        GLib.PRIORITY_DEFAULT,
                        cancellable,
                    );
                    const input = await file.read_async(
                        GLib.PRIORITY_DEFAULT,
                        cancellable,
                    );

                    const message = Soup.Message.new(
                        descriptor.method,
                        url(descriptor.path),
                    );
                    message.set_request_body(
                        'application/octet-stream',
                        input,
                        info.get_size(),
                    );

                    await session.send_and_read_async(
                        message,
                        GLib.PRIORITY_DEFAULT,
                        cancellable,
                    );

                    const failure = statusError(message);
                    if (failure) throw failure;
                } catch (error) {
                    throw translate(error);
                }
            },
        },

        scheduler: {
            /**
             * Wait, unless the token is cancelled first.
             *
             * Cancelling removes the source *and* rejects the promise, in one
             * callback. That pairing is the entire point. The extension QuickTS
             * replaces removes the source from somewhere else entirely, so the
             * timeout callback never runs, the promise never settles, and the
             * reconnect loop awaiting it is stranded for the life of the Shell.
             *
             * @param {number} ms Milliseconds to wait.
             * @returns {Promise<void>} Resolves after the wait, rejects on cancel.
             */
            delay(ms) {
                return new Promise((resolve, reject) => {
                    if (token.cancelled) {
                        reject(new CancelledError());
                        return;
                    }

                    let off = () => {};
                    const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                        sources.delete(id);
                        off();
                        resolve();
                        return GLib.SOURCE_REMOVE;
                    });
                    sources.add(id);

                    off = token.onCancel(() => {
                        if (sources.delete(id)) GLib.Source.remove(id);
                        reject(new CancelledError());
                    });
                });
            },
        },

        /**
         * Release everything.
         *
         * The token is expected to have been cancelled already, which is what
         * drains `sources`; the check below is a self-audit, and it is exactly
         * the assertion the replaced extension would fail.
         */
        dispose() {
            if (sources.size > 0) {
                console.warn(`[quickts] ${sources.size} timer(s) outlived the token`);
                for (const id of sources) GLib.Source.remove(id);
                sources.clear();
            }

            session?.abort();
        },
    };
}
