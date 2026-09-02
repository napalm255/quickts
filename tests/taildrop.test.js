import { describe, expect, it } from 'vitest';

import {
    TAILDROP,
    canReceive,
    fileNameOf,
    hasEligibleTarget,
    reasonFor,
    sendTargets,
} from '../modules/taildrop.js';

const node = (id, name, taildropTarget = TAILDROP.AVAILABLE) => ({
    id,
    name,
    taildropTarget,
});

const target = id => ({ Node: { StableID: id } });

describe('reasonFor', () => {
    it('gives an available node nothing to explain', () => {
        expect(reasonFor(TAILDROP.AVAILABLE)).toBe('');
    });

    // All ten wire values must map to something a person can read; a status
    // the daemon adds later must not render as blank.
    it('explains every status the daemon can report', () => {
        for (const status of Object.values(TAILDROP))
            if (status !== TAILDROP.AVAILABLE) expect(reasonFor(status)).toMatch(/\S/);
    });

    it('explains a status it has never seen', () => {
        expect(reasonFor(99)).toMatch(/\S/);
    });

    it.each([
        [TAILDROP.OFFLINE, 'Offline'],
        [TAILDROP.OWNED_BY_OTHER_USER, 'Owned by another user'],
        [TAILDROP.UNSUPPORTED_OS, 'Not supported on that system'],
    ])('names status %i correctly', (status, reason) => {
        expect(reasonFor(status)).toBe(reason);
    });
});

describe('canReceive', () => {
    it('accepts only the available status', () => {
        expect(canReceive(node('a', 'a'))).toBe(true);
        expect(canReceive(node('a', 'a', TAILDROP.OFFLINE))).toBe(false);
    });

    it.each([
        ['null', null],
        ['undefined', undefined],
        ['a node with no status', {}],
    ])('rejects %s', (_reason, value) => {
        expect(canReceive(value)).toBe(false);
    });
});

describe('sendTargets', () => {
    // Using file-targets alone silently drops most of the tailnet; using the
    // peer status alone offers sends the daemon will refuse. Both must agree.
    it('marks a node eligible only when both sources agree', () => {
        const rows = sendTargets(
            [node('a', 'alpha'), node('b', 'bravo', TAILDROP.OFFLINE)],
            [target('a'), target('b')],
        );

        expect(rows.find(row => row.node.id === 'a').eligible).toBe(true);
        expect(rows.find(row => row.node.id === 'b').eligible).toBe(false);
    });

    it('does not offer a node the daemon left out of file-targets', () => {
        const rows = sendTargets([node('a', 'alpha')], []);

        expect(rows.at(0).eligible).toBe(false);
        expect(rows.at(0).reason).toMatch(/\S/);
    });

    it('gives every ineligible node a reason', () => {
        const rows = sendTargets(
            [
                node('a', 'alpha', TAILDROP.OFFLINE),
                node('b', 'bravo', TAILDROP.MISSING_CAP),
            ],
            [],
        );

        expect(rows.every(row => row.reason !== '')).toBe(true);
    });

    it('gives an eligible node no reason', () => {
        const rows = sendTargets([node('a', 'alpha')], [target('a')]);

        expect(rows.at(0).reason).toBe('');
    });

    // Otherwise the half of the list that can be used is buried under a
    // tailnet's worth of sleeping laptops.
    it('puts the eligible nodes first', () => {
        const rows = sendTargets(
            [node('a', 'alpha', TAILDROP.OFFLINE), node('z', 'zulu')],
            [target('z')],
        );

        expect(rows.map(row => row.node.name)).toEqual(['zulu', 'alpha']);
    });

    it('sorts by name within each half', () => {
        const rows = sendTargets(
            [node('c', 'charlie'), node('a', 'alpha'), node('b', 'bravo')],
            [target('a'), target('b'), target('c')],
        );

        expect(rows.map(row => row.node.name)).toEqual(['alpha', 'bravo', 'charlie']);
    });

    it.each([
        ['null nodes', null, [target('a')]],
        ['null targets', [node('a', 'alpha')], null],
        ['both null', null, null],
        ['a malformed target', [node('a', 'alpha')], [{}, { Node: null }]],
    ])('survives %s', (_reason, nodes, targets) => {
        expect(() => sendTargets(nodes, targets)).not.toThrow();
    });
});

describe('hasEligibleTarget', () => {
    it('is true when something can receive', () => {
        expect(hasEligibleTarget(sendTargets([node('a', 'a')], [target('a')]))).toBe(
            true,
        );
    });

    // The submenu hides itself rather than offering a list of things that
    // cannot be done.
    it('is false when nothing can', () => {
        expect(hasEligibleTarget(sendTargets([node('a', 'a')], []))).toBe(false);
    });

    it.each([
        ['null', null],
        ['an empty list', []],
    ])('is false for %s', (_reason, targets) => {
        expect(hasEligibleTarget(targets)).toBe(false);
    });
});

describe('fileNameOf', () => {
    it('takes the last path segment', () => {
        expect(fileNameOf('file:///home/someone/notes.txt')).toBe('notes.txt');
    });

    it('decodes what the portal encoded', () => {
        expect(fileNameOf('file:///home/someone/my%20notes.txt')).toBe('my notes.txt');
    });

    // The last point at which a path could present as something other than a
    // name. modules/localapi.js percent-encodes what comes out of here, but
    // stripping the directories means there is nothing to encode away.
    it.each([
        ['a deep path', 'file:///a/b/c/d.txt', 'd.txt'],
        ['a trailing slash', 'file:///a/b/', 'b'],
        ['traversal', 'file:///a/../../etc/passwd', 'passwd'],
        ['an encoded slash', 'file:///a/b%2Fc.txt', 'c.txt'],
    ])('reduces %s to a bare name', (_reason, uri, name) => {
        expect(fileNameOf(uri)).toBe(name);
    });

    it.each([
        ['an empty string', ''],
        ['just the scheme', 'file:///'],
        ['null', null],
        ['undefined', undefined],
    ])('falls back to a usable name for %s', (_reason, uri) => {
        expect(fileNameOf(uri)).toBe('file');
    });
});
