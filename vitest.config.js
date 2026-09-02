import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const stub = name =>
    fileURLToPath(new URL(`./tests/stubs/${name}.js`, import.meta.url));

export default defineConfig({
    test: {
        include: ['tests/**/*.test.js'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'lcov'],
            // Everything the extension ships, so the denominator is the real
            // one. Listing only the modules that happen to be covered would
            // measure coverage against a figure chosen to flatter it.
            include: ['modules/**/*.js', 'extension.js', 'prefs.js'],
            // Two exceptions, both for the same reason: what is left in them
            // after the decisions were moved out is toolkit construction, which
            // a unit test can only assert against a stub of the toolkit — that
            // tests the stub, not the code.
            //
            //   prefs.js       Adw and Gtk widget building. The rules it used
            //                  to hold live in modules/shortcuts.js.
            //   modules/io.js  Soup and Gio plumbing. Every URL, body, delay
            //                  and retry decision lives in modules/localapi.js,
            //                  modules/timing.js and modules/reconnect.js and
            //                  is tested there. io.js is covered instead by
            //                  scripts/localapi-check.sh, which runs it under
            //                  plain gjs against the real tailscaled — the only
            //                  check that catches Tailscale changing its JSON.
            //
            // Kept identical to sonar.coverage.exclusions so the two agree.
            exclude: ['prefs.js', 'modules/io.js'],
        },
    },

    // gnome-shell resolves these at runtime; Node cannot. Pointing them at
    // stubs is what makes the actor layer reachable from Vitest at all. The
    // stubs live in tests/, so they never ship and are never counted as
    // covered code.
    //
    // gi://Soup is deliberately absent. Nothing under test imports it, because
    // only modules/io.js does and that file is excluded above. The day this
    // list needs a Soup entry is the day a decision has leaked into the
    // transport, and the missing alias is how we find out.
    resolve: {
        alias: [
            { find: 'gi://Clutter', replacement: stub('gi-clutter') },
            { find: 'gi://Gio', replacement: stub('gi-gio') },
            { find: 'gi://GLib', replacement: stub('gi-glib') },
            { find: 'gi://GObject', replacement: stub('gi-gobject') },
            { find: 'gi://Meta', replacement: stub('gi-meta') },
            { find: 'gi://Shell', replacement: stub('gi-shell') },
            { find: 'gi://St', replacement: stub('gi-st') },
            {
                find: 'resource:///org/gnome/shell/ui/boxpointer.js',
                replacement: stub('shell-boxpointer'),
            },
            {
                find: 'resource:///org/gnome/shell/ui/main.js',
                replacement: stub('shell-main'),
            },
            {
                find: 'resource:///org/gnome/shell/ui/popupMenu.js',
                replacement: stub('shell-popupmenu'),
            },
            {
                find: 'resource:///org/gnome/shell/ui/quickSettings.js',
                replacement: stub('shell-quicksettings'),
            },
            {
                find: 'resource:///org/gnome/shell/extensions/extension.js',
                replacement: stub('shell-extension'),
            },
        ],
    },
});
