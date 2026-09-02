// The settings QuickTS has, named once.
//
// Both modules/panel.js and prefs.js read this list rather than spelling the
// key strings out again, and tests/settings.test.js parses the gschema and
// asserts the two agree. That is how a preference that is configurable and
// inert gets caught before it ships.
//
// This file imports nothing.

/** Keys that hold a value. */
export const KEYS = Object.freeze({
    SHOW_OFFLINE_NODES: 'show-offline-nodes',
    SHOW_MULLVAD: 'show-mullvad',
    MAX_MENU_HEIGHT: 'max-menu-height',
});

/** Keys that hold an accelerator. */
export const SHORTCUT_KEYS = Object.freeze({
    OPEN_MENU: 'open-menu',
});

/**
 * Every key in the schema, with its type and an untranslated label.
 *
 * The labels live here rather than in prefs.js so that this file remains the
 * one place a key is described; prefs.js applies gettext at row-build time.
 */
export const SETTINGS = Object.freeze([
    Object.freeze({
        key: KEYS.SHOW_OFFLINE_NODES,
        type: 'b',
        label: 'Show offline devices',
        detail: 'List devices that are not currently reachable.',
    }),
    Object.freeze({
        key: KEYS.SHOW_MULLVAD,
        type: 'b',
        label: 'Show Mullvad exit nodes',
        detail: 'Group Mullvad’s exit nodes by country in the exit node list.',
    }),
    Object.freeze({
        key: KEYS.MAX_MENU_HEIGHT,
        type: 'i',
        label: 'Maximum menu height',
        detail: 'Zero lets the menu use whatever room the screen leaves below it.',
    }),
    Object.freeze({
        key: SHORTCUT_KEYS.OPEN_MENU,
        type: 'as',
        label: 'Open the QuickTS menu',
        detail: 'Unbound by default.',
    }),
]);

/** Just the keys, in schema order. */
export const ALL_KEYS = Object.freeze(SETTINGS.map(setting => setting.key));
