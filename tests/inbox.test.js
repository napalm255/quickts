import { describe, expect, it } from 'vitest';

import { formatSize, uniqueName, waitingFiles } from '../modules/inbox.js';

describe('waitingFiles', () => {
    it('reads the shape the daemon sends', () => {
        expect(
            waitingFiles([
                { Name: 'report.pdf', Size: 1024 },
                { Name: 'notes.txt', Size: 12 },
            ]),
        ).toEqual([
            { name: 'report.pdf', size: 1024 },
            { name: 'notes.txt', size: 12 },
        ]);
    });

    // The endpoint answers null, not [], when nothing is waiting.
    it.each([
        ['null', null],
        ['undefined', undefined],
        ['a non-array', {}],
    ])('returns nothing for %s', (_reason, files) => {
        expect(waitingFiles(files)).toEqual([]);
    });

    it('drops an entry with no usable name', () => {
        expect(waitingFiles([{ Name: '', Size: 1 }, { Size: 2 }, null])).toEqual([]);
    });

    it.each([
        ['a missing size', { Name: 'a', Size: undefined }],
        ['a negative size', { Name: 'a', Size: -5 }],
        ['a size that is not a number', { Name: 'a', Size: 'big' }],
    ])('treats %s as zero', (_reason, file) => {
        expect(waitingFiles([file]).at(0).size).toBe(0);
    });
});

describe('formatSize', () => {
    it.each([
        [0, '0 B'],
        [12, '12 B'],
        [999, '999 B'],
        [1000, '1.0 kB'],
        [1536, '1.5 kB'],
        [1_000_000, '1.0 MB'],
        [2_500_000_000, '2.5 GB'],
    ])('formats %i as %s', (bytes, expected) => {
        expect(formatSize(bytes)).toBe(expected);
    });

    it.each([
        ['a negative size', -1],
        ['a non-number', 'big'],
        ['undefined', undefined],
    ])('reports %s as nothing', (_reason, bytes) => {
        expect(formatSize(bytes)).toBe('0 B');
    });

    it('does not run past the largest unit', () => {
        expect(formatSize(Number.MAX_SAFE_INTEGER)).toMatch(/TB$/);
    });
});

describe('uniqueName', () => {
    const taken = (...names) => {
        const set = new Set(names);
        return name => set.has(name);
    };

    it('keeps a free name', () => {
        expect(uniqueName('report.pdf', taken())).toBe('report.pdf');
    });

    // Taildrop names come from whoever sent them, so two people can both send
    // "report.pdf" and a save that overwrites is a save that loses data.
    it('suffixes a taken name before the extension', () => {
        expect(uniqueName('report.pdf', taken('report.pdf'))).toBe('report (1).pdf');
    });

    it('counts up past several collisions', () => {
        expect(
            uniqueName(
                'report.pdf',
                taken('report.pdf', 'report (1).pdf', 'report (2).pdf'),
            ),
        ).toBe('report (3).pdf');
    });

    it('handles a name with no extension', () => {
        expect(uniqueName('README', taken('README'))).toBe('README (1)');
    });

    it('does not treat a leading dot as an extension', () => {
        expect(uniqueName('.bashrc', taken('.bashrc'))).toBe('.bashrc (1)');
    });

    it('uses the last dot', () => {
        expect(uniqueName('a.tar.gz', taken('a.tar.gz'))).toBe('a.tar (1).gz');
    });

    it('falls back for an empty name', () => {
        expect(uniqueName('', taken())).toBe('file');
    });

    // A directory answering "taken" to everything would otherwise hang the
    // Shell rather than fail a save.
    it('terminates against a predicate that never yields', () => {
        const result = uniqueName('a.txt', () => true);

        expect(typeof result).toBe('string');
        expect(result).not.toBe('a.txt');
    });
});
