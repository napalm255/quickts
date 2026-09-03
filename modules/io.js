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
import { uniqueName } from './inbox.js';
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
Gio._promisify(
    Gio.File.prototype,
    'replace_contents_bytes_async',
    'replace_contents_finish',
);

const decoder = new TextDecoder();
const encoder = new TextEncoder();

const JSON_TYPE = 'application/json';

const PORTAL_BUS = 'org.freedesktop.portal.Desktop';
const PORTAL_PATH = '/org/freedesktop/portal/desktop';
const FILE_CHOOSER = 'org.freedesktop.portal.FileChooser';
const REQUEST = 'org.freedesktop.portal.Request';

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
            return transportError(REASON.SOCKET_MISSING, error);
        if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CONNECTION_REFUSED))
            return transportError(REASON.CONNECTION_REFUSED, error);
        if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.PERMISSION_DENIED))
            return transportError(REASON.PERMISSION_DENIED, error);
    }

    return transportError(REASON.UNKNOWN, error);
}

/**
 * Wrap a caught value, keeping something readable in the message.
 *
 * Interpolating the value directly renders a plain object as "[object Object]",
 * which is the least useful thing that could reach the journal at the moment
 * something has gone wrong. A GError carries a real message; anything else
 * falls back to its own String() form.
 *
 * @param {string} reason One of REASON.
 * @param {unknown} error The caught value, kept as the cause.
 * @returns {TransportError} The wrapped error.
 */
function transportError(reason, error) {
    const text = error?.message ?? String(error);

    return new TransportError(reason, text, { cause: error });
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

    // Prefix, not equality: a Content-Type may carry parameters, and
    // "application/json; charset=utf-8" compared for equality would make every
    // response decode as a raw string. The reducer would then read undefined
    // off it everywhere and the menu would go blank while still reporting
    // itself reachable, with nothing logged.
    const contentType = message.response_headers.get_one('Content-Type') ?? '';
    if (!contentType.split(';', 1)[0].trim().startsWith(JSON_TYPE)) return text;

    try {
        return JSON.parse(text);
    } catch (error) {
        throw new TransportError(REASON.PROTOCOL, `malformed JSON: ${error}`);
    }
}

/**
 * Withdraw a portal request.
 *
 * Extracted so the cancellation handler is not a callback inside a callback
 * inside a callback — the reply is discarded, so there is nothing here the
 * caller needs to see.
 *
 * @param {object} bus The session bus.
 * @param {string} handle The request object path the portal returned.
 */
function closeRequest(bus, handle) {
    bus.call(
        PORTAL_BUS,
        handle,
        REQUEST,
        'Close',
        null,
        null,
        Gio.DBusCallFlags.NONE,
        -1,
        null,
        () => {},
    );
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

        /**
         * Ask the user for files, through the desktop portal.
         *
         * The portal is not a preference here. The review guidelines forbid
         * importing Gtk or Adw into the gnome-shell process, so a file dialog
         * cannot be built in-process at all; the portal draws it in
         * xdg-desktop-portal-gnome instead and hands back URIs.
         *
         * Two details the portal documents and this depends on. The response
         * arrives as a signal on a request object whose path is derived from
         * the caller's unique bus name and a token we choose, and it must be
         * subscribed to BEFORE the call — otherwise a portal that answers
         * immediately answers into nothing. And parent_window is the empty
         * string, because the Shell has no toplevel to parent to.
         *
         * @param {object} [options] Options.
         * @param {string} [options.title] Dialog title.
         * @param {boolean} [options.multiple] Allow more than one file.
         * @returns {Promise<string[]>} Chosen file:// URIs; empty if cancelled.
         */
        chooseFiles({ title = 'Select files', multiple = true } = {}) {
            return new Promise((resolve, reject) => {
                if (token.cancelled) {
                    reject(new CancelledError());
                    return;
                }

                const bus = Gio.DBus.session;
                const sender = bus.get_unique_name().slice(1).replaceAll('.', '_');
                // Not Math.random(). The request path is already namespaced by
                // our own unique bus name and the response is filtered on the
                // portal as sender, so a guessable token is not exploitable
                // here — but a predictable identifier in a security-adjacent
                // path is a poor precedent and a UUID costs nothing.
                //
                // The hyphens have to go: the token becomes the last element
                // of a D-Bus object path, and those admit only [A-Za-z0-9_].
                const handleToken = `quickts_${GLib.uuid_string_random().replaceAll('-', '')}`;
                const requestPath = `${PORTAL_PATH}/request/${sender}/${handleToken}`;

                let offCancel = () => {};
                let subscription = 0;
                const finish = value => {
                    if (subscription) bus.signal_unsubscribe(subscription);
                    subscription = 0;
                    offCancel();
                    resolve(value);
                };

                subscription = bus.signal_subscribe(
                    PORTAL_BUS,
                    REQUEST,
                    'Response',
                    requestPath,
                    null,
                    Gio.DBusSignalFlags.NONE,
                    (_connection, _sender, _path, _iface, _signal, params) => {
                        const [code, results] = params.deepUnpack();

                        // Any non-zero code is the user declining or the
                        // portal giving up. Neither is an error worth
                        // reporting; it just means no files.
                        finish(code === 0 ? (results?.uris?.deepUnpack?.() ?? []) : []);
                    },
                );

                bus.call(
                    PORTAL_BUS,
                    PORTAL_PATH,
                    FILE_CHOOSER,
                    'OpenFile',
                    new GLib.Variant('(ssa{sv})', [
                        '',
                        title,
                        {
                            handle_token: new GLib.Variant('s', handleToken),
                            multiple: new GLib.Variant('b', multiple),
                            modal: new GLib.Variant('b', false),
                        },
                    ]),
                    new GLib.VariantType('(o)'),
                    Gio.DBusCallFlags.NONE,
                    -1,
                    cancellable,
                    (source, result) => {
                        let handle;
                        try {
                            [handle] = source.call_finish(result).deepUnpack();
                        } catch (error) {
                            if (subscription) bus.signal_unsubscribe(subscription);
                            subscription = 0;
                            offCancel();
                            reject(translate(error));
                            return;
                        }

                        // A disable while the dialog is open must take the
                        // dialog with it, rather than leaving it on screen
                        // answering to nothing.
                        offCancel = token.onCancel(() => {
                            closeRequest(bus, handle);
                            finish([]);
                        });
                    },
                );
            });
        },

        /**
         * Fetch a file the daemon is holding and write it to disk.
         *
         * The download directory rather than a chooser: a file that has
         * already been accepted onto this machine does not need a second
         * dialog, and this is where `tailscale file get` and every browser
         * put things.
         *
         * Written before the caller deletes it from the daemon. The reverse
         * order loses the file if the write fails.
         *
         * @param {{method: string, path: string}} descriptor From modules/localapi.js.
         * @param {string} name The name as sent.
         * @returns {Promise<string>} The path written.
         */
        async saveFile(descriptor, name) {
            ready();

            try {
                const message = build(descriptor);
                const bytes = await session.send_and_read_async(
                    message,
                    GLib.PRIORITY_DEFAULT,
                    cancellable,
                );

                const failure = statusError(message);
                if (failure) throw failure;

                const directory =
                    GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD) ??
                    GLib.get_home_dir();

                // Two people can both send "report.pdf"; a save that
                // overwrites is a save that loses data.
                const unique = uniqueName(name, candidate =>
                    GLib.file_test(
                        GLib.build_filenamev([directory, candidate]),
                        GLib.FileTest.EXISTS,
                    ),
                );

                const path = GLib.build_filenamev([directory, unique]);
                await Gio.File.new_for_path(path).replace_contents_bytes_async(
                    bytes,
                    null,
                    false,
                    Gio.FileCreateFlags.NONE,
                    cancellable,
                );

                return path;
            } catch (error) {
                throw translate(error);
            }
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
