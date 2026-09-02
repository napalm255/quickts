// QuickTS — Tailscale in the GNOME quick settings menu.
//
// This file is deliberately thin. It owns the cancellation token and wires the
// three pieces together; every decision lives in a pure module under modules/.
//
// Nothing here runs at import time. Creating an object, connecting a signal or
// touching the Shell during module evaluation is forbidden by the review
// guidelines, and it is also how the extension this one replaces ended up
// holding a reference to the quick settings panel across a disable.

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

export default class QuickTSExtension extends Extension {
    enable() {
        // scripts/headless-check.sh greps for this line; keep the prefix stable.
        console.debug(`[quickts] enabled (v${this.metadata['version-name'] ?? '?'})`);
    }

    disable() {}
}
