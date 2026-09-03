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

// The Shell binds these to the extension's own gettext domain. The stub keeps
// them identity-like so a test reads the untranslated string it wrote.
export const gettext = message => message;
export const ngettext = (singular, plural, count) => (count === 1 ? singular : plural);
export const pgettext = (_context, message) => message;
