// Fixtures for the actor layer.

import { KEYS, SHORTCUT_KEYS } from '../../modules/settings.js';

/**
 * A Gio.Settings-shaped double.
 *
 * Backed by a Map rather than an object literal. A settings store is keyed by
 * a variable by definition, and a Map says so — where indexing an object with
 * one both trips the security rule and lets an inherited property answer for a
 * key that was never set.
 *
 * @param {object} [values] Starting values, keyed by schema key.
 * @returns {object} The settings object, with an emitChange() for tests.
 */
export function createSettings(values = {}) {
    const state = new Map([
        [KEYS.SHOW_OFFLINE_NODES, true],
        [KEYS.SHOW_MULLVAD, true],
        [KEYS.MAX_MENU_HEIGHT, 0],
        [SHORTCUT_KEYS.OPEN_MENU, []],
        ...Object.entries(values),
    ]);

    const handlers = new Map();
    let nextId = 1;

    return {
        /** Live handler ids, so a test can prove they were disconnected. */
        connected: handlers,

        get_boolean: key => Boolean(state.get(key)),
        get_int: key => Number(state.get(key) ?? 0),
        get_strv: key => [...(state.get(key) ?? [])],

        set_boolean(key, value) {
            state.set(key, Boolean(value));
            this.emitChange(key);
        },

        set_int(key, value) {
            state.set(key, Number(value));
            this.emitChange(key);
        },

        connect(signal, callback) {
            const id = nextId++;
            handlers.set(id, { signal, callback });
            return id;
        },

        disconnect(id) {
            handlers.delete(id);
        },

        /** Fire `changed::<key>` as GSettings would. */
        emitChange(key) {
            for (const handler of [...handlers.values()])
                if (handler.signal === `changed::${key}`) handler.callback();
        },
    };
}
