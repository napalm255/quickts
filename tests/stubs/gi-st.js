// St, as far as modules/panel.js uses it.

import { FakeActor } from '../support/actors.js';

/** What was put on the clipboard, by clipboard type. */
export const clipboard = { CLIPBOARD: null, PRIMARY: null };

/** The scale factor the theme context reports. A test may change it. */
export const themeContext = { scale_factor: 1 };

/** Reset between tests. */
export function resetSt() {
    clipboard.CLIPBOARD = null;
    clipboard.PRIMARY = null;
    themeContext.scale_factor = 1;
}

class Widget extends FakeActor {}
class BoxLayout extends Widget {}
class Icon extends Widget {}
class Label extends Widget {}
class Button extends Widget {}
class ScrollView extends Widget {}

export default {
    Widget,
    BoxLayout,
    Icon,
    Label,
    Button,
    ScrollView,

    ClipboardType: { CLIPBOARD: 'CLIPBOARD', PRIMARY: 'PRIMARY' },

    Clipboard: {
        get_default: () => ({
            set_text(type, text) {
                clipboard[type === 'PRIMARY' ? 'PRIMARY' : 'CLIPBOARD'] = text;
            },
        }),
    },

    ThemeContext: {
        get_for_stage: () => themeContext,
    },

    PolicyType: { NEVER: 0, AUTOMATIC: 1, ALWAYS: 2 },
    DirectionType: { TAB_FORWARD: 0, TAB_BACKWARD: 1 },
    Align: { START: 0, MIDDLE: 1, END: 2 },
};
