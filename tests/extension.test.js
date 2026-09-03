import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDaemon, createScheduler, createClock } from './support/daemon.js';
import { createSettings } from './support/world.js';

/*
 * The one place in this suite that mocks a module rather than injecting a
 * fake, and it needs the justification.
 *
 * extension.js imports modules/io.js, which imports gi://Soup — and
 * vitest.config.js deliberately has no alias for Soup, because needing one
 * would mean a decision had leaked into the transport. Mocking io.js keeps
 * that tripwire armed while still letting the wiring be tested.
 *
 * It is also the right level: extension.js has no logic of its own. What is
 * worth asserting is that it builds the three pieces, hands each the same
 * token, and tears them down in an order where nothing in flight can touch
 * something already gone.
 */
const disposed = [];
const chooseCalls = [];
let ioToken = null;

async function load() {
    vi.resetModules();
    disposed.length = 0;
    chooseCalls.length = 0;
    ioToken = null;

    const daemon = createDaemon();
    const clock = createClock();
    const { scheduler } = createScheduler(daemon.token, clock);

    vi.doMock('../modules/io.js', () => ({
        createIo: ({ token }) => {
            ioToken = token;
            return {
                socket: '/run/tailscale/tailscaled.sock',
                client: daemon.client,
                scheduler,
                chooseFiles: options => {
                    chooseCalls.push(options);
                    return Promise.resolve(['file:///chosen.txt']);
                },
                dispose: () => disposed.push('io'),
            };
        },
    }));

    // Imported after resetModules, not at the top of the file. The reset gives
    // extension.js a fresh copy of every module it pulls in, including the
    // stubs — so a statically imported Main here would be a different instance
    // from the one the panel actually records into, and every assertion would
    // read an empty stub.
    const Main = await import('./stubs/shell-main.js');
    const { resetActors } = await import('./support/actors.js');
    Main.reset();
    resetActors();

    const { default: QuickTSExtension } = await import('../extension.js');
    const extension = new QuickTSExtension({ 'version-name': '9.9.9' });
    extension.settings = createSettings();

    return { extension, daemon, Main };
}

const settle = async (turns = 12) => {
    for (let i = 0; i < turns; i += 1)
        await new Promise(resolve => setTimeout(resolve, 0));
};

beforeEach(() => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('../modules/io.js');
    vi.resetModules();
});

describe('QuickTSExtension', () => {
    it('puts a tile in the panel when enabled', async () => {
        const { extension, Main } = await load();

        extension.enable();
        await settle();

        expect(Main.externalIndicators).toHaveLength(1);
        extension.disable();
    });

    // scripts/headless-check.sh greps for this line, so the prefix is a
    // contract with that script rather than a nicety.
    it('logs the marker the headless check greps for', async () => {
        const { extension } = await load();

        extension.enable();

        expect(console.debug).toHaveBeenCalledWith('[quickts] enabled (v9.9.9)');
        extension.disable();
    });

    it('survives metadata with no version', async () => {
        const { extension } = await load();
        extension.metadata = {};

        extension.enable();

        expect(console.debug).toHaveBeenCalledWith('[quickts] enabled (v?)');
        extension.disable();
    });

    // Every piece must share one token, or cancelling would only reach some of
    // them and the rest would keep running against a torn-down transport.
    it('gives the transport the same token it cancels', async () => {
        const { extension } = await load();

        extension.enable();
        expect(ioToken.cancelled).toBe(false);

        extension.disable();

        expect(ioToken.cancelled).toBe(true);
    });

    it('disposes the transport', async () => {
        const { extension } = await load();

        extension.enable();
        extension.disable();

        expect(disposed).toEqual(['io']);
    });

    it('releases the keybinding and the tile', async () => {
        const { extension, Main } = await load();

        extension.enable();
        await settle();
        extension.disable();

        expect(Main.removeCalls).toEqual(['open-menu']);
    });

    // The shape scripts/headless-check.sh exercises against a real Shell.
    it('can be enabled, disabled and enabled again', async () => {
        const { extension, Main } = await load();

        extension.enable();
        await settle();
        extension.disable();
        extension.enable();
        await settle();

        expect(Main.addCalls).toEqual(['open-menu', 'open-menu']);
        expect(Main.externalIndicators).toHaveLength(2);

        extension.disable();
    });

    // The panel cannot import io.js — it has no business knowing there is a
    // transport — so the file chooser reaches it as an injected function.
    // That hand-off is the one piece of wiring with a body rather than a
    // reference, so it is worth proving it actually reaches the portal.
    it('routes the panel file chooser through the transport', async () => {
        const { extension } = await load();
        extension.enable();
        await settle();

        const chosen = await extension._panel._chooseFiles({ title: 'Send to laptop' });

        expect(chooseCalls).toEqual([{ title: 'Send to laptop' }]);
        expect(chosen).toEqual(['file:///chosen.txt']);

        extension.disable();
    });

    it('tolerates disable without enable', async () => {
        const { extension } = await load();

        expect(() => extension.disable()).not.toThrow();
    });

    it('tolerates being disabled twice', async () => {
        const { extension } = await load();
        extension.enable();
        extension.disable();

        expect(() => extension.disable()).not.toThrow();
    });

    it('drops every reference on disable', async () => {
        const { extension } = await load();

        extension.enable();
        await settle();
        extension.disable();

        expect(extension._token).toBeNull();
        expect(extension._io).toBeNull();
        expect(extension._model).toBeNull();
        expect(extension._panel).toBeNull();
    });
});
