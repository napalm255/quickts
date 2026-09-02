import { describe, expect, it } from 'vitest';

import {
    REASON,
    TransportError,
    isActionable,
    messageFor,
    reasonOf,
} from '../modules/errors.js';

describe('TransportError', () => {
    it('carries its reason and status', () => {
        const error = new TransportError(REASON.HTTP, 'HTTP 500', { status: 500 });

        expect(error.reason).toBe(REASON.HTTP);
        expect(error.status).toBe(500);
    });

    it('defaults the status when there was no response', () => {
        expect(new TransportError(REASON.CONNECTION_REFUSED, 'refused').status).toBe(0);
    });

    // Without cause, the Gio domain and code — the only things that say which
    // syscall failed — are flattened into the message and unrecoverable.
    it('keeps the original error reachable', () => {
        const gerror = new Error('g-io-error-quark: Connection refused (39)');

        expect(new TransportError(REASON.UNKNOWN, 'x', { cause: gerror }).cause).toBe(
            gerror,
        );
    });

    it('is recognisable across a realm boundary', () => {
        expect(new TransportError(REASON.HTTP, 'x').name).toBe('TransportError');
    });
});

describe('reasonOf', () => {
    it('reads the reason off a TransportError', () => {
        expect(reasonOf(new TransportError(REASON.PERMISSION_DENIED, 'x'))).toBe(
            REASON.PERMISSION_DENIED,
        );
    });

    it.each([
        ['a plain error', new Error('boom')],
        ['null', null],
        ['undefined', undefined],
    ])('reports %s as unknown', (_reason, value) => {
        expect(reasonOf(value)).toBe(REASON.UNKNOWN);
    });
});

describe('messageFor', () => {
    it('gives every reason a sentence', () => {
        for (const reason of Object.values(REASON))
            expect(messageFor(reason)).toMatch(/\S/);
    });

    // The whole point of classifying at all. tailscaled answers 403 to anyone
    // who is not the operator, and the extension QuickTS replaces logged that
    // to the journal and drew an empty menu — leaving no way to find out that
    // one command fixes it.
    it('names the command that fixes a permission failure', () => {
        expect(messageFor(REASON.PERMISSION_DENIED)).toContain(
            'tailscale set --operator=',
        );
    });

    it('falls back rather than returning nothing for an unknown reason', () => {
        expect(messageFor('something-new')).toBe(messageFor(REASON.UNKNOWN));
    });
});

describe('isActionable', () => {
    it.each([[REASON.PERMISSION_DENIED], [REASON.SOCKET_MISSING]])(
        '%s is something the user can act on',
        reason => {
            expect(isActionable(reason)).toBe(true);
        },
    );

    // Telling someone the daemon is unreachable is noise; it belongs in a
    // subtitle, not a row of its own.
    it.each([[REASON.CONNECTION_REFUSED], [REASON.HTTP], [REASON.UNKNOWN]])(
        '%s is not',
        reason => {
            expect(isActionable(reason)).toBe(false);
        },
    );
});
