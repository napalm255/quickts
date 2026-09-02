// How tall the menu is allowed to be.
//
// The extension QuickTS replaces sets `menu.box.height = 200` and overwrites
// PopupSubMenu's private _needsScrollbar with a function returning true. Both
// are wrong. 200 pixels is meaningless at 200% scale or 125% text scaling, and
// forcing the scrollbar on draws one for a three-node tailnet that needs none.
// That is upstream issue #11, its longest thread.
//
// The Shell already implements this. js/ui/popupMenu.js says so in as many
// words — "the scrollbar will only take effect if a CSS max-height is set on
// the top menu" — and PopupSubMenu._needsScrollbar() reads exactly that, via
// _getTopMenu().actor.get_theme_node().get_max_height(). So the fix is to set
// the max-height the mechanism is already looking for, and touch nothing else.
//
// This file imports nothing; it is arithmetic. modules/panel.js reads the work
// area and the scale factor off the Shell and applies the result.

/**
 * Shortest menu worth scrolling.
 *
 * Below this, scrolling is worse than overflowing: a menu a few rows tall with
 * a scrollbar down the side is harder to use than one that runs past the edge.
 */
export const MIN_MENU_HEIGHT = 120;

/**
 * The largest a menu opening at `top` may be.
 *
 * The arithmetic is in physical pixels and the answer is in logical ones,
 * because that is the mismatch a hardcoded height gets wrong: the work area
 * and the actor position come from the compositor in device pixels, while a
 * CSS max-height is interpreted after the scale factor is applied. Dividing
 * once, here, is what makes the same menu occupy the same fraction of the
 * screen at 100% and at 200%.
 *
 * Nothing is measured in rows, so text scaling and font size need no special
 * handling: a taller row makes the menu's natural height larger and the clamp
 * catches it.
 *
 * @param {object} options Measurements, all in physical pixels.
 * @param {number} options.workAreaY Top of the work area.
 * @param {number} options.workAreaHeight Height of the work area.
 * @param {number} options.top Where the menu starts.
 * @param {number} [options.margins] The menu's own top and bottom margins.
 * @param {number} [options.scaleFactor] Device pixels per logical pixel.
 * @param {number} [options.capPx] User-set ceiling in logical pixels; 0 for none.
 * @returns {number} A max-height in logical pixels.
 */
export function menuMaxHeight({
    workAreaY,
    workAreaHeight,
    top,
    margins = 0,
    scaleFactor = 1,
    capPx = 0,
}) {
    const scale = scaleFactor > 0 ? scaleFactor : 1;
    const available = Math.max(0, workAreaY + workAreaHeight - top - margins);
    const logical = Math.round(available / scale);
    const capped = capPx > 0 ? Math.min(logical, capPx) : logical;

    return Math.max(MIN_MENU_HEIGHT, capped);
}

/**
 * The inline style that carries it.
 *
 * St parses an actor's `style` into its theme node, so a max-height set this
 * way is what get_max_height() returns and therefore what _needsScrollbar()
 * consults. No private API is touched.
 *
 * @param {number} maxHeight Logical pixels, from {@link menuMaxHeight}.
 * @returns {string} A CSS declaration for St.Widget.style.
 */
export function maxHeightStyle(maxHeight) {
    return `max-height: ${Math.round(maxHeight)}px;`;
}
