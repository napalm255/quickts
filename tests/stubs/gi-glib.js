// GLib, as far as modules/panel.js uses it.
//
// The timeout functions record live source ids so a test can assert that none
// outlived a disable, which is the leak the extension QuickTS replaces has.
// Callbacks are never invoked on their own: a test fires one through
// runSource(), so when a timer goes off is a decision the test makes rather
// than a race it has to win.

/** Source ids currently live. */
export const liveSources = new Set();

/** Source id -> callback, for runSource(). */
const callbacks = new Map();

let nextSourceId = 1;

/** Reset between tests. */
export function resetSources() {
    liveSources.clear();
    callbacks.clear();
}

/**
 * Fire a pending source, as the main loop would.
 *
 * @param {number} id Source id.
 * @returns {boolean} Whatever the callback returned.
 */
export function runSource(id) {
    const callback = callbacks.get(id);
    if (!callback) return false;

    const keep = callback();
    if (!keep) {
        liveSources.delete(id);
        callbacks.delete(id);
    }
    return keep;
}

export default {
    PRIORITY_DEFAULT: 0,
    PRIORITY_DEFAULT_IDLE: 200,
    SOURCE_REMOVE: false,
    SOURCE_CONTINUE: true,

    FileTest: { EXISTS: 1 },
    file_test: () => true,

    timeout_add(_priority, _ms, callback) {
        const id = nextSourceId++;
        liveSources.add(id);
        callbacks.set(id, callback);
        return id;
    },

    idle_add(priority, callback) {
        return this.timeout_add(priority, 0, callback);
    },

    Source: {
        remove(id) {
            liveSources.delete(id);
            callbacks.delete(id);
        },
    },

    get_monotonic_time: () => 0,
};
