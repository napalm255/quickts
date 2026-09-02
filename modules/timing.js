// When to retry, and when to stop coalescing.
//
// This file imports nothing and starts no timers. Both exports are functions
// of their arguments: they say *how long* to wait, and the caller — which owns
// a real clock — does the waiting. That is what makes the retry schedule and
// the coalescing window assertable as exact numbers in Vitest, with no fake
// timers and no sleeping test suite.

/** First retry delay, in milliseconds. */
export const BACKOFF_BASE = 1000;

/** Longest retry delay, in milliseconds. */
export const BACKOFF_CAP = 30000;

/** Quiet period before a burst of change signals is acted on, in milliseconds. */
export const FLUSH_WAIT = 400;

/** Longest a steady stream of signals may postpone a flush, in milliseconds. */
export const FLUSH_MAX_WAIT = 1500;

/**
 * How long to wait before retrying a failed connection.
 *
 * Exponential with equal jitter: half the ceiling, plus a random half. The
 * jitter is not about thundering herds — there is one client and one local
 * socket — but about not settling into lockstep with whatever is restarting
 * tailscaled, which is the common reason the stream drops at all.
 *
 * `random` is injected so the schedule is a fixed sequence under test.
 *
 * @param {number} attempt Consecutive failures so far; 0 for the first retry.
 * @param {object} [options] Options.
 * @param {number} [options.base] First delay.
 * @param {number} [options.cap] Ceiling, which the exponent stops growing past.
 * @param {() => number} [options.random] Source of jitter in [0, 1).
 * @returns {number} Milliseconds to wait, always at least base / 2.
 */
export function backoffDelay(
    attempt,
    { base = BACKOFF_BASE, cap = BACKOFF_CAP, random = Math.random } = {},
) {
    // Clamped before the shift. 2 ** 1024 is Infinity, and a daemon that has
    // been down for a week would get there; Infinity * 0.5 is still Infinity,
    // and GLib.timeout_add of that is not a wait, it is a hang.
    const exponent = Math.min(Math.max(attempt, 0), 31);
    const ceiling = Math.min(cap, base * 2 ** exponent);

    return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

/**
 * How long to wait before acting on the change signals seen so far.
 *
 * A trailing debounce with a ceiling. Signals arrive in bursts — bringing the
 * tailnet up produces a run of them — and acting on each one would mean a
 * status read per signal. Waiting for quiet coalesces the burst; the ceiling
 * stops a daemon that never goes quiet from postponing the flush forever,
 * which is the failure mode a plain debounce has.
 *
 * @param {object} signals Timestamps, on any single monotonic scale.
 * @param {number} signals.firstSignalAt When the current burst began.
 * @param {number} signals.lastSignalAt When the most recent signal arrived.
 * @param {number} signals.now Current time.
 * @param {number} [signals.wait] Quiet period required.
 * @param {number} [signals.maxWait] Longest the burst may postpone the flush.
 * @returns {number} Milliseconds to wait; 0 means flush now.
 */
export function flushDelay({
    firstSignalAt,
    lastSignalAt,
    now,
    wait = FLUSH_WAIT,
    maxWait = FLUSH_MAX_WAIT,
}) {
    const quietAt = lastSignalAt + wait;
    const ceilingAt = firstSignalAt + maxWait;

    return Math.max(0, Math.min(quietAt, ceilingAt) - now);
}
