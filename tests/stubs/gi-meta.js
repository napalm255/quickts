// Meta, as far as modules/panel.js uses it.

export default {
    KeyBindingFlags: { NONE: 0, IGNORE_AUTOREPEAT: 2 },

    // NONE is what addKeybinding returns when Mutter refuses a duplicate
    // accelerator. Recording a key that was never registered makes disable()
    // call removeKeybinding on it and the Shell warns.
    KeyBindingAction: { NONE: 0 },

    LaterType: { BEFORE_REDRAW: 1, IDLE: 2 },
};
