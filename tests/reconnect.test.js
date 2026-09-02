import { describe, expect, it, vi } from 'vitest';

import { CancelToken, CancelledError } from '../modules/cancel.js';
import { runWithReconnect } from '../modules/reconnect.js';

/**
 * A harness that records the delays asked for rather than sleeping.
 *
 * @param {object} options Options.
 * @param {Array<Function>} options.streams One factory per connection attempt.
 * @param {number} [options.stopAfter] Reject the delay after this many waits,
 *   which is how a test ends a loop that would otherwise run forever.
 * @returns {object} The harness.
 */
function harness({ streams, stopAfter = Infinity }) {
    const token = new CancelToken();
    const delays = [];
    const events = [];
    const errors = [];
    let connects = 0;

    return {
        token,
        delays,
        events,
        errors,
        get connects() {
            return connects;
        },
        run() {
            return runWithReconnect({
                token,
                connect: () => {
                    const make = streams.at(connects) ?? streams.at(-1);
                    connects += 1;
                    return make();
                },
                onEvent: event => events.push(event),
                onError: error => errors.push(error),
                delay: ms => {
                    delays.push(ms);
                    if (delays.length >= stopAfter) {
                        token.cancel();
                        return Promise.reject(new CancelledError());
                    }
                    return Promise.resolve();
                },
                // Identity, so the assertions read as attempt numbers.
                backoff: attempt => attempt,
            });
        },
    };
}

const yields = (...values) =>
    async function* () {
        for (const value of values) yield value;
    };

const throws = error =>
    async function* () {
        throw error;
        // eslint-disable-next-line no-unreachable
        yield '';
    };

describe('runWithReconnect', () => {
    it('delivers every event', async () => {
        const h = harness({ streams: [yields('a', 'b', 'c')], stopAfter: 1 });
        await h.run();

        expect(h.events).toEqual(['a', 'b', 'c']);
    });

    // Upstream breaks out of its loop from inside its own catch, so after any
    // error that is not a cancellation it stops reconnecting for the rest of
    // the session and the menu quietly goes stale.
    it('reconnects after a failure', async () => {
        const h = harness({
            streams: [throws(new Error('connection reset')), yields('recovered')],
            stopAfter: 2,
        });
        await h.run();

        expect(h.errors).toHaveLength(1);
        expect(h.events).toEqual(['recovered']);
        expect(h.connects).toBe(2);
    });

    it('reconnects after the daemon closes the stream cleanly', async () => {
        const h = harness({ streams: [yields('one'), yields('two')], stopAfter: 2 });
        await h.run();

        expect(h.events).toEqual(['one', 'two']);
    });

    it('backs off further with each consecutive failure', async () => {
        const h = harness({
            streams: [throws(new Error('x'))],
            stopAfter: 4,
        });
        await h.run();

        expect(h.delays).toEqual([0, 1, 2, 3]);
    });

    // A socket that accepts and immediately hangs up would otherwise look like
    // success and pin the backoff at its floor forever.
    it('does not reset the backoff on a connect that produced nothing', async () => {
        const h = harness({ streams: [yields()], stopAfter: 3 });
        await h.run();

        expect(h.delays).toEqual([0, 1, 2]);
    });

    it('comes straight back after a stream that delivered something', async () => {
        const h = harness({
            streams: [
                throws(new Error('x')),
                throws(new Error('x')),
                yields('alive'),
                throws(new Error('x')),
            ],
            stopAfter: 4,
        });
        await h.run();

        // Two dead connections climb to 1; the productive one resets, and the
        // failure after it starts again from the floor rather than resuming
        // the old climb.
        expect(h.delays).toEqual([0, 1, 0, 0]);
    });

    // The other half of the stranded-promise fix: modules/io.js rejects the
    // delay on cancellation, and this loop has to actually leave on it.
    it('returns when the delay rejects', async () => {
        const token = new CancelToken();

        await expect(
            runWithReconnect({
                token,
                connect: throws(new Error('down')),
                onEvent: () => {},
                onError: () => {},
                delay: () => {
                    token.cancel();
                    return Promise.reject(new CancelledError());
                },
                backoff: () => 1000,
            }),
        ).resolves.toBeUndefined();
    });

    it('stops without connecting when the token is already cancelled', async () => {
        const h = harness({ streams: [yields('never')] });
        h.token.cancel();
        await h.run();

        expect(h.connects).toBe(0);
        expect(h.events).toEqual([]);
    });

    it('stops mid-stream once cancelled', async () => {
        const token = new CancelToken();
        const events = [];

        await runWithReconnect({
            token,
            connect: async function* () {
                yield 'first';
                token.cancel();
                yield 'second';
            },
            onEvent: event => events.push(event),
            onError: () => {},
            delay: () => Promise.resolve(),
            backoff: () => 0,
        });

        expect(events).toEqual(['first']);
    });

    // Otherwise every disable() would report a failure that did not happen.
    it('does not report a cancellation as an error', async () => {
        const token = new CancelToken();
        const errors = [];

        await runWithReconnect({
            token,
            connect: async function* () {
                token.cancel();
                throw new CancelledError();
                // eslint-disable-next-line no-unreachable
                yield '';
            },
            onEvent: () => {},
            onError: error => errors.push(error),
            delay: () => Promise.resolve(),
            backoff: () => 0,
        });

        expect(errors).toEqual([]);
    });

    // A Gio cancellation that escaped modules/io.js untranslated must still
    // end the loop rather than being retried forever.
    it('ends on an untranslated cancellation once the token is set', async () => {
        const token = new CancelToken();
        const onError = vi.fn();

        await runWithReconnect({
            token,
            connect: async function* () {
                token.cancel();
                throw new Error('g-io-error-quark: Operation was cancelled (19)');
                // eslint-disable-next-line no-unreachable
                yield '';
            },
            onEvent: () => {},
            onError,
            delay: () => Promise.resolve(),
            backoff: () => 0,
        });

        expect(onError).not.toHaveBeenCalled();
    });

    // for await calls the generator's return() on the way out, which is what
    // runs the finally that closes the input stream in modules/io.js.
    it('runs the stream cleanup when it leaves early', async () => {
        const token = new CancelToken();
        const closed = vi.fn();

        await runWithReconnect({
            token,
            connect: async function* () {
                try {
                    yield 'first';
                    yield 'second';
                } finally {
                    closed();
                }
            },
            onEvent: () => token.cancel(),
            onError: () => {},
            delay: () => Promise.resolve(),
            backoff: () => 0,
        });

        expect(closed).toHaveBeenCalledTimes(1);
    });
});
