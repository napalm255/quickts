// resource:///org/gnome/shell/extensions/extension.js, as far as extension.js uses it.

export class Extension {
    constructor(metadata = { 'version-name': '0.0.0' }) {
        this.metadata = metadata;
        this.path = '/nonexistent/quickts';
        this.settings = null;
    }

    getSettings() {
        return this.settings;
    }
}
