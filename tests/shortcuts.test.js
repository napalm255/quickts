import { describe, expect, it } from 'vitest';

import {
    CAPTURE_ASSIGN,
    CAPTURE_CANCEL,
    CAPTURE_CLEAR,
    CAPTURE_IGNORE,
    captureOutcome,
    isValidBinding,
} from '../modules/shortcuts.js';

// Stand-ins for the Gdk and Gtk values prefs.js passes in.
const SHIFT = 1;
const CONTROL = 4;
const ESCAPE = 0xff1b;
const BACKSPACE = 0xff08;

const gtk = {
    escapeKey: ESCAPE,
    backspaceKey: BACKSPACE,
    shiftMask: SHIFT,
    acceleratorValid: () => true,
};

describe('isValidBinding', () => {
    it('accepts a modified key', () => {
        expect(isValidBinding(CONTROL, 0x61, gtk)).toBe(true);
    });

    // A bare key would steal it from every application, and Shift alone just
    // types a capital letter.
    it.each([
        ['no modifier', 0],
        ['Shift alone', SHIFT],
    ])('rejects %s', (_reason, mask) => {
        expect(isValidBinding(mask, 0x61, gtk)).toBe(false);
    });

    it('defers to Gtk on what is a valid accelerator', () => {
        expect(
            isValidBinding(CONTROL, 0x61, { ...gtk, acceleratorValid: () => false }),
        ).toBe(false);
    });
});

describe('captureOutcome', () => {
    it('assigns a valid combination', () => {
        expect(captureOutcome(0x61, CONTROL, gtk)).toBe(CAPTURE_ASSIGN);
    });

    it('cancels on a bare Escape', () => {
        expect(captureOutcome(ESCAPE, 0, gtk)).toBe(CAPTURE_CANCEL);
    });

    it('clears on a bare Backspace', () => {
        expect(captureOutcome(BACKSPACE, 0, gtk)).toBe(CAPTURE_CLEAR);
    });

    // Otherwise Ctrl+Escape could never be bound, because the dialog would
    // swallow it as a cancel.
    it.each([
        ['Escape', ESCAPE],
        ['Backspace', BACKSPACE],
    ])(
        'binds a modified %s rather than treating it as a command',
        (_reason, keyval) => {
            expect(captureOutcome(keyval, CONTROL, gtk)).toBe(CAPTURE_ASSIGN);
        },
    );

    it('swallows a combination that cannot be bound', () => {
        expect(captureOutcome(0x61, 0, gtk)).toBe(CAPTURE_IGNORE);
    });
});
