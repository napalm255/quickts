// QuickTS — Tailscale in the GNOME quick settings menu.
//
// This file is deliberately thin. It owns the cancellation token and wires the
// three pieces together; every decision lives in a pure module under modules/.
//
// Nothing here runs at import time. Creating an object, connecting a signal or
// touching the Shell during module evaluation is forbidden by the review
// guidelines, and it is also how the extension QuickTS replaces ends up
// holding a reference to the quick settings panel across a disable.

import {
    Extension,
    gettext as _,
    ngettext,
} from 'resource:///org/gnome/shell/extensions/extension.js';

import { CancelToken } from './modules/cancel.js';
import { createIo } from './modules/io.js';
import { TailscaleModel } from './modules/model.js';
import { Panel } from './modules/panel.js';

export default class QuickTSExtension extends Extension {
    enable() {
        // One token for this enable. Cancelling it aborts every request in
        // flight, settles every pending wait and drops every GLib source —
        // see modules/io.js for why the last two have to happen together.
        this._token = new CancelToken();
        this._io = createIo({ token: this._token });

        this._model = new TailscaleModel({
            client: this._io.client,
            scheduler: this._io.scheduler,
            token: this._token,
        });

        this._panel = new Panel({
            model: this._model,
            settings: this.getSettings(),
            iconPath: `${this.path}/icons/quickts-symbolic.svg`,
            gettext: _,
            ngettext,
            // The file dialog is drawn by xdg-desktop-portal, out of process.
            // The review guidelines forbid Gtk or Adw in the Shell, so this is
            // not a preference among ways to pick a file — it is the only one.
            chooseFiles: options => this._io.chooseFiles(options),
        });

        this._panel.enable();
        void this._model.start();

        // scripts/headless-check.sh greps for this line; keep the prefix stable.
        console.debug(`[quickts] enabled (v${this.metadata['version-name'] ?? '?'})`);
    }

    disable() {
        // Ordered. Cancelling first means nothing in flight can touch anything
        // that the three teardowns below are about to take apart.
        this._token?.cancel();
        this._model?.destroy();
        this._panel?.disable();
        this._io?.dispose();

        this._token = null;
        this._io = null;
        this._model = null;
        this._panel = null;
    }
}
