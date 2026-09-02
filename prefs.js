// Preferences. Runs in its own process, with no access to gnome-shell's
// resource:// modules — so nothing here may import modules/panel.js or
// modules/io.js.
//
// It holds only widget construction. The capture rules live in
// modules/shortcuts.js and the key list in modules/settings.js, both of which
// import nothing and are tested on plain Node; this file is excluded from
// coverage for exactly that reason.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {
    ExtensionPreferences,
    gettext as _,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import { KEYS, SHORTCUT_KEYS } from './modules/settings.js';
import {
    CAPTURE_ASSIGN,
    CAPTURE_CANCEL,
    CAPTURE_CLEAR,
    captureOutcome,
} from './modules/shortcuts.js';

// The Gdk and Gtk values modules/shortcuts.js needs. Passed in rather than
// imported there, so the rules themselves stay testable on plain Node.
const GTK_BINDING = {
    get escapeKey() {
        return Gdk.KEY_Escape;
    },
    get backspaceKey() {
        return Gdk.KEY_BackSpace;
    },
    get shiftMask() {
        return Gdk.ModifierType.SHIFT_MASK;
    },
    acceleratorValid: (keyval, mask) => Gtk.accelerator_valid(keyval, mask),
};

const ShortcutRow = GObject.registerClass(
    class QuickTSShortcutRow extends Adw.ActionRow {
        /**
         * @param {Gio.Settings} settings Extension settings.
         * @param {string} key Schema key holding the binding.
         * @param {string} title Human-readable name.
         * @param {string} subtitle What the shortcut does.
         */
        _init(settings, key, title, subtitle) {
            super._init({ title, subtitle, activatable: true });

            this._settings = settings;
            this._key = key;

            this._label = new Gtk.ShortcutLabel({
                disabled_text: _('Disabled'),
                valign: Gtk.Align.CENTER,
            });
            this.add_suffix(this._label);

            this._sync();
            this._changedId = settings.connect(`changed::${key}`, () => this._sync());
            this.connect('destroy', () => {
                if (this._changedId) {
                    this._settings.disconnect(this._changedId);
                    this._changedId = 0;
                }
            });
            this.connect('activated', () => this._capture());
        }

        /** Refresh the displayed accelerator from settings. */
        _sync() {
            this._label.accelerator = this._settings.get_strv(this._key)[0] ?? '';
        }

        /** Open a modal window that records the next key combination. */
        _capture() {
            const dialog = new Adw.Window({
                modal: true,
                transient_for: this.get_root(),
                default_width: 420,
                default_height: 220,
            });

            const view = new Adw.ToolbarView();
            view.add_top_bar(new Adw.HeaderBar({ show_end_title_buttons: false }));
            view.content = new Adw.StatusPage({
                title: _('Press a shortcut'),
                description: _('Backspace clears it, Escape cancels.'),
            });
            dialog.content = view;

            const controller = new Gtk.EventControllerKey();
            controller.connect('key-pressed', (_controller, keyval, keycode, state) => {
                const mask = state & Gtk.accelerator_get_default_mod_mask();

                // The decision lives in modules/shortcuts.js and is tested
                // there; this only carries it out on the widgets.
                const outcome = captureOutcome(keyval, mask, GTK_BINDING);

                if (outcome === CAPTURE_CANCEL) {
                    dialog.close();
                    return Gdk.EVENT_STOP;
                }

                if (outcome === CAPTURE_CLEAR) {
                    this._settings.set_strv(this._key, []);
                    dialog.close();
                    return Gdk.EVENT_STOP;
                }

                if (outcome !== CAPTURE_ASSIGN) return Gdk.EVENT_STOP;

                this._settings.set_strv(this._key, [
                    Gtk.accelerator_name_with_keycode(null, keyval, keycode, mask),
                ]);
                dialog.close();
                return Gdk.EVENT_STOP;
            });
            dialog.add_controller(controller);

            dialog.present();
        }
    },
);

export default class QuickTSPreferences extends ExtensionPreferences {
    /**
     * @param {Adw.PreferencesWindow} window Window to populate.
     */
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();

        const menu = new Adw.PreferencesGroup({
            title: _('Menu'),
            description: _('What the quick settings menu lists.'),
        });

        const offline = new Adw.SwitchRow({
            title: _('Show offline devices'),
            subtitle: _('List devices that are not currently reachable.'),
        });
        settings.bind(
            KEYS.SHOW_OFFLINE_NODES,
            offline,
            'active',
            Gio.SettingsBindFlags.DEFAULT,
        );
        menu.add(offline);

        const mullvad = new Adw.SwitchRow({
            title: _('Show Mullvad exit nodes'),
            subtitle: _('Grouped by country. A tailnet with Mullvad has thousands.'),
        });
        settings.bind(
            KEYS.SHOW_MULLVAD,
            mullvad,
            'active',
            Gio.SettingsBindFlags.DEFAULT,
        );
        menu.add(mullvad);

        const height = new Adw.SpinRow({
            title: _('Maximum height'),
            subtitle: _('Pixels. Zero uses whatever room the screen leaves below it.'),
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 2000,
                step_increment: 10,
                page_increment: 100,
            }),
        });
        settings.bind(
            KEYS.MAX_MENU_HEIGHT,
            height,
            'value',
            Gio.SettingsBindFlags.DEFAULT,
        );
        menu.add(height);

        page.add(menu);

        const shortcut = new Adw.PreferencesGroup({ title: _('Keyboard shortcut') });
        shortcut.add(
            new ShortcutRow(
                settings,
                SHORTCUT_KEYS.OPEN_MENU,
                _('Open the menu'),
                _('Unbound by default, so it cannot collide with a GNOME shortcut.'),
            ),
        );
        page.add(shortcut);

        window.add(page);
    }
}
