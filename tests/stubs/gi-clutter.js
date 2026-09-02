// Clutter 18, as far as modules/panel.js uses it.
//
// ClickAction and LongPressState are deliberately absent, because they are
// absent from Clutter 18 — verified by introspecting the typelib, not inferred
// from release notes. The extension QuickTS replaces constructs both, which is
// why its copy-the-address gesture throws on GNOME 49 and later. A stub that
// offered them would hide exactly the regression this one exists to catch.

import { FakeActor } from '../support/actors.js';

/** Records the gesture so a test can recognise it and fire it. */
class Gesture extends FakeActor {
    _init(props = {}) {
        super._init(props);
        this.kind = 'gesture';
    }

    /** Drive the gesture as Clutter would on a completed press. */
    recognize() {
        this.emit('recognize', this);
    }
}

class LongPressGesture extends Gesture {
    _init(props = {}) {
        super._init(props);
        this.kind = 'long-press';
    }
}

class ClickGesture extends Gesture {
    _init(props = {}) {
        super._init(props);
        this.kind = 'click';
    }
}

export default {
    LongPressGesture,
    ClickGesture,

    GestureState: {
        WAITING: 0,
        POSSIBLE: 1,
        RECOGNIZING: 2,
        COMPLETED: 3,
        CANCELLED: 4,
    },

    ActorAlign: { FILL: 0, START: 1, CENTER: 2, END: 3 },
    Orientation: { HORIZONTAL: 0, VERTICAL: 1 },
    EVENT_PROPAGATE: false,
    EVENT_STOP: true,
};
