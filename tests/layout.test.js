import { describe, expect, it } from 'vitest';

import { MIN_MENU_HEIGHT, maxHeightStyle, menuMaxHeight } from '../modules/layout.js';

// A 1080p screen with a 32-pixel panel, menu opening just under it.
const screen = (overrides = {}) => ({
    workAreaY: 32,
    workAreaHeight: 1048,
    top: 40,
    margins: 8,
    scaleFactor: 1,
    ...overrides,
});

describe('menuMaxHeight', () => {
    it('fills the space below the menu', () => {
        expect(menuMaxHeight(screen())).toBe(32 + 1048 - 40 - 8);
    });

    // The mismatch a hardcoded 200px gets wrong. The compositor measures in
    // device pixels; a CSS max-height is read after scaling. The same menu
    // must occupy the same fraction of the screen at either factor.
    it('is scale independent for the same physical space', () => {
        const atOne = menuMaxHeight(screen());
        const atTwo = menuMaxHeight(
            screen({
                workAreaY: 64,
                workAreaHeight: 2096,
                top: 80,
                margins: 16,
                scaleFactor: 2,
            }),
        );

        expect(atTwo).toBe(atOne);
    });

    it('gives a menu opening lower down less room', () => {
        expect(menuMaxHeight(screen({ top: 500 }))).toBeLessThan(
            menuMaxHeight(screen({ top: 40 })),
        );
    });

    it('subtracts the menu margins', () => {
        expect(menuMaxHeight(screen({ margins: 100 }))).toBe(
            menuMaxHeight(screen({ margins: 0 })) - 100,
        );
    });

    it('honours a user-set ceiling', () => {
        expect(menuMaxHeight(screen({ capPx: 400 }))).toBe(400);
    });

    it('never lets the ceiling make the menu larger', () => {
        expect(menuMaxHeight(screen({ capPx: 99999 }))).toBe(menuMaxHeight(screen()));
    });

    it('treats a zero cap as no ceiling', () => {
        expect(menuMaxHeight(screen({ capPx: 0 }))).toBe(menuMaxHeight(screen()));
    });

    // Below this a scrollbar is worse than overflowing.
    it.each([
        ['a menu opening past the bottom of the screen', { top: 5000 }],
        ['a work area with no height', { workAreaHeight: 0 }],
        ['margins larger than the screen', { margins: 99999 }],
        ['an absurdly small cap', { capPx: 1 }],
    ])('floors %s at the minimum', (_reason, overrides) => {
        expect(menuMaxHeight(screen(overrides))).toBe(MIN_MENU_HEIGHT);
    });

    it('never returns a negative height', () => {
        expect(menuMaxHeight(screen({ top: 100000 }))).toBeGreaterThan(0);
    });

    // A scale factor of zero would divide the available space by nothing.
    it.each([
        ['zero', 0],
        ['negative', -2],
    ])('survives a %s scale factor', (_reason, scaleFactor) => {
        expect(Number.isFinite(menuMaxHeight(screen({ scaleFactor })))).toBe(true);
    });

    it('returns a whole number of pixels', () => {
        expect(Number.isInteger(menuMaxHeight(screen({ scaleFactor: 1.25 })))).toBe(
            true,
        );
    });
});

describe('maxHeightStyle', () => {
    // St parses this into the theme node, which is what get_max_height()
    // returns and therefore what PopupSubMenu._needsScrollbar() consults.
    it('is a CSS declaration St can parse', () => {
        expect(maxHeightStyle(400)).toBe('max-height: 400px;');
    });

    it('does not emit a fractional pixel', () => {
        expect(maxHeightStyle(399.6)).toBe('max-height: 400px;');
    });
});
