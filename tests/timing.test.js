import { describe, expect, it } from 'vitest';

import {
    BACKOFF_BASE,
    BACKOFF_CAP,
    FLUSH_MAX_WAIT,
    FLUSH_WAIT,
    backoffDelay,
    flushDelay,
} from '../modules/timing.js';

// Pinning random makes the schedule a fixed sequence rather than a range.
const noJitter = () => 0;
const fullJitter = () => 0.999999;
const halfJitter = () => 0.5;

describe('backoffDelay', () => {
    it('doubles the ceiling with each attempt', () => {
        const delays = [0, 1, 2, 3, 4].map(n => backoffDelay(n, { random: noJitter }));

        expect(delays).toEqual([500, 1000, 2000, 4000, 8000]);
    });

    it('never waits longer than the cap', () => {
        expect(backoffDelay(20, { random: fullJitter })).toBeLessThanOrEqual(
            BACKOFF_CAP,
        );
    });

    it('reaches the cap and stays there', () => {
        expect(backoffDelay(30, { random: fullJitter })).toBe(BACKOFF_CAP);
    });

    // Equal jitter: never less than half the ceiling, so a daemon that is down
    // is not hammered, and never more than the whole, so recovery stays quick.
    it('spreads between half the ceiling and the whole of it', () => {
        expect(backoffDelay(2, { random: noJitter })).toBe(2000);
        expect(backoffDelay(2, { random: halfJitter })).toBe(3000);
        expect(backoffDelay(2, { random: fullJitter })).toBe(4000);
    });

    it('waits at least half the base on the first retry', () => {
        expect(backoffDelay(0, { random: noJitter })).toBe(BACKOFF_BASE / 2);
    });

    // 2 ** 1024 is Infinity, and a daemon down for a week gets there. Infinity
    // is not a long wait, it is a GLib.timeout_add that never fires.
    it('stays finite for an absurd attempt count', () => {
        const delay = backoffDelay(100000, { random: fullJitter });

        expect(Number.isFinite(delay)).toBe(true);
        expect(delay).toBe(BACKOFF_CAP);
    });

    it('treats a negative attempt as the first', () => {
        expect(backoffDelay(-5, { random: noJitter })).toBe(
            backoffDelay(0, { random: noJitter }),
        );
    });

    it('returns a whole number of milliseconds', () => {
        expect(Number.isInteger(backoffDelay(3, { random: () => 0.3333 }))).toBe(true);
    });
});

describe('flushDelay', () => {
    // A burst that has gone quiet: wait out the remainder of the quiet period.
    it('waits for quiet after the last signal', () => {
        expect(flushDelay({ firstSignalAt: 0, lastSignalAt: 100, now: 100 })).toBe(
            FLUSH_WAIT,
        );
    });

    it('counts time already elapsed against the wait', () => {
        // Quiet period ends at 100 + 400; 400 has already gone by.
        expect(flushDelay({ firstSignalAt: 0, lastSignalAt: 100, now: 400 })).toBe(100);
    });

    it('flushes immediately once the quiet period has passed', () => {
        expect(flushDelay({ firstSignalAt: 0, lastSignalAt: 100, now: 5000 })).toBe(0);
    });

    // The failure mode a plain debounce has: a daemon that never goes quiet
    // postpones the flush for as long as it keeps talking, and the menu shows
    // stale data indefinitely.
    it('does not let a steady stream postpone the flush past the ceiling', () => {
        expect(flushDelay({ firstSignalAt: 0, lastSignalAt: 1400, now: 1400 })).toBe(
            FLUSH_MAX_WAIT - 1400,
        );
    });

    it('flushes at once when the ceiling has already passed', () => {
        expect(flushDelay({ firstSignalAt: 0, lastSignalAt: 9000, now: 9000 })).toBe(0);
    });

    it('never returns a negative delay', () => {
        expect(flushDelay({ firstSignalAt: 0, lastSignalAt: 0, now: 100000 })).toBe(0);
    });

    it('honours overridden windows', () => {
        expect(
            flushDelay({
                firstSignalAt: 0,
                lastSignalAt: 0,
                now: 0,
                wait: 50,
                maxWait: 500,
            }),
        ).toBe(50);
    });
});
