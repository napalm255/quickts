// Assert that one icon file actually decodes.
//
// Run by scripts/pack-check.sh over everything in icons/. It exists because an
// icon that fails to load is completely silent: gnome-shell draws nothing and
// logs nothing, so the first report is a person saying "there is no icon".
//
// The failure that prompted it was a long XML comment before the <svg>
// element, which defeats gdk-pixbuf's format sniffing.

import GdkPixbuf from 'gi://GdkPixbuf';

const path = ARGV[0];

if (!path) {
    printerr('usage: icon-check.js <file.svg>');
    imports.system.exit(2);
}

try {
    const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_size(path, 16, 16);
    const pixels = pixbuf.get_pixels();
    const channels = pixbuf.get_n_channels();

    let visible = 0;
    for (let i = 0; i < pixels.length; i += channels)
        if (channels < 4 || pixels[i + 3] > 32) visible += 1;

    // A file that parses but draws nothing is as useless as one that does not
    // parse, and just as silent.
    if (visible === 0) {
        printerr(`${path}: decodes but draws nothing`);
        imports.system.exit(1);
    }

    print(`${path}: ok (${visible} visible pixels at 16x16)`);
} catch (error) {
    printerr(`${path}: ${error}`);
    imports.system.exit(1);
}
