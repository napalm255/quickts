import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ALL_KEYS, KEYS, SETTINGS, SHORTCUT_KEYS } from '../modules/settings.js';

const SCHEMA = fileURLToPath(
    new URL(
        '../schemas/org.gnome.shell.extensions.quickts.gschema.xml',
        import.meta.url,
    ),
);

// SCHEMA is a module-relative constant resolved from import.meta.url, not
// input of any kind; the rule cannot see that it is not a variable path.
// eslint-disable-next-line security/detect-non-literal-fs-filename
const xml = readFileSync(SCHEMA, 'utf8');

/** Key name -> declared type, straight out of the gschema. */
const declared = new Map(
    [...xml.matchAll(/<key\s+type="([^"]+)"\s+name="([^"]+)">/g)].map(match => [
        match[2],
        match[1],
    ]),
);

// The point of this file. A preference that is configurable and inert, or one
// the menu reads and the schema has never heard of, is a bug that no other
// test can see: prefs.js writes it happily and modules/panel.js reads a
// default, and nothing anywhere fails.
describe('the settings list and the gschema', () => {
    it('agree on which keys exist', () => {
        expect([...declared.keys()].sort()).toEqual([...ALL_KEYS].sort());
    });

    it('agree on every type', () => {
        for (const setting of SETTINGS)
            expect(declared.get(setting.key)).toBe(setting.type);
    });

    it('describes every key it names', () => {
        for (const setting of SETTINGS) {
            expect(setting.label).toMatch(/\S/);
            expect(setting.detail).toMatch(/\S/);
        }
    });
});

describe('the schema itself', () => {
    it('is the id metadata.json points at', () => {
        const metadata = JSON.parse(
            // eslint-disable-next-line security/detect-non-literal-fs-filename
            readFileSync(
                fileURLToPath(new URL('../metadata.json', import.meta.url)),
                'utf8',
            ),
        );

        expect(xml).toContain(`id="${metadata['settings-schema']}"`);
        expect(SCHEMA).toContain(metadata['settings-schema']);
    });

    it('gives every key a summary and a description', () => {
        const keys = [...xml.matchAll(/<key\b[\s\S]*?<\/key>/g)].map(match => match[0]);

        expect(keys).toHaveLength(declared.size);
        for (const key of keys) {
            expect(key).toMatch(/<summary>[^<]*\S[^<]*<\/summary>/);
            expect(key).toMatch(/<description>[\s\S]*\S[\s\S]*<\/description>/);
        }
    });

    // Unbound on purpose. A single convenience shortcut is not worth the risk
    // of colliding with one of the accelerators GNOME already claims, and
    // prefs.js offers a capture field for choosing one.
    it('ships the shortcut unbound', () => {
        expect(SHORTCUT_KEYS.OPEN_MENU).toBe('open-menu');
        expect(xml).toMatch(/name="open-menu">\s*<default><!\[CDATA\[\[\]\]\]>/);
    });

    it('bounds the menu height', () => {
        expect(KEYS.MAX_MENU_HEIGHT).toBe('max-menu-height');
        expect(xml).toMatch(/name="max-menu-height">[\s\S]*?<range min="0"/);
    });
});
