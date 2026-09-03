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

import { CancelToken } from './modules/cancel.js';
import { messageFor, reasonOf } from './modules/errors.js';
import { createIo } from './modules/io.js';
import { patchPrefsRequest, prefsRequest } from './modules/localapi.js';
import { parseRoutes, subnetRoutes, withSubnets } from './modules/routes.js';
import { KEYS, SETTINGS, SHORTCUT_KEYS } from './modules/settings.js';
import {
    CAPTURE_ASSIGN,
    CAPTURE_CANCEL,
    CAPTURE_CLEAR,
    captureOutcome,
} from './modules/shortcuts.js';

/**
 * How modules/settings.js describes one key.
 *
 * @param {string} key A key from KEYS or SHORTCUT_KEYS.
 * @returns {{label: string, detail: string}} Its untranslated wording.
 */
function describe(key) {
    return SETTINGS.find(setting => setting.key === key);
}

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

/**
 * The row that edits the subnets this machine advertises.
 *
 * Talks to tailscaled rather than to GSettings. The daemon owns
 * AdvertiseRoutes, and mirroring it into a settings key would be two sources
 * of truth that drift the first time anyone runs `tailscale set`. This is
 * possible at all because modules/io.js imports Gio, GLib and Soup and nothing
 * from resource:/// — so the preferences process, which has no access to the
 * Shell's modules, can still use it.
 */
const RoutesRow = GObject.registerClass(
    class QuickTSRoutesRow extends Adw.EntryRow {
        /**
         * @param {object} io The transport, from createIo.
         */
        _init(io) {
            super._init({
                title: _('Advertised subnets'),
                // Applied on Enter or on the apply button, not on every
                // keystroke: half a CIDR prefix is not a route.
                show_apply_button: true,
            });

            this._io = io;
            this._prefs = null;

            this.connect('apply', () => void this._apply());
            void this._load();
        }

        /** Read the current routes off the daemon. */
        async _load() {
            try {
                this._prefs = await this._io.client.request(prefsRequest());
                this.text = subnetRoutes(this._prefs.AdvertiseRoutes).join(', ');
                this.subtitle = _('Comma separated, for example 192.168.1.0/24');
            } catch (error) {
                this.sensitive = false;
                this.subtitle = _(messageFor(reasonOf(error)));
                console.warn(`[quickts] could not read routes: ${error}`);
            }
        }

        /** Send what was typed, refusing anything that is not a prefix. */
        async _apply() {
            const { routes, invalid } = parseRoutes(this.text);

            if (invalid.length > 0) {
                // Reported rather than dropped: silently discarding a typo
                // would leave someone believing a subnet is advertised.
                this.add_css_class('error');
                this.subtitle = _('Not a subnet: %s').replace('%s', invalid.join(', '));
                return;
            }

            this.remove_css_class('error');

            try {
                // Read again rather than trusting the copy from load: the
                // exit-node setting lives in the same list and may have been
                // toggled from the menu since.
                const current = await this._io.client.request(prefsRequest());
                await this._io.client.request(
                    patchPrefsRequest({
                        AdvertiseRoutes: withSubnets(current.AdvertiseRoutes, routes),
                    }),
                );
                this.subtitle = _('Comma separated, for example 192.168.1.0/24');
            } catch (error) {
                this.subtitle = _(messageFor(reasonOf(error)));
                console.warn(`[quickts] could not set routes: ${error}`);
            }
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

        // Titled from modules/settings.js, which is where a key is described,
        // and bound the one way every row is bound.
        const addRow = (group, key, row, property) => {
            const { label, detail } = describe(key);

            row.title = _(label);
            row.subtitle = _(detail);
            settings.bind(key, row, property, Gio.SettingsBindFlags.DEFAULT);
            group.add(row);
        };

        addRow(menu, KEYS.SHOW_OFFLINE_NODES, new Adw.SwitchRow(), 'active');
        addRow(menu, KEYS.SHOW_MULLVAD, new Adw.SwitchRow(), 'active');
        addRow(
            menu,
            KEYS.MAX_MENU_HEIGHT,
            new Adw.SpinRow({
                adjustment: new Gtk.Adjustment({
                    lower: 0,
                    upper: 2000,
                    step_increment: 10,
                    page_increment: 100,
                }),
            }),
            'value',
        );

        page.add(menu);

        const routing = new Adw.PreferencesGroup({
            title: _('Routing'),
            description: _(
                'Subnets this machine offers to route for. Running as an exit ' +
                    'node is toggled from the menu.',
            ),
        });

        // One token for the lifetime of the window; cancelling it aborts any
        // request still in flight when it closes.
        const token = new CancelToken();
        const io = createIo({ token });
        window.connect('close-request', () => {
            token.cancel();
            io.dispose();
            return false;
        });

        routing.add(new RoutesRow(io));
        page.add(routing);

        const shortcut = new Adw.PreferencesGroup({ title: _('Keyboard shortcut') });
        shortcut.add(
            new ShortcutRow(
                settings,
                SHORTCUT_KEYS.OPEN_MENU,
                _(describe(SHORTCUT_KEYS.OPEN_MENU).label),
                _(describe(SHORTCUT_KEYS.OPEN_MENU).detail),
            ),
        );
        page.add(shortcut);

        window.add(page);
    }
}
