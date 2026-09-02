import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { REASON } from '../modules/errors.js';
import { Panel } from '../modules/panel.js';
import { KEYS, SHORTCUT_KEYS } from '../modules/settings.js';
import { BACKEND } from '../modules/state.js';
import { rawPeer, rawPeerMap, SUFFIX } from './fixtures/peers.js';
import { clipboard, resetSt, themeContext } from './stubs/gi-st.js';
import { launchedUris, resetGio } from './stubs/gi-gio.js';
import * as Main from './stubs/shell-main.js';
import { descendants, liveHandlers, resetActors } from './support/actors.js';
import { createClock, createDaemon, createScheduler } from './support/daemon.js';
import { createSettings } from './support/world.js';
import { TailscaleModel } from '../modules/model.js';

/** Build a panel over a fake daemon, ready to enable. */
function setup({ seed, settings = createSettings(), chooseFiles } = {}) {
    const daemon = createDaemon(seed);
    const clock = createClock();
    const { scheduler } = createScheduler(daemon.token, clock);
    const model = new TailscaleModel({
        client: daemon.client,
        scheduler,
        token: daemon.token,
        now: clock.now,
    });
    const chosen = { calls: [], uris: [] };
    const panel = new Panel({
        model,
        settings,
        iconPath: '/nonexistent/quickts/icons/quickts-symbolic.svg',
        gettext: message => message,
        chooseFiles:
            chooseFiles ??
            (options => {
                chosen.calls.push(options);
                return Promise.resolve(chosen.uris);
            }),
    });

    return { daemon, model, panel, settings, clock, chosen };
}

/** The toggle a test wants to poke. */
const toggleOf = () =>
    Main.externalIndicators.at(-1).indicator.quickSettingsItems.at(0);

/** Every menu item anywhere under the toggle, by its text. */
const rowsNamed = (toggle, text) =>
    descendants(toggle.menu).filter(item => item.text === text);

const settle = async (turns = 12) => {
    for (let i = 0; i < turns; i += 1)
        await new Promise(resolve => setTimeout(resolve, 0));
};

beforeEach(() => {
    Main.reset();
    resetActors();
    resetSt();
    resetGio();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('placement', () => {
    // The supported API, which puts the tile where the Shell wants it relative
    // to brightness and background apps. Upstream reaches into _indicators and
    // inserts at index 0, which is upstream issue #41.
    it('uses addExternalIndicator', () => {
        const { panel } = setup();
        panel.enable();

        expect(Main.externalIndicators).toHaveLength(1);
        expect(toggleOf()).toBeTruthy();
    });
});

describe('the tile', () => {
    it('is checked while the tailnet is up', async () => {
        const { panel, model } = setup();
        panel.enable();
        await model.start();
        await settle();

        expect(toggleOf().checked).toBe(true);
    });

    // WantRunning stays true across a logout, so a toggle driven by the
    // preference alone sits there showing "on" against a dead backend.
    it('is unchecked when the backend needs a login', async () => {
        const { panel, model, daemon } = setup();
        daemon.responses.status.BackendState = BACKEND.NEEDS_LOGIN;
        panel.enable();
        await model.start();
        await settle();

        expect(toggleOf().checked).toBe(false);
        expect(toggleOf().subtitle).toBe('Not logged in');
    });

    it('names the exit node in its subtitle', async () => {
        const { panel, model, daemon } = setup();
        daemon.responses.prefs.ExitNodeID = 'nSOMEID1CNTRL';
        panel.enable();
        await model.start();
        await settle();

        expect(toggleOf().subtitle).toBe('via laptop');
    });

    it('reports an unreachable daemon in its subtitle', async () => {
        const { panel, model, daemon } = setup();
        daemon.failures.set('/localapi/v0/prefs', {
            name: 'TransportError',
            reason: REASON.PERMISSION_DENIED,
        });
        panel.enable();
        await model.start();
        await settle();

        expect(toggleOf().subtitle).toContain('tailscale set --operator=');
    });

    it('brings the tailnet down when clicked while up', async () => {
        const { panel, model, daemon } = setup();
        panel.enable();
        await model.start();
        await settle();

        toggleOf().click();
        await settle();

        expect(daemon.patches.at(-1)).toMatchObject({ WantRunning: false });
    });

    // Flipping WantRunning against a backend waiting for a login does nothing
    // a person would notice; starting the login is what they were asking for.
    it('starts a login when clicked while logged out', async () => {
        const { panel, model, daemon } = setup();
        daemon.responses.status.BackendState = BACKEND.NEEDS_LOGIN;
        panel.enable();
        await model.start();
        await settle();
        daemon.reset();

        toggleOf().click();
        await settle();

        expect(daemon.paths).toContain('/localapi/v0/login-interactive');
    });
});

describe('problems and warnings', () => {
    it('shows a health warning', async () => {
        const { panel, model, daemon } = setup();
        daemon.responses.status.Health = ['Some peers are advertising routes'];
        panel.enable();
        await model.start();
        await settle();

        expect(rowsNamed(toggleOf(), 'Some peers are advertising routes')).toHaveLength(
            1,
        );
    });

    it('offers a login row when the backend needs one', async () => {
        const { panel, model, daemon } = setup();
        daemon.responses.status.BackendState = BACKEND.NEEDS_LOGIN;
        panel.enable();
        await model.start();
        await settle();
        daemon.reset();

        rowsNamed(toggleOf(), 'Log in…').at(0).activate();
        await settle();

        expect(daemon.paths).toContain('/localapi/v0/login-interactive');
    });

    // The fix a person cannot otherwise discover: upstream logs the 403 to the
    // journal and draws an empty menu.
    it('copies the operator command from an actionable problem', async () => {
        const { panel, model, daemon } = setup();
        daemon.failures.set('/localapi/v0/prefs', {
            name: 'TransportError',
            reason: REASON.PERMISSION_DENIED,
        });
        panel.enable();
        await model.start();
        await settle();

        const row = descendants(toggleOf().menu).find(item =>
            item.text?.includes('tailscale set --operator='),
        );
        row.activate();

        expect(clipboard.CLIPBOARD).toBe('sudo tailscale set --operator=$USER');
    });
});

describe('devices', () => {
    it('lists the peers', async () => {
        const { panel, model } = setup();
        panel.enable();
        await model.start();
        await settle();

        expect(rowsNamed(toggleOf(), 'laptop')).not.toHaveLength(0);
    });

    it('copies the address when a device is activated', async () => {
        const { panel, model } = setup();
        panel.enable();
        await model.start();
        await settle();

        toggleOf()._devices.menu.items.at(0).activate();

        expect(clipboard.CLIPBOARD).toBe('100.64.0.1');
        expect(clipboard.PRIMARY).toBe('100.64.0.1');
        expect(Main.osdMessages).toHaveLength(1);
    });

    // Clutter.ClickAction and Clutter.LongPressState do not exist in Clutter
    // 18; the extension QuickTS replaces builds both and throws on GNOME 49
    // and later. The stub offers neither, so this can only pass by using the
    // gesture API that does exist.
    it('copies the DNS name on a long press', async () => {
        const { panel, model } = setup();
        panel.enable();
        await model.start();
        await settle();

        const row = toggleOf()._devices.menu.items.at(0);
        row.actions.at(0).recognize();

        expect(clipboard.CLIPBOARD).toBe(`laptop.${SUFFIX}`);
    });

    it('hides offline devices when the preference says so', async () => {
        const settings = createSettings({ [KEYS.SHOW_OFFLINE_NODES]: false });
        const { panel, model, daemon } = setup({ settings });
        daemon.responses.status.Peer = rawPeerMap(rawPeer({ Online: false }));
        panel.enable();
        await model.start();
        await settle();

        expect(rowsNamed(toggleOf(), 'No devices')).toHaveLength(1);
    });

    it('rebuilds when the preference changes', async () => {
        const settings = createSettings();
        const { panel, model, daemon } = setup({ settings });
        daemon.responses.status.Peer = rawPeerMap(rawPeer({ Online: false }));
        panel.enable();
        await model.start();
        await settle();

        expect(rowsNamed(toggleOf(), 'laptop')).not.toHaveLength(0);

        settings.set_boolean(KEYS.SHOW_OFFLINE_NODES, false);

        expect(rowsNamed(toggleOf(), 'laptop')).toHaveLength(0);
    });

    it('does not offer to copy an address a peer has not got', async () => {
        const { panel, model, daemon } = setup();
        daemon.responses.status.Peer = rawPeerMap(rawPeer({ TailscaleIPs: null }));
        panel.enable();
        await model.start();
        await settle();

        expect(toggleOf()._devices.menu.items.at(0).sensitive).toBe(false);
    });
});

describe('the exit node picker', () => {
    const withGateway = () => ({
        status: {
            BackendState: 'Running',
            AuthURL: '',
            Health: [],
            MagicDNSSuffix: SUFFIX,
            CurrentTailnet: { Name: 'example@example.com' },
            Self: { HostName: 'desktop', TailscaleIPs: ['100.64.0.9'] },
            Peer: rawPeerMap(
                rawPeer({
                    ID: 'nGATE',
                    DNSName: `gateway.${SUFFIX}.`,
                    ExitNodeOption: true,
                }),
                rawPeer(),
            ),
        },
    });

    it('offers only nodes that can be exit nodes', async () => {
        const { panel, model } = setup({ seed: withGateway() });
        panel.enable();
        await model.start();
        await settle();

        const labels = toggleOf()._exitNode.menu.items.map(item => item.text);

        expect(labels).toContain('gateway');
        expect(labels).not.toContain('laptop');
    });

    it('selects an exit node', async () => {
        const { panel, model, daemon } = setup({ seed: withGateway() });
        panel.enable();
        await model.start();
        await settle();

        toggleOf()
            ._exitNode.menu.items.find(item => item.text === 'gateway')
            .activate();
        await settle();

        expect(daemon.patches.at(-1)).toMatchObject({ ExitNodeID: 'nGATE' });
    });

    // The same row both sets and unsets, so no separate "stop" control is
    // needed and there is no state in which one is shown and the other is not.
    it('clears the exit node by selecting it again', async () => {
        const seed = withGateway();
        const { panel, model, daemon } = setup({ seed });
        daemon.responses.prefs.ExitNodeID = 'nGATE';
        panel.enable();
        await model.start();
        await settle();

        toggleOf()
            ._exitNode.menu.items.find(item => item.text === 'gateway')
            .activate();
        await settle();

        expect(daemon.patches.at(-1)).toMatchObject({ ExitNodeID: '' });
    });

    it('offers None', async () => {
        const { panel, model, daemon } = setup({ seed: withGateway() });
        daemon.responses.prefs.ExitNodeID = 'nGATE';
        panel.enable();
        await model.start();
        await settle();

        toggleOf()._exitNode.menu.items.at(0).activate();
        await settle();

        expect(daemon.patches.at(-1)).toMatchObject({ ExitNodeID: '' });
    });
});

describe('the settings switches', () => {
    it('reflect the preferences', async () => {
        const { panel, model, daemon } = setup();
        daemon.responses.prefs.ShieldsUp = true;
        panel.enable();
        await model.start();
        await settle();

        const shields = rowsNamed(toggleOf(), 'Block incoming').at(0);

        expect(shields.state).toBe(true);
    });

    it('apply a change', async () => {
        const { panel, model, daemon } = setup();
        panel.enable();
        await model.start();
        await settle();

        rowsNamed(toggleOf(), 'Accept routes').at(0).toggle();
        await settle();

        expect(daemon.patches.at(-1)).toMatchObject({ RouteAll: true });
    });

    // Built once rather than rebuilt, so toggling one does not destroy the
    // actor the click is still travelling through.
    it('survive being toggled and re-synced', async () => {
        const { panel, model } = setup();
        panel.enable();
        await model.start();
        await settle();

        const before = rowsNamed(toggleOf(), 'Accept routes').at(0);
        before.toggle();
        await settle();

        expect(rowsNamed(toggleOf(), 'Accept routes').at(0)).toBe(before);
        expect(before.destroyed).toBe(false);
    });
});

describe('profiles', () => {
    it('are hidden when there is only one', async () => {
        const { panel, model } = setup();
        panel.enable();
        await model.start();
        await settle();

        expect(toggleOf()._profiles.visible).toBe(false);
    });

    it('are listed when there is more than one', async () => {
        const { panel, model, daemon } = setup();
        daemon.responses.profiles = [
            { ID: '1', Name: 'work', NetworkProfile: { DisplayName: 'WorkNet' } },
            { ID: '2', Name: 'home', NetworkProfile: { DomainName: 'home.example' } },
        ];
        panel.enable();
        await model.start();
        await settle();

        expect(toggleOf()._profiles.visible).toBe(true);
        expect(toggleOf()._profiles.menu.items.map(item => item.text)).toEqual([
            'work',
            'home',
        ]);
    });

    it('switch when activated', async () => {
        const { panel, model, daemon } = setup();
        daemon.responses.profiles = [
            { ID: '1', Name: 'work' },
            { ID: '2', Name: 'home' },
        ];
        panel.enable();
        await model.start();
        await settle();
        daemon.reset();

        toggleOf()._profiles.menu.items.at(1).activate();
        await settle();

        expect(daemon.paths).toContain('/localapi/v0/profiles/2');
    });
});

describe('menu height', () => {
    // The mechanism the Shell already has: PopupSubMenu._needsScrollbar reads
    // max-height off the top menu's theme node. Upstream hardcodes a height
    // and overwrites _needsScrollbar instead, which is upstream issue #11.
    it('sets a max-height the theme node reports back', async () => {
        const { panel, model } = setup();
        panel.enable();
        await model.start();
        await settle();

        toggleOf().menu.open();

        expect(toggleOf().menu.actor.get_theme_node().get_max_height()).toBeGreaterThan(
            0,
        );
    });

    it('accounts for the scale factor', async () => {
        const { panel, model } = setup();
        panel.enable();
        await model.start();
        await settle();

        toggleOf().menu.open();
        const atOne = toggleOf().menu.actor.get_theme_node().get_max_height();

        themeContext.scale_factor = 2;
        toggleOf().menu.close();
        toggleOf().menu.open();

        expect(toggleOf().menu.actor.get_theme_node().get_max_height()).toBeLessThan(
            atOne,
        );
    });

    it('honours the configured ceiling', async () => {
        const settings = createSettings({ [KEYS.MAX_MENU_HEIGHT]: 300 });
        const { panel, model } = setup({ settings });
        panel.enable();
        await model.start();
        await settle();

        toggleOf().menu.open();

        expect(toggleOf().menu.actor.get_theme_node().get_max_height()).toBe(300);
    });

    it('tells the model when the menu opens and closes', async () => {
        const { panel, model } = setup();
        const setMenuOpen = vi.spyOn(model, 'setMenuOpen');
        panel.enable();
        await model.start();
        await settle();

        toggleOf().menu.open();
        toggleOf().menu.close();

        expect(setMenuOpen).toHaveBeenCalledWith(true);
        expect(setMenuOpen).toHaveBeenCalledWith(false);
    });
});

describe('the keybinding', () => {
    it('is registered once per enable', () => {
        const { panel } = setup();
        panel.enable();

        expect(Main.addCalls).toEqual([SHORTCUT_KEYS.OPEN_MENU]);
    });

    it('opens the menu', async () => {
        const { panel, model } = setup();
        panel.enable();
        await model.start();
        await settle();

        Main.press(SHORTCUT_KEYS.OPEN_MENU);

        expect(Main.quickSettingsToggles).toHaveLength(1);
        expect(toggleOf().menu.isOpen).toBe(true);
    });

    // The same guard js/ui/panel.js applies: the tile is not there to open
    // during the lock screen or the greeter.
    it('does nothing while the panel is not interactive', async () => {
        const { panel, model } = setup();
        panel.enable();
        await model.start();
        await settle();
        Main.panel.statusArea.quickSettings.reactive = false;

        Main.press(SHORTCUT_KEYS.OPEN_MENU);

        expect(Main.quickSettingsToggles).toHaveLength(0);
    });

    // Mutter returns NONE when the accelerator is already claimed. Recording
    // a key that was never registered makes disable() remove it and the Shell
    // warns.
    it('is not recorded when Mutter refuses it', () => {
        const { panel } = setup();
        Main.refuse.add(SHORTCUT_KEYS.OPEN_MENU);

        panel.enable();
        panel.disable();

        expect(Main.removeCalls).toEqual([]);
    });
});

describe('teardown', () => {
    it('releases the keybinding', () => {
        const { panel } = setup();
        panel.enable();
        panel.disable();

        expect(Main.removeCalls).toEqual([SHORTCUT_KEYS.OPEN_MENU]);
    });

    it('unsubscribes from the model', async () => {
        const { panel, model } = setup();
        panel.enable();
        await model.start();

        expect(model.subscriberCount).toBe(1);

        panel.disable();

        expect(model.subscriberCount).toBe(0);
    });

    it('disconnects from the settings', () => {
        const { panel, settings } = setup();
        panel.enable();

        expect(settings.connected.size).toBeGreaterThan(0);

        panel.disable();

        expect(settings.connected.size).toBe(0);
    });

    // The property the review guidelines require and upstream does not have:
    // every signal connected by the extension is disconnected in disable().
    it('leaves no signal handler connected', async () => {
        const { panel, model } = setup();
        panel.enable();
        await model.start();
        await settle();
        toggleOf().menu.open();

        panel.disable();

        expect(liveHandlers.size).toBe(0);
    });

    it('destroys its actors', () => {
        const { panel } = setup();
        panel.enable();
        const toggle = toggleOf();
        const indicator = Main.externalIndicators.at(-1).indicator;

        panel.disable();

        expect(toggle.destroyed).toBe(true);
        expect(indicator.destroyed).toBe(true);
    });

    // The shape of the bug headless-check.sh exists to catch: a second enable
    // must be as clean as the first.
    it('survives enable, disable and enable again', async () => {
        const { panel, model } = setup();

        panel.enable();
        await model.start();
        panel.disable();
        panel.enable();
        await settle();

        expect(Main.addCalls).toEqual([
            SHORTCUT_KEYS.OPEN_MENU,
            SHORTCUT_KEYS.OPEN_MENU,
        ]);
        expect(Main.externalIndicators).toHaveLength(2);

        panel.disable();

        expect(liveHandlers.size).toBe(0);
    });

    it('tolerates disable without enable', () => {
        const { panel } = setup();

        expect(() => panel.disable()).not.toThrow();
    });

    it('tolerates being disabled twice', () => {
        const { panel } = setup();
        panel.enable();
        panel.disable();

        expect(() => panel.disable()).not.toThrow();
    });
});

describe('login', () => {
    const loggedOut = daemon => {
        daemon.responses.status.BackendState = BACKEND.NEEDS_LOGIN;
        daemon.responses.status.AuthURL = 'https://login.tailscale.com/a/abc123';
    };

    it('opens the auth URL once a login is asked for', async () => {
        const { panel, model, daemon } = setup();
        loggedOut(daemon);
        panel.enable();
        await model.start();
        await settle();

        rowsNamed(toggleOf(), 'Log in…').at(0).activate();
        await settle();

        expect(launchedUris).toEqual(['https://login.tailscale.com/a/abc123']);
    });

    // The URL is in the state whenever the daemon is waiting for a login.
    // Opening a browser on that alone would hijack the session of anyone who
    // simply happens to be logged out when the Shell starts.
    it('does not open a browser unasked', async () => {
        const { panel, model, daemon } = setup();
        loggedOut(daemon);
        panel.enable();
        await model.start();
        await settle();

        expect(launchedUris).toEqual([]);
    });

    it('opens it only once', async () => {
        const { panel, model, daemon } = setup();
        loggedOut(daemon);
        panel.enable();
        await model.start();
        await settle();

        rowsNamed(toggleOf(), 'Log in…').at(0).activate();
        await settle();
        await model.refresh();
        await settle();

        expect(launchedUris).toHaveLength(1);
    });
});

describe('taildrop', () => {
    const withTarget = daemon => {
        daemon.responses.status.Peer = rawPeerMap(rawPeer({ TaildropTarget: 1 }));
        daemon.responses.fileTargets = [{ Node: { StableID: 'nSOMEID1CNTRL' } }];
    };

    it('is hidden when nothing can receive', async () => {
        const { panel, model } = setup();
        panel.enable();
        await model.start();
        await settle();

        toggleOf().menu.open();
        await settle();

        expect(toggleOf()._taildrop.visible).toBe(false);
    });

    it('lists a node that can receive', async () => {
        const { panel, model, daemon } = setup();
        withTarget(daemon);
        panel.enable();
        await model.start();
        await settle();

        toggleOf().menu.open();
        await settle();

        expect(toggleOf()._taildrop.visible).toBe(true);
        expect(toggleOf()._taildrop.menu.items.at(0).text).toBe('laptop');
    });

    // Greyed out with the daemon's own reason, rather than silently dropped —
    // which is what makes the difference between "that machine is asleep" and
    // "this extension is broken".
    it('shows an ineligible node with its reason', async () => {
        const { panel, model, daemon } = setup();
        withTarget(daemon);
        daemon.responses.status.Peer = rawPeerMap(
            rawPeer({ TaildropTarget: 1 }),
            rawPeer({ ID: 'nOFF', DNSName: `sleeper.${SUFFIX}.`, TaildropTarget: 5 }),
        );
        panel.enable();
        await model.start();
        await settle();

        toggleOf().menu.open();
        await settle();

        const row = toggleOf()._taildrop.menu.items.find(item =>
            item.text.startsWith('sleeper'),
        );

        expect(row.text).toContain('Offline');
        expect(row.sensitive).toBe(false);
    });

    it('asks for files and sends them', async () => {
        const { panel, model, daemon, chosen } = setup();
        withTarget(daemon);
        chosen.uris = ['file:///home/someone/notes.txt'];
        const putFile = vi.fn().mockResolvedValue(undefined);
        daemon.client.putFile = putFile;

        panel.enable();
        await model.start();
        await settle();
        toggleOf().menu.open();
        await settle();

        toggleOf()._taildrop.menu.items.at(0).activate();
        await settle();

        expect(chosen.calls).toHaveLength(1);
        expect(putFile).toHaveBeenCalledTimes(1);
        expect(putFile.mock.calls[0][0].path).toBe(
            '/localapi/v0/file-put/nSOMEID1CNTRL/notes.txt',
        );
        expect(Main.osdMessages).toHaveLength(1);
    });

    it('does nothing when the dialog is dismissed', async () => {
        const { panel, model, daemon, chosen } = setup();
        withTarget(daemon);
        chosen.uris = [];
        const putFile = vi.fn();
        daemon.client.putFile = putFile;

        panel.enable();
        await model.start();
        await settle();
        toggleOf().menu.open();
        await settle();

        toggleOf()._taildrop.menu.items.at(0).activate();
        await settle();

        expect(putFile).not.toHaveBeenCalled();
        expect(Main.osdMessages).toHaveLength(0);
    });

    it('reports the files it could not send', async () => {
        const { panel, model, daemon, chosen } = setup();
        withTarget(daemon);
        chosen.uris = ['file:///a/one.txt', 'file:///a/two.txt'];
        daemon.client.putFile = vi
            .fn()
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error('peer refused'));

        panel.enable();
        await model.start();
        await settle();
        toggleOf().menu.open();
        await settle();

        toggleOf()._taildrop.menu.items.at(0).activate();
        await settle();

        expect(Main.notifications.at(-1).kind).toBe('error');
        expect(Main.notifications.at(-1).details).toContain('two.txt');
    });

    // A disable while the request is in flight destroys the submenu; the
    // response must not then be written into a menu that no longer exists.
    it('survives being disabled while listing targets', async () => {
        const { panel, model, daemon } = setup();
        withTarget(daemon);
        panel.enable();
        await model.start();
        await settle();

        toggleOf().menu.open();
        panel.disable();

        await expect(settle()).resolves.toBeUndefined();
    });
});
