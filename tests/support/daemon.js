// A fake tailscaled, good enough to drive modules/model.js.
//
// This is the whole of what the model needs injected: four client methods and
// a delay. There is no GNOME type anywhere in it, which is why the model — the
// reconnect loop, the refresh policy and the failure handling included — runs
// under Vitest with no stubs at all.

import { CancelToken, CancelledError } from '../../modules/cancel.js';
import { SUFFIX, rawPeer, rawPeerMap } from '../fixtures/peers.js';

/**
 * Build a fake client whose answers a test can set.
 *
 * @param {object} [seed] Starting responses.
 * @returns {object} The client, plus the recording around it.
 */
export function createDaemon(seed = {}) {
    const responses = {
        status: {
            BackendState: 'Running',
            AuthURL: '',
            Health: [],
            MagicDNSSuffix: SUFFIX,
            CurrentTailnet: { Name: 'example@example.com' },
            Self: { HostName: 'desktop', TailscaleIPs: ['100.64.0.9'] },
            Peer: rawPeerMap(rawPeer()),
        },
        prefs: {
            WantRunning: true,
            RouteAll: false,
            CorpDNS: true,
            ExitNodeAllowLANAccess: false,
            ShieldsUp: false,
            RunSSH: false,
            ExitNodeID: '',
        },
        profiles: [
            { ID: '1', Name: 'work', NetworkProfile: { DisplayName: 'WorkNet' } },
        ],
        current: { ID: '1' },
        fileTargets: [],
        ping: { Err: '', LatencySeconds: 0.001, Endpoint: '10.0.0.1:41641' },
        ...seed,
    };

    /** Every path requested, in order. */
    const paths = [];
    /** Bodies of every PATCH, in order. */
    const patches = [];
    /** Paths the daemon should reject, mapped to the error to throw. */
    const failures = new Map();

    let streamController = null;

    const client = {
        async request({ method, path, body }) {
            paths.push(path);
            if (method === 'PATCH') patches.push(body);

            const failure = [...failures.entries()].find(([prefix]) =>
                path.startsWith(prefix),
            );
            if (failure) throw failure[1];

            if (path.startsWith('/localapi/v0/prefs')) {
                // The daemon answers a PATCH with the resulting preferences,
                // which is what lets a user-initiated change skip the bus.
                if (method === 'PATCH') Object.assign(responses.prefs, stripMask(body));
                return { ...responses.prefs };
            }
            if (path.startsWith('/localapi/v0/status'))
                return path.includes('peers=false')
                    ? { ...responses.status, Peer: null }
                    : { ...responses.status };
            if (path.startsWith('/localapi/v0/profiles/current'))
                return responses.current;
            if (path.startsWith('/localapi/v0/profiles')) return responses.profiles;
            if (path.startsWith('/localapi/v0/file-targets'))
                return responses.fileTargets;
            if (path.startsWith('/localapi/v0/ping')) return responses.ping;

            return {};
        },

        async *stream({ path }) {
            paths.push(path);

            const queue = [];
            let wake = null;
            let ended = false;

            streamController = {
                push(line) {
                    queue.push(line);
                    wake?.();
                },
                end() {
                    ended = true;
                    wake?.();
                },
            };

            for (;;) {
                if (queue.length > 0) {
                    yield queue.shift();
                    continue;
                }
                if (ended) return;
                await new Promise(resolve => {
                    wake = resolve;
                });
            }
        },
    };

    return {
        client,
        responses,
        paths,
        patches,
        failures,
        token: new CancelToken(),

        /** Send one line down the open bus. */
        emit(notify) {
            streamController?.push(JSON.stringify(notify));
        },

        /** Close the open bus. */
        endStream() {
            streamController?.end();
        },

        /** Paths matching a fragment, for asserting what was and was not read. */
        pathsMatching(fragment) {
            return paths.filter(path => path.includes(fragment));
        },

        reset() {
            paths.length = 0;
            patches.length = 0;
        },
    };
}

/**
 * Drop the `<Name>Set` mask fields, leaving the values a real daemon would keep.
 *
 * @param {object} body A MaskedPrefs body.
 * @returns {object} Just the preference values.
 */
function stripMask(body) {
    return Object.fromEntries(
        Object.entries(body ?? {}).filter(([key]) => !key.endsWith('Set')),
    );
}

/**
 * A scheduler that records waits instead of performing them.
 *
 * It must still move the clock. A delay that records the duration but leaves
 * the time alone is not a fast delay, it is a stopped one: modules/model.js
 * re-checks flushDelay after each wait precisely because more signals may have
 * arrived, and against a frozen clock that re-check never converges.
 *
 * @param {import('../../modules/cancel.js').CancelToken} token Lifetime.
 * @param {{advance: (ms: number) => void}} clock Clock to move.
 * @returns {object} The scheduler and its record.
 */
export function createScheduler(token, clock) {
    const waits = [];

    return {
        waits,
        scheduler: {
            delay(ms) {
                waits.push(ms);
                if (token.cancelled) return Promise.reject(new CancelledError());

                clock.advance(ms);

                // Resolved on a macrotask, not a microtask. A real delay
                // yields to the event loop, which is what lets the bus lines
                // already queued behind it be delivered before the wait ends —
                // resolving immediately would let a flush fire between two
                // lines of the same burst and make coalescing untestable.
                return new Promise(resolve => setTimeout(resolve, 0));
            },
        },
    };
}

/** A clock a test can move. */
export function createClock(start = 1_000_000) {
    let time = start;

    return {
        now: () => time,
        advance(ms) {
            time += ms;
        },
    };
}
