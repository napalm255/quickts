// Everything QuickTS knows, and everything it can be asked to do.
//
// Deliberately NOT a GObject. That is the single largest departure from the
// extension QuickTS replaces, and it retires two classes of defect outright:
//
//   There are no GObject properties, so there are no notify:: connections and
//   no bind_property bindings for the menu to leak. There is one subscribe()
//   per widget, each returning its own disposer, and modules/panel.js drains
//   them in a flat array. Upstream connects a dozen handlers and binds two
//   properties and disconnects none of them.
//
//   Subscribers receive a whole consistent snapshot plus a list of what moved,
//   so there is no per-property emission order to get wrong. Upstream emits
//   notify::exit-node before computing the name that depends on it.
//
// It also means the whole thing runs under Vitest with no stubs at all: the
// client and the clock are injected, and neither has a GNOME type in it.
//
// This file imports only other pure modules.

import { NOTHING_DIRTY, dirtyFrom, isDirty, mergeDirty, parseBusLine } from './bus.js';
import { isCancelled } from './cancel.js';
import { messageFor, reasonOf } from './errors.js';
import {
    currentProfileRequest,
    filePutRequest,
    fileTargetsRequest,
    loginRequest,
    logoutRequest,
    patchPrefsRequest,
    pingRequest,
    prefsRequest,
    profilesRequest,
    statusRequest,
    switchProfileRequest,
    watchBusRequest,
} from './localapi.js';
import { runWithReconnect } from './reconnect.js';
import {
    applyError,
    applyPrefs,
    applyProfiles,
    applyStatus,
    changed,
    initialState,
} from './state.js';
import { PING_TYPE, describePing } from './ping.js';
import { fileNameOf } from './taildrop.js';
import { backoffDelay, flushDelay } from './timing.js';

/** How long a peer list may go unread while the menu is closed. */
export const PEERS_STALE_MS = 60000;

/** The store. One per enable/disable lifetime. */
export class TailscaleModel {
    #client;
    #scheduler;
    #token;
    #now;

    #state = initialState();
    #subscribers = new Set();
    #disposed = false;

    #dirty = NOTHING_DIRTY;
    #firstSignalAt = 0;
    #lastSignalAt = 0;
    #flushing = false;

    /** Peers changed but were not read, because nobody was looking. */
    #peersPending = false;
    #peersReadAt = 0;
    #menuOpen = false;

    /**
     * @param {object} options Options.
     * @param {object} options.client Transport, from modules/io.js.
     * @param {{delay: (ms: number) => Promise<void>}} options.scheduler Clock.
     * @param {import('./cancel.js').CancelToken} options.token Lifetime.
     * @param {() => number} [options.now] Clock reading, injected for tests.
     */
    constructor({ client, scheduler, token, now = Date.now }) {
        this.#client = client;
        this.#scheduler = scheduler;
        this.#token = token;
        this.#now = now;
    }

    /** @returns {object} The current immutable snapshot. */
    get state() {
        return this.#state;
    }

    /** @returns {number} Live subscribers. Lets a test prove the menu unhooked. */
    get subscriberCount() {
        return this.#subscribers.size;
    }

    /**
     * Watch the state.
     *
     * @param {(state: object, changed: string[]) => void} listener Called on every change.
     * @returns {() => void} Unsubscribes. Safe to call more than once.
     */
    subscribe(listener) {
        if (this.#disposed) return () => {};

        this.#subscribers.add(listener);
        return () => this.#subscribers.delete(listener);
    }

    /**
     * Tell the model whether anyone is looking.
     *
     * The refresh policy turns on this. A netmap update while the menu is shut
     * sets a flag; the full peer read happens when the menu opens, which is
     * the only moment the answer is on screen.
     *
     * @param {boolean} open Whether the menu is open.
     */
    setMenuOpen(open) {
        this.#menuOpen = Boolean(open);
        if (open && this.#peersPending) void this.refresh({ peers: true });
    }

    /** Read everything, then follow the bus until the token is cancelled. */
    async start() {
        await this.refresh({ peers: true, profiles: true });
        void this.#watch();
    }

    /** Drop every subscriber and refuse all further work. */
    destroy() {
        this.#disposed = true;
        this.#subscribers.clear();
    }

    // ---- reads ------------------------------------------------------------

    /**
     * Re-read the daemon.
     *
     * @param {object} [what] What to read.
     * @param {boolean} [what.peers] Include the peer map, which is the costly part.
     * @param {boolean} [what.prefs] Re-read preferences.
     * @param {boolean} [what.status] Re-read status.
     * @param {boolean} [what.profiles] Re-read the profile list.
     * @returns {Promise<void>} Resolves once the state has been updated.
     */
    async refresh({
        peers = false,
        prefs = true,
        status = true,
        profiles = false,
    } = {}) {
        if (this.#disposed) return;

        try {
            if (prefs)
                this.#commit(
                    applyPrefs(this.#state, await this.#request(prefsRequest())),
                );

            if (status) {
                const response = await this.#request(statusRequest({ peers }));
                this.#commit(applyStatus(this.#state, response));

                if (peers) {
                    this.#peersPending = false;
                    this.#peersReadAt = this.#now();
                }
            }

            if (profiles) {
                const list = await this.#request(profilesRequest());
                const current = await this.#request(currentProfileRequest());
                this.#commit(applyProfiles(this.#state, list, current));
            }
        } catch (error) {
            this.#fail(error);
        }
    }

    /**
     * Send files to a peer, one at a time.
     *
     * Sequentially, not in parallel: a peer does not enjoy N concurrent PUTs,
     * and reporting which of five files failed is far clearer when they went
     * one at a time.
     *
     * @param {string} stableId Target node id.
     * @param {string[]} uris file:// URIs to send.
     * @returns {Promise<{sent: number, failed: string[]}>} What happened.
     */
    async sendFiles(stableId, uris) {
        const result = { sent: 0, failed: [] };
        if (this.#disposed) return result;

        for (const uri of uris ?? []) {
            if (this.#disposed) break;

            // fileNameOf decodes percent escapes, which throws URIError on a
            // malformed one. Outside the try that would escape sendFiles and
            // become an unhandled rejection rather than a reported failure.
            let name = uri;
            try {
                name = fileNameOf(uri);
                await this.#client.putFile(filePutRequest(stableId, name), uri);
                result.sent += 1;
            } catch (error) {
                if (isCancelled(error)) break;
                result.failed.push(name);
            }
        }

        return result;
    }

    /**
     * Ping a peer through the daemon.
     *
     * A disco ping, because it reports the route as well as the round trip,
     * and "is this going direct or through a relay" is usually the real
     * question behind pinging a machine on a tailnet.
     *
     * @param {string} ip A Tailscale address of the peer.
     * @returns {Promise<object>} The result, from modules/ping.js.
     */
    async ping(ip) {
        if (this.#disposed || !ip) return describePing(null);

        try {
            return describePing(await this.#request(pingRequest(ip, PING_TYPE.DISCO)));
        } catch (error) {
            if (isCancelled(error)) return describePing(null);

            // Deliberately not routed through #fail. A peer that will not
            // answer is a fact about that peer, not evidence that the daemon
            // has become unreachable, and marking the whole extension
            // unreachable over one dead node would be wrong.
            return { ...describePing(null), error: messageFor(reasonOf(error)) };
        }
    }

    /** @returns {Promise<object[]>} Peers eligible to receive a file right now. */
    async fileTargets() {
        if (this.#disposed) return [];

        try {
            const targets = await this.#request(fileTargetsRequest());
            return Array.isArray(targets) ? targets : [];
        } catch (error) {
            this.#fail(error);
            return [];
        }
    }

    // ---- commands ---------------------------------------------------------

    /** @param {boolean} value Whether the tailnet should be up. @returns {Promise<void>} Done. */
    setRunning(value) {
        return this.#patch({ WantRunning: Boolean(value) });
    }

    /** @param {boolean} value Accept subnet routes. @returns {Promise<void>} Done. */
    setAcceptRoutes(value) {
        return this.#patch({ RouteAll: Boolean(value) });
    }

    /** @param {boolean} value Use the tailnet's DNS. @returns {Promise<void>} Done. */
    setAcceptDNS(value) {
        return this.#patch({ CorpDNS: Boolean(value) });
    }

    /** @param {boolean} value Reach the LAN while using an exit node. @returns {Promise<void>} Done. */
    setAllowLanAccess(value) {
        return this.#patch({ ExitNodeAllowLANAccess: Boolean(value) });
    }

    /** @param {boolean} value Block incoming connections. @returns {Promise<void>} Done. */
    setShieldsUp(value) {
        return this.#patch({ ShieldsUp: Boolean(value) });
    }

    /** @param {boolean} value Run the Tailscale SSH server. @returns {Promise<void>} Done. */
    setSsh(value) {
        return this.#patch({ RunSSH: Boolean(value) });
    }

    /**
     * Route through a peer, or stop doing so.
     *
     * @param {string} id Node id, or '' to use no exit node.
     * @returns {Promise<void>} Done.
     */
    setExitNode(id) {
        return this.#patch({ ExitNodeID: id ?? '' });
    }

    /**
     * Switch to another profile, then re-read everything it changed.
     *
     * @param {string} id Profile id.
     * @returns {Promise<void>} Done.
     */
    async switchProfile(id) {
        if (this.#disposed) return;

        try {
            await this.#request(switchProfileRequest(id));
        } catch (error) {
            this.#fail(error);
            return;
        }

        // A profile switch replaces the tailnet, the peers and every
        // preference, so nothing already on screen survives it.
        await this.refresh({ peers: true, profiles: true });
    }

    /** @returns {Promise<void>} Begins an interactive login. */
    async login() {
        if (this.#disposed) return;

        try {
            await this.#request(loginRequest());
        } catch (error) {
            this.#fail(error);
            return;
        }

        // The URL to visit arrives on the next status read, or over the bus as
        // BrowseToURL, whichever gets there first.
        await this.refresh({ prefs: false });
    }

    /** @returns {Promise<void>} Logs out of the current profile. */
    async logout() {
        if (this.#disposed) return;

        try {
            await this.#request(logoutRequest());
        } catch (error) {
            this.#fail(error);
            return;
        }

        await this.refresh({ peers: true });
    }

    // ---- internals --------------------------------------------------------

    /**
     * @param {object} descriptor Request descriptor.
     * @returns {Promise<unknown>} Parsed response.
     */
    #request(descriptor) {
        return this.#client.request(descriptor);
    }

    /**
     * Apply a preference change and adopt the answer.
     *
     * The daemon replies with the resulting preferences, so the menu updates
     * from the authoritative value rather than from what was asked for. That
     * is also why a user-initiated change has no bus latency: the round trip
     * that applies it is the same one that reports it.
     *
     * @param {Record<string, unknown>} changes Preferences to set.
     * @returns {Promise<void>} Done.
     */
    async #patch(changes) {
        if (this.#disposed) return;

        try {
            const prefs = await this.#request(patchPrefsRequest(changes));
            this.#commit(applyPrefs(this.#state, prefs));
        } catch (error) {
            this.#fail(error);
        }
    }

    /** Follow the IPN bus until the token is cancelled. */
    #watch() {
        return runWithReconnect({
            token: this.#token,
            connect: () => this.#client.stream(watchBusRequest()),
            onEvent: line => this.#onBusLine(line),
            onError: error => this.#fail(error),
            delay: ms => this.#scheduler.delay(ms),
            backoff: attempt => backoffDelay(attempt),
        });
    }

    /**
     * Note that something changed. Never reads a value out of the line.
     *
     * @param {string} line One raw line from the bus.
     */
    #onBusLine(line) {
        if (this.#disposed) return;

        const parsed = parseBusLine(line);
        if (!parsed.ok) return;

        const dirty = dirtyFrom(parsed.notify);
        if (!isDirty(dirty)) return;

        this.#dirty = mergeDirty(this.#dirty, dirty);
        this.#lastSignalAt = this.#now();
        if (this.#firstSignalAt === 0) this.#firstSignalAt = this.#lastSignalAt;

        void this.#flushSoon();
    }

    /** Wait out the burst, then read once for all of it. */
    async #flushSoon() {
        if (this.#flushing || this.#disposed) return;
        this.#flushing = true;

        try {
            // The outer loop is not decoration. Signals that arrive while the
            // read below is in flight are recorded by #onBusLine but cannot
            // start a flush of their own, because #flushing is still set — so
            // without coming back round they would sit in #dirty until some
            // later, unrelated notification happened to carry them out. On a
            // quiet tailnet that is indefinitely, and the menu shows a value
            // the daemon stopped reporting minutes ago.
            while (!this.#disposed && isDirty(this.#dirty)) {
                // Re-checked rather than waited once, because more signals
                // arrive during the wait and each one pushes the quiet period
                // out — up to the ceiling flushDelay enforces.
                for (;;) {
                    const wait = flushDelay({
                        firstSignalAt: this.#firstSignalAt,
                        lastSignalAt: this.#lastSignalAt,
                        now: this.#now(),
                    });
                    if (wait <= 0) break;

                    await this.#scheduler.delay(wait);
                    if (this.#disposed) return;
                }

                const dirty = this.#dirty;
                this.#dirty = NOTHING_DIRTY;
                this.#firstSignalAt = 0;

                await this.#read(dirty);
            }
        } catch (error) {
            if (!isCancelled(error)) this.#fail(error);
        } finally {
            this.#flushing = false;
        }
    }

    /**
     * Read exactly what the accumulated signals made necessary.
     *
     * The peer map is the expensive part of a status read, and on a large
     * tailnet it is most of the payload. It is fetched when someone is looking
     * at it, when it has gone stale, or when the exit node moved — because the
     * subtitle names the exit node and cannot resolve a peer it has not read.
     *
     * @param {object} dirty Accumulated flags from modules/bus.js.
     * @returns {Promise<void>} Done.
     */
    async #read(dirty) {
        if (this.#disposed || !isDirty(dirty)) return;

        const stale = this.#now() - this.#peersReadAt > PEERS_STALE_MS;
        const wantPeers = dirty.peers && (this.#menuOpen || stale);

        // Remembered rather than dropped, so opening the menu picks it up.
        if (dirty.peers && !wantPeers) this.#peersPending = true;

        await this.refresh({
            prefs: dirty.prefs,
            status: dirty.state || dirty.health || dirty.peers,
            peers: wantPeers,
        });
    }

    /**
     * Publish a new snapshot, if it differs.
     *
     * @param {object} next The state to adopt.
     */
    #commit(next) {
        if (this.#disposed) return;

        const fields = changed(this.#state, next);
        this.#state = next;
        if (fields.length === 0) return;

        // Copied before iterating: a subscriber may unsubscribe in response,
        // and mutating the set mid-iteration would skip the one after it.
        for (const listener of [...this.#subscribers]) {
            try {
                listener(next, fields);
            } catch (error) {
                // One bad widget must not stop the others being told.
                console.warn(`[quickts] subscriber failed: ${error}`);
            }
        }
    }

    /**
     * Record a failed request.
     *
     * A cancellation is teardown, not a fault; reporting it would make every
     * disable() draw an error into the menu on the way out.
     *
     * @param {unknown} error Caught value.
     */
    #fail(error) {
        if (this.#disposed || isCancelled(error)) return;

        this.#commit(applyError(this.#state, reasonOf(error)));
    }
}
