// The actor tree: the quick settings tile, its menu, and the keybinding.
//
// This is the one file that touches St, Clutter and the Shell's own modules,
// and it deliberately holds no decisions. What to show comes from
// modules/health.js, how to group it from modules/peers.js and
// modules/mullvad.js, how tall to make it from modules/layout.js. What is left
// here is construction and teardown.
//
// Teardown is the part worth reading. Every subscription, signal and
// keybinding is recorded in a named field or a flat array and released in
// disable(), because the review guidelines require it and because the
// extension QuickTS replaces connects a dozen handlers and two property
// bindings and disconnects none of them.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';

import {
    SUMMARY,
    healthLines,
    isUp,
    needsLogin,
    problemOf,
    severityOf,
    summaryOf,
} from './health.js';
import { maxHeightStyle, menuMaxHeight } from './layout.js';
import { cityOf, groupByCountry, partitionMullvad } from './mullvad.js';
import { KEYS, SHORTCUT_KEYS } from './settings.js';
import { hasEligibleTarget, sendTargets } from './taildrop.js';

/** Set by enable(); the extension supplies these from its own domain. */
let _ = message => message;

// Plural forms are not "%d warning" with an s bolted on. Several languages
// have more than two, and some have none, so the count goes through ngettext
// rather than being interpolated into a single string.
let _n = (singular, plural, count) => (count === 1 ? singular : plural);

/** The tile's own icon, next to the clock. */
const QuickTSIndicator = GObject.registerClass(
    class QuickTSIndicator extends QuickSettings.SystemIndicator {
        _init(gicon) {
            super._init();

            this._up = this._addIndicator();
            this._up.gicon = gicon;

            // A second icon, shown only while traffic is leaving through a
            // peer. Routing all your traffic through another machine is worth
            // an indicator of its own.
            this._exit = this._addIndicator();
            this._exit.icon_name = 'network-vpn-symbolic';

            this.sync(null);
        }

        /**
         * @param {object|null} state A snapshot, or null before the first read.
         */
        sync(state) {
            const up = Boolean(state && isUp(state));
            this._up.visible = up;
            this._exit.visible = up && Boolean(state.exitNodeName);
        }
    },
);

/** The tile itself, and everything in its menu. */
const QuickTSToggle = GObject.registerClass(
    class QuickTSToggle extends QuickSettings.QuickMenuToggle {
        _init({ gicon, model, settings, chooseFiles }) {
            super._init({ title: 'Tailscale', gicon, toggleMode: true });

            this._gicon = gicon;
            this._model = model;
            this._settings = settings;
            this._chooseFiles = chooseFiles;

            // Set only when the user asks to log in. The auth URL is present
            // in the state whenever the daemon is waiting for one, and opening
            // a browser because of that alone would hijack the session of
            // anyone who happens to be logged out.
            this._loginRequested = false;

            this.menu.setHeader(gicon, _('Tailscale'), '');

            this._buildSections();

            // Clicking the tile brings the tailnet up or down. `checked` is
            // set from the state rather than left to toggleMode, so a change
            // that the daemon refuses snaps back instead of lying.
            this.connectObject('clicked', () => this._onClicked(), this);

            this.menu.connectObject(
                'open-state-changed',
                (_menu, open) => this._onOpenStateChanged(open),
                this,
            );
        }

        /** Build the sections once; their contents are refilled on each change. */
        _buildSections() {
            // Anything the user can act on, above everything else: an
            // unreachable daemon, a login that is waiting to happen.
            this._problems = new PopupMenu.PopupMenuSection();
            this.menu.addMenuItem(this._problems);

            // Health warnings are informational — the daemon reports things
            // like an SELinux caveat or peers advertising unaccepted routes,
            // which are worth surfacing but are not worth several permanent
            // rows above the controls. They collapse into a count that expands.
            this._warnings = new PopupMenu.PopupSubMenuMenuItem(_('Warnings'), true);
            this._warnings.icon.icon_name = 'dialog-warning-symbolic';
            this._warnings.visible = false;
            this.menu.addMenuItem(this._warnings);

            this._exitNode = new PopupMenu.PopupSubMenuMenuItem(_('Exit node'), true);
            this.menu.addMenuItem(this._exitNode);

            this._devices = new PopupMenu.PopupSubMenuMenuItem(_('Devices'), true);
            this.menu.addMenuItem(this._devices);

            this._taildrop = new PopupMenu.PopupSubMenuMenuItem(_('Send files'), true);
            this._taildrop.visible = false;
            this.menu.addMenuItem(this._taildrop);

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            this._options = new PopupMenu.PopupSubMenuMenuItem(_('Settings'), true);
            this.menu.addMenuItem(this._options);
            this._buildOptions();

            this._profiles = new PopupMenu.PopupSubMenuMenuItem(_('Profiles'), true);
            this.menu.addMenuItem(this._profiles);
        }

        /**
         * The preference switches.
         *
         * Built once rather than rebuilt, so that toggling one does not
         * destroy the actor the click is still travelling through.
         */
        _buildOptions() {
            this._switches = [
                [
                    state => state.acceptRoutes,
                    _('Accept routes'),
                    value => this._model.setAcceptRoutes(value),
                ],
                [
                    state => state.acceptDNS,
                    _('Accept DNS'),
                    value => this._model.setAcceptDNS(value),
                ],
                [
                    state => state.allowLanAccess,
                    _('Allow LAN access'),
                    value => this._model.setAllowLanAccess(value),
                ],
                [
                    state => state.shieldsUp,
                    _('Block incoming'),
                    value => this._model.setShieldsUp(value),
                ],
                [
                    state => state.ssh,
                    _('Tailscale SSH'),
                    value => this._model.setSsh(value),
                ],
            ].map(([read, label, apply]) => {
                const item = new PopupMenu.PopupSwitchMenuItem(label, false);

                // The switch reports what the user asked for; the daemon's
                // answer comes back through the model and is what finally
                // sets the state. A refused change therefore reverts.
                item.connectObject(
                    'toggled',
                    (_item, value) => void apply(value),
                    this,
                );
                this._options.menu.addMenuItem(item);

                return { read, item };
            });
        }

        /** @param {object} state A snapshot. */
        sync(state) {
            this.checked = isUp(state);
            this.subtitle = subtitleFor(state);

            const severity = severityOf(state);
            this._setSeverityClass(severity);
            this.menu.setHeader(this._gicon, _('Tailscale'), this.subtitle);

            this._maybeOpenAuthUrl(state);
            this._syncProblems(state);
            this._syncWarnings(state);
            this._syncExitNode(state);
            this._syncDevices(state);
            this._syncOptions(state);
            this._syncProfiles(state);
        }

        /**
         * Open the login page, once, if one was asked for.
         *
         * @param {object} state A snapshot.
         */
        _maybeOpenAuthUrl(state) {
            if (!this._loginRequested || !state.authUrl) return;

            this._loginRequested = false;
            Gio.AppInfo.launch_default_for_uri(state.authUrl, null);
        }

        /**
         * @param {string} severity One of SEVERITY.
         */
        _setSeverityClass(severity) {
            for (const name of ['quickts-ok', 'quickts-warning', 'quickts-error'])
                this.remove_style_class_name(name);

            this.add_style_class_name(`quickts-${severity}`);
        }

        /** @param {object} state A snapshot. */
        _syncProblems(state) {
            this._problems.removeAll();

            const problem = problemOf(state);
            if (problem) {
                const item = new PopupMenu.PopupImageMenuItem(
                    _(problem.message),
                    problem.actionable
                        ? 'dialog-warning-symbolic'
                        : 'network-offline-symbolic',
                );
                // An actionable problem names a command; activating the row
                // puts it on the clipboard so it can be pasted into a terminal
                // rather than retyped from a menu.
                if (problem.actionable)
                    item.connectObject(
                        'activate',
                        () => copyText(commandIn(problem.message), this._gicon),
                        this,
                    );
                else item.setSensitive(false);

                this._problems.addMenuItem(item);
            }

            if (needsLogin(state)) {
                const login = new PopupMenu.PopupImageMenuItem(
                    _('Log in…'),
                    'avatar-default-symbolic',
                );
                login.connectObject('activate', () => this._startLogin(), this);
                this._problems.addMenuItem(login);
            }
        }

        /**
         * Fill the collapsed warnings section.
         *
         * @param {object} state A snapshot.
         */
        _syncWarnings(state) {
            this._warnings.menu.removeAll();

            const { lines, hidden } = healthLines(state);
            const total = lines.length + hidden;

            this._warnings.visible = total > 0;
            if (total === 0) return;

            this._warnings.label.text = _n('%d warning', '%d warnings', total).replace(
                '%d',
                String(total),
            );

            for (const line of lines) {
                const item = new PopupMenu.PopupMenuItem(line);
                item.setSensitive(false);
                this._warnings.menu.addMenuItem(item);
            }

            // healthLines caps the list; say so rather than dropping the rest
            // silently, which would leave the count in the label disagreeing
            // with what is actually shown underneath it.
            if (hidden > 0) {
                const more = new PopupMenu.PopupMenuItem(
                    _n('%d more', '%d more', hidden).replace('%d', String(hidden)),
                );
                more.setSensitive(false);
                this._warnings.menu.addMenuItem(more);
            }
        }

        /** @param {object} state A snapshot. */
        _syncExitNode(state) {
            this._exitNode.menu.removeAll();
            this._exitNode.label.text = state.exitNodeName
                ? _('Exit node: %s').replace('%s', state.exitNodeName)
                : _('Exit node');

            const none = new PopupMenu.PopupImageMenuItem(
                _('None'),
                state.exitNodeName ? '' : 'object-select-symbolic',
            );
            none.connectObject(
                'activate',
                () => void this._model.setExitNode(''),
                this,
            );
            this._exitNode.menu.addMenuItem(none);

            const candidates = state.nodes.filter(node => node.canBeExitNode);
            const { regular, mullvad } = partitionMullvad(candidates);

            for (const node of regular)
                this._exitNode.menu.addMenuItem(this._exitNodeItem(node, node.name));

            if (!this._settings.get_boolean(KEYS.SHOW_MULLVAD) || mullvad.length === 0)
                return;

            for (const group of groupByCountry(mullvad)) {
                const label = group.country.flag
                    ? `${group.country.flag} ${group.country.name}`
                    : group.country.name;
                const submenu = new PopupMenu.PopupSubMenuMenuItem(label, false);

                for (const node of group.nodes)
                    submenu.menu.addMenuItem(this._exitNodeItem(node, cityOf(node)));

                this._exitNode.menu.addMenuItem(submenu);
            }
        }

        /**
         * @param {object} node A normalised node.
         * @param {string} label What to call it.
         * @returns {object} A menu item.
         */
        _exitNodeItem(node, label) {
            const item = new PopupMenu.PopupImageMenuItem(
                label,
                node.isExitNode ? 'object-select-symbolic' : node.icon,
            );

            // Selecting the node in use clears it, so the same row both sets
            // and unsets without needing a separate "stop" control.
            item.connectObject(
                'activate',
                () => void this._model.setExitNode(node.isExitNode ? '' : node.id),
                this,
            );

            return item;
        }

        /** @param {object} state A snapshot. */
        _syncDevices(state) {
            this._devices.menu.removeAll();

            const showOffline = this._settings.get_boolean(KEYS.SHOW_OFFLINE_NODES);
            const nodes = state.nodes.filter(node => showOffline || node.online);

            if (nodes.length === 0) {
                const empty = new PopupMenu.PopupMenuItem(_('No devices'));
                empty.setSensitive(false);
                this._devices.menu.addMenuItem(empty);
                return;
            }

            for (const node of nodes)
                this._devices.menu.addMenuItem(this._deviceItem(node, state));
        }

        /**
         * A device row: click copies the address, a long press copies the name.
         *
         * The gesture is Clutter.LongPressGesture. Clutter.ClickAction and
         * Clutter.LongPressState, which the extension QuickTS replaces uses
         * for this, do not exist in Clutter 18 and throw on GNOME 49 and later.
         *
         * @param {object} node A normalised node.
         * @param {object} state A snapshot.
         * @returns {object} A menu item.
         */
        _deviceItem(node, state) {
            const address = node.ips.at(0) ?? '';
            const fqdn =
                node.name && state.magicDNSSuffix
                    ? `${node.name}.${state.magicDNSSuffix}`
                    : node.name;

            const item = new PopupMenu.PopupImageMenuItem(node.name, node.icon);

            if (address === '') {
                item.setSensitive(false);
                return item;
            }

            item.connectObject('activate', () => copyText(address, this._gicon), this);

            const longPress = new Clutter.LongPressGesture();
            longPress.connectObject(
                'recognize',
                () => copyText(fqdn, this._gicon),
                this,
            );
            item.add_action(longPress);

            return item;
        }

        /**
         * Rebuild the Taildrop list.
         *
         * The eligible targets come from the daemon rather than from the peer
         * list, so this needs a request; it is issued when the menu opens
         * rather than on every state change, because nobody can act on a list
         * they cannot see and asking on each netmap update would be a request
         * per peer that blinks.
         *
         * @returns {Promise<void>} Done.
         */
        async _syncTaildrop() {
            const targets = sendTargets(
                this._model.state.nodes,
                await this._model.fileTargets(),
            );

            // The menu may have closed, or the extension been disabled, while
            // the request was in flight.
            if (!this._taildrop) return;

            this._taildrop.menu.removeAll();
            this._taildrop.visible = hasEligibleTarget(targets);
            if (!this._taildrop.visible) return;

            for (const { node, eligible, reason } of targets) {
                const item = new PopupMenu.PopupImageMenuItem(
                    eligible ? node.name : `${node.name} — ${_(reason)}`,
                    node.icon,
                );

                if (!eligible) {
                    item.setSensitive(false);
                } else {
                    item.connectObject(
                        'activate',
                        () => void this._sendFiles(node),
                        this,
                    );
                }

                this._taildrop.menu.addMenuItem(item);
            }
        }

        /**
         * Choose files and send them.
         *
         * @param {object} node The node to send to.
         * @returns {Promise<void>} Done.
         */
        async _sendFiles(node) {
            const uris = await this._chooseFiles({
                title: _('Send to %s').replace('%s', node.name),
            });
            if (uris.length === 0) return;

            const { sent, failed } = await this._model.sendFiles(node.id, uris);

            if (sent > 0)
                Main.osdWindowManager.showOne(
                    Main.layoutManager.primaryIndex,
                    this._gicon,
                    _('Sent %d file to %s')
                        .replace('%d', String(sent))
                        .replace('%s', node.name),
                );

            if (failed.length > 0)
                Main.notifyError(
                    _('Could not send to %s').replace('%s', node.name),
                    failed.join(', '),
                );
        }

        /** @param {object} state A snapshot. */
        _syncOptions(state) {
            for (const { read, item } of this._switches)
                item.setToggleState(read(state));
        }

        /** @param {object} state A snapshot. */
        _syncProfiles(state) {
            this._profiles.menu.removeAll();

            // A single profile is the common case and a submenu offering only
            // the profile you are already using is noise.
            this._profiles.visible = state.profiles.length > 1;
            if (!this._profiles.visible) return;

            for (const profile of state.profiles) {
                const item = new PopupMenu.PopupImageMenuItem(
                    profile.name || profile.tailnet || profile.id,
                    profile.id === state.currentProfileId
                        ? 'object-select-symbolic'
                        : '',
                );
                item.connectObject(
                    'activate',
                    () => void this._model.switchProfile(profile.id),
                    this,
                );
                this._profiles.menu.addMenuItem(item);
            }
        }

        /** Bring the tailnet up or down. */
        _onClicked() {
            const state = this._model.state;

            // With the backend waiting for a login, flipping WantRunning does
            // nothing a person would notice. Starting the login is what they
            // were asking for.
            if (needsLogin(state)) {
                this._startLogin();
                return;
            }

            void this._model.setRunning(!isUp(state));
        }

        /** Ask the daemon for a login URL, and remember that we want it. */
        _startLogin() {
            this._loginRequested = true;

            // The URL may already be known, in which case there is nothing to
            // wait for.
            this._maybeOpenAuthUrl(this._model.state);
            void this._model.login();
        }

        /**
         * @param {boolean} open Whether the menu is now open.
         */
        _onOpenStateChanged(open) {
            this._model.setMenuOpen(open);
            if (!open) return;

            this._applyMaxHeight();
            void this._syncTaildrop();
        }

        /**
         * Clamp the menu to the room below it.
         *
         * The Shell already implements the scrolling; js/ui/popupMenu.js says
         * the scrollbar "will only take effect if a CSS max-height is set on
         * the top menu", and PopupSubMenu._needsScrollbar reads exactly that
         * from the theme node. So this sets the max-height and touches nothing
         * private — where the replaced extension hardcodes a height and
         * overwrites _needsScrollbar itself.
         */
        _applyMaxHeight() {
            const monitor = Main.layoutManager.primaryIndex;
            const workArea = Main.layoutManager.getWorkAreaForMonitor(monitor);
            const [, top] = this.menu.actor.get_transformed_position();

            this.menu.actor.style = maxHeightStyle(
                menuMaxHeight({
                    workAreaY: workArea.y,
                    workAreaHeight: workArea.height,
                    top,
                    margins:
                        (this.menu.actor.margin_top ?? 0) +
                        (this.menu.actor.margin_bottom ?? 0),
                    scaleFactor: St.ThemeContext.get_for_stage(global.stage)
                        .scale_factor,
                    capPx: this._settings.get_int(KEYS.MAX_MENU_HEIGHT),
                }),
            );
        }

        destroy() {
            // The rows carry handlers of their own — every activate, every
            // toggled, every long-press gesture — and disconnectObject on the
            // menu does not reach them, because they are connected on the rows.
            // removeAll() destroys each row, and destroying an actor drops its
            // handlers, which is what actually empties the set. Without this,
            // a disable leaves one handler per visible row connected.
            this.menu.removeAll();

            this.menu.disconnectObject(this);
            this.disconnectObject(this);
            super.destroy();
        }
    },
);

/** Owns the indicator, the toggle and the keybinding for one enable. */
export class Panel {
    /**
     * @param {object} options Options.
     * @param {object} options.model The store.
     * @param {object} options.settings This extension's GSettings.
     * @param {string} options.iconPath Absolute path to the tile icon.
     * @param {(message: string) => string} options.gettext Translation function.
     */
    constructor({ model, settings, iconPath, gettext, ngettext, chooseFiles }) {
        this._model = model;
        this._settings = settings;
        this._iconPath = iconPath;
        this._chooseFiles = chooseFiles ?? (() => Promise.resolve([]));
        this._disposers = [];
        this._bindings = [];

        _ = gettext ?? (message => message);
        _n =
            ngettext ??
            ((singular, plural, count) => (count === 1 ? singular : plural));
    }

    /** Build the tile and register the keybinding. */
    enable() {
        const gicon = Gio.icon_new_for_string(this._iconPath);

        this._indicator = new QuickTSIndicator(gicon);
        this._toggle = new QuickTSToggle({
            gicon,
            model: this._model,
            settings: this._settings,
            chooseFiles: this._chooseFiles,
        });

        this._indicator.quickSettingsItems.push(this._toggle);

        // The supported placement API, which puts the tile where the Shell
        // wants it relative to brightness and background apps. The replaced
        // extension reaches into _indicators and inserts at index 0, which is
        // upstream issue #41.
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);

        this._disposers.push(
            this._model.subscribe(state => {
                this._indicator.sync(state);
                this._toggle.sync(state);
            }),
        );

        // Rebuild when a preference that changes what is listed moves.
        for (const key of [KEYS.SHOW_OFFLINE_NODES, KEYS.SHOW_MULLVAD]) {
            const id = this._settings.connect(`changed::${key}`, () =>
                this._toggle.sync(this._model.state),
            );
            this._disposers.push(() => this._settings.disconnect(id));
        }

        this._bindKeybinding();

        this._indicator.sync(this._model.state);
        this._toggle.sync(this._model.state);
    }

    /** Register the shortcut that opens the menu. */
    _bindKeybinding() {
        // addKeybinding returns NONE when Mutter refuses the accelerator,
        // which happens when something else already claims it. Recording a key
        // that was never registered makes disable() call removeKeybinding on
        // it, and the Shell warns.
        const action = Main.wm.addKeybinding(
            SHORTCUT_KEYS.OPEN_MENU,
            this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._openMenu(),
        );

        if (action === Meta.KeyBindingAction.NONE) {
            console.warn(`[quickts] could not bind ${SHORTCUT_KEYS.OPEN_MENU}`);
            return;
        }

        this._bindings.push(SHORTCUT_KEYS.OPEN_MENU);
    }

    /** Open quick settings with this tile's menu expanded. */
    _openMenu() {
        const quickSettings = Main.panel.statusArea.quickSettings;

        // The same guard js/ui/panel.js applies before toggling: the tile is
        // not there to open during the lock screen or the login greeter.
        if (!quickSettings?.mapped || !quickSettings.reactive) return;

        if (!quickSettings.menu.isOpen) Main.panel.toggleQuickSettings();

        this._toggle.menu.open(BoxPointer.PopupAnimation.FULL);
    }

    /** Release everything. */
    disable() {
        for (const key of this._bindings) Main.wm.removeKeybinding(key);
        this._bindings = [];

        for (const dispose of this._disposers) dispose();
        this._disposers = [];

        this._toggle?.destroy();
        this._toggle = null;

        this._indicator?.destroy();
        this._indicator = null;
    }
}

/**
 * The subtitle text for a state.
 *
 * modules/health.js decides what the subtitle is about; the wording is chosen
 * here, where gettext is available and a translator can see whole sentences
 * rather than fragments.
 *
 * @param {object} state A snapshot.
 * @returns {string} A subtitle.
 */
function subtitleFor(state) {
    const { kind, value } = summaryOf(state);

    switch (kind) {
        case SUMMARY.ERROR:
            return _(problemOf(state)?.message ?? 'Not connected');
        case SUMMARY.NEEDS_LOGIN:
            return _('Not logged in');
        case SUMMARY.IN_USE:
            return _('In use by another user');
        case SUMMARY.STARTING:
            return _('Connecting…');
        case SUMMARY.OFF:
            return _('Off');
        case SUMMARY.EXIT_NODE:
            return _('via %s').replace('%s', String(value));
        case SUMMARY.WARNINGS:
            return _n('%d warning', '%d warnings', value).replace('%d', String(value));
        default:
            return String(value ?? '');
    }
}

/**
 * The shell command inside a message, if it names one.
 *
 * @param {string} message A message from modules/errors.js.
 * @returns {string} The command, or the whole message.
 */
function commandIn(message) {
    const match = /Run:\s*(.+)$/.exec(message);
    return match ? match[1].trim() : message;
}

/**
 * Put text on both clipboards and say so.
 *
 * Both, because X11 applications paste from PRIMARY with the middle button
 * while everything else uses CLIPBOARD, and a person who has just copied an
 * address does not want to think about which.
 *
 * @param {string} text What to copy.
 * @param {object} gicon Icon for the confirmation.
 */
function copyText(text, gicon) {
    if (!text) return;

    const clipboard = St.Clipboard.get_default();
    clipboard.set_text(St.ClipboardType.CLIPBOARD, text);
    clipboard.set_text(St.ClipboardType.PRIMARY, text);

    // GNOME 49 changed OsdWindowManager: show() now takes (icon, label,
    // levels) and showOne() is the call js/ui/windowManager.js itself uses for
    // a text OSD. The replaced extension calls the pre-49 five-argument form
    // and passes -1 where an icon belongs.
    Main.osdWindowManager.showOne(
        Main.layoutManager.primaryIndex,
        gicon,
        _('Copied %s').replace('%s', text),
    );
}
