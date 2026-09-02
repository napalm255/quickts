// resource:///org/gnome/shell/ui/main.js, as far as modules/panel.js uses it.
//
// A module singleton, mirroring the real Main. reset() must be called from
// beforeEach or state leaks between tests.

import { FakeActor } from '../support/actors.js';

/** Keybinding name -> handler, for the ones Mutter accepted. */
export const registered = new Map();

/** Every addKeybinding call, accepted or not. */
export const addCalls = [];

/** Every removeKeybinding call. */
export const removeCalls = [];

/** Names Mutter should refuse, simulating an accelerator already in use. */
export const refuse = new Set();

/** Indicators handed to addExternalIndicator. */
export const externalIndicators = [];

/** OSD messages shown, in order. */
export const osdMessages = [];

/** Notifications raised, in order. */
export const notifications = [];

/** Times the quick settings menu was toggled. */
export const quickSettingsToggles = [];

const quickSettings = new FakeActor();
quickSettings.mapped = true;
quickSettings.reactive = true;
quickSettings.menu = new FakeActor();
quickSettings.menu.isOpen = false;
quickSettings.addExternalIndicator = (indicator, colSpan = 1) => {
    externalIndicators.push({ indicator, colSpan });
};

export const panel = {
    statusArea: { quickSettings },
    toggleQuickSettings() {
        quickSettingsToggles.push(Date.now());
        quickSettings.menu.isOpen = !quickSettings.menu.isOpen;
    },
};

export const wm = {
    addKeybinding(name, _settings, _flags, _mode, handler) {
        addCalls.push(name);
        // 0 is Meta.KeyBindingAction.NONE, which is what Mutter returns when
        // the accelerator is already claimed.
        if (refuse.has(name)) return 0;

        registered.set(name, handler);
        return addCalls.length;
    },

    removeKeybinding(name) {
        removeCalls.push(name);
        registered.delete(name);
    },
};

export const layoutManager = {
    primaryIndex: 0,
    monitors: [{ index: 0, x: 0, y: 0, width: 1920, height: 1080 }],
    getWorkAreaForMonitor: () => ({ x: 0, y: 32, width: 1920, height: 1048 }),
};

export const osdWindowManager = {
    showOne(monitorIndex, icon, label) {
        osdMessages.push({ monitorIndex, icon, label });
    },
};

export function notify(message, details) {
    notifications.push({ kind: 'notify', message, details });
}

export function notifyError(message, details) {
    notifications.push({ kind: 'error', message, details });
}

/** Fire a registered keybinding, as a keypress would. */
export function press(name) {
    registered.get(name)?.();
}

/** Clear all recorded state. Call from beforeEach. */
export function reset() {
    registered.clear();
    addCalls.length = 0;
    removeCalls.length = 0;
    refuse.clear();
    externalIndicators.length = 0;
    osdMessages.length = 0;
    notifications.length = 0;
    quickSettingsToggles.length = 0;
    quickSettings.mapped = true;
    quickSettings.reactive = true;
    quickSettings.menu.isOpen = false;
}
