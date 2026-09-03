// Files other people have sent here.
//
// Taildrop's receiving half. The daemon buffers an incoming file and lists it
// at /localapi/v0/files/; retrieving it is a GET of that name and removing it
// is a DELETE, which is exactly what `tailscale file get` does. Nothing is
// saved until someone asks for it, so the daemon is the only place a file sits
// until then.
//
// This file imports nothing.

/**
 * Normalise the waiting-file list.
 *
 * The endpoint answers `null` rather than `[]` when nothing is waiting, which
 * is the shape that makes a caller reaching straight for .length throw.
 *
 * @param {object[]|null} files The /files/ response.
 * @returns {Array<{name: string, size: number}>} Waiting files, largest last.
 */
export function waitingFiles(files) {
    if (!Array.isArray(files)) return [];

    return files
        .filter(file => typeof file?.Name === 'string' && file.Name !== '')
        .map(file => ({
            name: file.Name,
            size: Number.isFinite(file.Size) && file.Size > 0 ? file.Size : 0,
        }));
}

/**
 * A file size a person can read.
 *
 * Decimal units, which is what every file manager on this desktop shows, so a
 * number here matches the number there.
 *
 * @param {number} bytes Size in bytes.
 * @returns {string} A short size, untranslated.
 */
export function formatSize(bytes) {
    const size = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
    const units = ['B', 'kB', 'MB', 'GB', 'TB'];

    let value = size;
    let unit = 0;
    while (value >= 1000 && unit < units.length - 1) {
        value /= 1000;
        unit += 1;
    }

    const rounded = unit === 0 ? String(Math.round(value)) : value.toFixed(1);

    return `${rounded} ${units.at(unit)}`;
}

/**
 * A file name that will not collide with something already there.
 *
 * Taildrop names come from whoever sent them, so two people can send
 * "report.pdf" and a save that overwrites is a save that loses data. The
 * suffix goes before the extension, the way every file manager does it.
 *
 * @param {string} name The name as sent.
 * @param {(candidate: string) => boolean} exists Whether a name is taken.
 * @returns {string} A free name.
 */
export function uniqueName(name, exists) {
    const safe = name === '' ? 'file' : name;
    if (!exists(safe)) return safe;

    const dot = safe.lastIndexOf('.');
    const stem = dot > 0 ? safe.slice(0, dot) : safe;
    const extension = dot > 0 ? safe.slice(dot) : '';

    // Bounded rather than while(true): a directory that answers "taken" to
    // everything would otherwise hang the Shell rather than fail a save.
    for (let n = 1; n < 1000; n += 1) {
        const candidate = `${stem} (${n})${extension}`;
        if (!exists(candidate)) return candidate;
    }

    return `${stem} (${Date.now()})${extension}`;
}
