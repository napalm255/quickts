import { describe, expect, it, vi } from 'vitest';

import { CancelToken, CancelledError, isCancelled } from '../modules/cancel.js';

describe('CancelToken', () => {
    it('starts uncancelled', () => {
        expect(new CancelToken().cancelled).toBe(false);
    });

    it('reports cancellation', () => {
        const token = new CancelToken();
        token.cancel();

        expect(token.cancelled).toBe(true);
    });

    it('runs callbacks on cancel', () => {
        const token = new CancelToken();
        const seen = [];
        token.onCancel(() => seen.push('a'));
        token.onCancel(() => seen.push('b'));

        token.cancel();

        expect(seen).toEqual(['a', 'b']);
    });

    // disable() may run after something has already given up and cancelled.
    it('runs each callback only once, however often cancel is called', () => {
        const token = new CancelToken();
        const callback = vi.fn();
        token.onCancel(callback);

        token.cancel();
        token.cancel();
        token.cancel();

        expect(callback).toHaveBeenCalledTimes(1);
    });

    // The race this exists for: a request registers its cleanup a tick after
    // disable() already cancelled. Waiting for a signal that has been and gone
    // would leak the very thing the callback was going to release.
    it('runs a callback registered after cancellation immediately', () => {
        const token = new CancelToken();
        token.cancel();
        const callback = vi.fn();

        const off = token.onCancel(callback);

        expect(callback).toHaveBeenCalledTimes(1);
        // The disposer it hands back is a no-op, but it still has to be safe
        // to call — the caller cannot know it registered too late.
        expect(() => off()).not.toThrow();
    });

    it('does not run an unregistered callback', () => {
        const token = new CancelToken();
        const callback = vi.fn();
        const off = token.onCancel(callback);

        off();
        token.cancel();

        expect(callback).not.toHaveBeenCalled();
    });

    it('tolerates unregistering more than once', () => {
        const token = new CancelToken();
        const off = token.onCancel(() => {});

        off();

        expect(() => off()).not.toThrow();
        expect(token.callbackCount).toBe(0);
    });

    // Teardown is the one moment where a single failure would strand
    // everything queued behind it.
    it('runs the remaining callbacks after one throws', () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const token = new CancelToken();
        const after = vi.fn();
        token.onCancel(() => {
            throw new Error('boom');
        });
        token.onCancel(after);

        token.cancel();

        expect(after).toHaveBeenCalledTimes(1);
        vi.restoreAllMocks();
    });

    // A callback that tears something down may register another cleanup. That
    // must not extend the loop that is already running.
    it('does not run a callback registered during cancellation twice', () => {
        const token = new CancelToken();
        const late = vi.fn();
        token.onCancel(() => token.onCancel(late));

        token.cancel();

        expect(late).toHaveBeenCalledTimes(1);
    });

    it('holds no callbacks after cancelling', () => {
        const token = new CancelToken();
        token.onCancel(() => {});
        token.onCancel(() => {});

        token.cancel();

        expect(token.callbackCount).toBe(0);
    });

    it('throws only once cancelled', () => {
        const token = new CancelToken();

        expect(() => token.throwIfCancelled()).not.toThrow();

        token.cancel();

        expect(() => token.throwIfCancelled()).toThrow(CancelledError);
    });
});

describe('isCancelled', () => {
    it('recognises a CancelledError', () => {
        expect(isCancelled(new CancelledError())).toBe(true);
    });

    // Survives a second realm, where instanceof does not.
    it('recognises anything carrying the name', () => {
        expect(isCancelled({ name: 'CancelledError' })).toBe(true);
    });

    it.each([
        ['a plain error', new Error('connection refused')],
        ['null', null],
        ['undefined', undefined],
        ['a string', 'cancelled'],
    ])('does not mistake %s for cancellation', (_reason, value) => {
        expect(isCancelled(value)).toBe(false);
    });
});
