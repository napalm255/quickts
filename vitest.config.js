import { defineConfig } from 'vitest/config';

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
});
