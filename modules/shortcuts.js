// The rules for capturing an accelerator.
//
// Lifted from the sibling tiler repo, minus its conflictingActions: QuickTS
// has one shortcut, so there is nothing of its own for it to collide with.
// Mutter still refuses an accelerator another application holds, which
// modules/panel.js handles by checking what addKeybinding returned.
//
// Imports nothing from gi://. The Gdk and Gtk values these rules need are
// passed in by prefs.js, which keeps the decisions testable on plain Node and
// leaves prefs.js holding only widget construction — the part no unit test can
// say anything useful about.

/** Close the capture dialog, changing nothing. */
export const CAPTURE_CANCEL = 'cancel';

/** Unbind the shortcut and close. */
export const CAPTURE_CLEAR = 'clear';

/** Not bindable; swallow the key and keep waiting. */
export const CAPTURE_IGNORE = 'ignore';

/** Bind the combination and close. */
export const CAPTURE_ASSIGN = 'assign';

/**
 * Whether a captured combination may be bound as a global shortcut.
 *
 * A bare key would steal it from every application, and Shift alone just types
 * a capital letter.
 *
 * @param {number} mask Modifier mask, already reduced to the default mod mask.
 * @param {number} keyval Key value.
 * @param {{shiftMask: number, acceleratorValid: Function}} gtk Gdk/Gtk values.
 * @returns {boolean} True if the combination may be bound.
 */
export function isValidBinding(mask, keyval, { shiftMask, acceleratorValid }) {
    if (mask === 0 || mask === shiftMask) return false;

    return acceleratorValid(keyval, mask);
}

/**
 * What the capture dialog should do about a keypress.
 *
 * Escape and Backspace are treated as commands only when pressed unmodified,
 * so Ctrl+Escape and the like stay bindable rather than being swallowed.
 *
 * @param {number} keyval Key value.
 * @param {number} mask Modifier mask, reduced to the default mod mask.
 * @param {object} gtk Gdk/Gtk values: escapeKey, backspaceKey, shiftMask,
 *   acceleratorValid.
 * @returns {string} One of the CAPTURE_* outcomes.
 */
export function captureOutcome(keyval, mask, gtk) {
    if (mask === 0 && keyval === gtk.escapeKey) return CAPTURE_CANCEL;
    if (mask === 0 && keyval === gtk.backspaceKey) return CAPTURE_CLEAR;
    if (!isValidBinding(mask, keyval, gtk)) return CAPTURE_IGNORE;

    return CAPTURE_ASSIGN;
}
