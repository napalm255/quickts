// Preferences. Runs in its own process, with no access to gnome-shell's
// resource:// modules — so nothing here may import from modules/panel.js or
// modules/io.js.

import {
    ExtensionPreferences,
    gettext as _,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import Adw from 'gi://Adw';

export default class QuickTSPreferences extends ExtensionPreferences {
    /**
     * @param {Adw.PreferencesWindow} window Window to populate.
     */
    fillPreferencesWindow(window) {
        const page = new Adw.PreferencesPage();
        page.add(new Adw.PreferencesGroup({ title: _('Menu') }));
        window.add(page);
    }
}
