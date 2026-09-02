// GObject, as far as modules/panel.js uses it.
//
// registerClass is the identity. The construction path it provides in real GJS
// — new X(args) dispatching to _init — is provided instead by FakeActor's
// constructor, so a subclass written the way gnome-shell writes them works
// unchanged under Vitest.

export default {
    registerClass(...args) {
        // Real registerClass accepts an optional metadata object first.
        return args.at(-1);
    },

    ParamFlags: { READABLE: 1, WRITABLE: 2, READWRITE: 3 },
    BindingFlags: { DEFAULT: 0, SYNC_CREATE: 1, BIDIRECTIONAL: 2 },
};
