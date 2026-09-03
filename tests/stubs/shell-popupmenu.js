// resource:///org/gnome/shell/ui/popupMenu.js, as far as modules/panel.js uses it.
//
// The menu classes keep real child bookkeeping, so tests/panel.test.js can
// count the rows QuickTS built and fire the ones it cares about, rather than
// asserting against a mock's call log.

import { FakeActor } from '../support/actors.js';

class PopupBaseMenuItem extends FakeActor {
    _init(props = {}) {
        super._init(props);
        this.sensitive = props.reactive !== false;
        this.label_actor = null;
    }

    setSensitive(sensitive) {
        this.sensitive = sensitive;
    }

    /** Fire the item as a click would. */
    activate() {
        this.emit('activate', this);
    }
}

/** A label with the clutter_text the real St.Label exposes. */
function makeLabel(text) {
    const label = new FakeActor({ text });
    label.clutter_text = {
        line_wrap: false,
        line_wrap_mode: null,
        ellipsize: null,
    };
    return label;
}

class PopupMenuItem extends PopupBaseMenuItem {
    _init(text, props = {}) {
        super._init(props);
        this.label = makeLabel(text);
        this.label_actor = this.label;
        this.add_child(this.label);
    }

    get text() {
        return this.label.text;
    }

    set text(value) {
        this.label.text = value;
    }
}

class PopupImageMenuItem extends PopupBaseMenuItem {
    _init(text, icon, props = {}) {
        super._init(props);
        this.label = makeLabel(text);
        this.label_actor = this.label;
        this.add_child(this.label);
        this.icon = icon;
    }

    get text() {
        return this.label.text;
    }

    set text(value) {
        this.label.text = value;
    }

    setIcon(icon) {
        this.icon = icon;
    }
}

class PopupSwitchMenuItem extends PopupBaseMenuItem {
    _init(text, active, props = {}) {
        super._init(props);
        this.label = makeLabel(text);
        this.label_actor = this.label;
        this.add_child(this.label);
        this.state = Boolean(active);
    }

    get text() {
        return this.label.text;
    }

    set text(value) {
        this.label.text = value;
    }

    setToggleState(state) {
        this.state = Boolean(state);
    }

    /** Fire the switch as a click would, flipping it first. */
    toggle() {
        this.state = !this.state;
        this.emit('toggled', this.state);
    }
}

class PopupSeparatorMenuItem extends PopupBaseMenuItem {}

/** The shared behaviour of anything that holds menu items. */
class MenuBase extends FakeActor {
    _init(props = {}) {
        super._init(props);
        this.items = [];
        this.isOpen = false;
        this.actor = new FakeActor();
    }

    addMenuItem(item) {
        this.items.push(item);
        this.add_child(item);
        item._parentMenu = this;

        // The real PopupMenuBase connects to 'activate' with
        // ConnectFlags.AFTER and calls itemActivated(), which closes the top
        // menu. Every activation closes the whole menu unless the item
        // overrides activate() and declines to chain up. Modelling it here is
        // what lets a test notice a row that should have stayed open.
        item.connect('activate', () => this._getTopMenu().close());
    }

    /** The menu at the root of the chain, as the real _getTopMenu does. */
    _getTopMenu() {
        return this._ownerItem?._parentMenu?._getTopMenu() ?? this;
    }

    removeAll() {
        for (const item of this.items) item.destroy();
        this.items = [];
        this.remove_all_children();
    }

    isEmpty() {
        return this.items.length === 0;
    }

    open() {
        this.isOpen = true;
        this.emit('open-state-changed', true);
    }

    close() {
        this.isOpen = false;
        this.emit('open-state-changed', false);
    }

    toggle() {
        return this.isOpen ? this.close() : this.open();
    }

    destroy() {
        this.removeAll();
        super.destroy();
    }
}

class PopupMenuSection extends MenuBase {}

class PopupSubMenuMenuItem extends PopupBaseMenuItem {
    _init(text, wantIcon = false, props = {}) {
        super._init(props);

        // The real class exposes the St.Label as `this.label` and sets
        // label_actor to it (js/ui/popupMenu.js:1320). modules/panel.js
        // relabels the exit node submenu through it, so the stub has to offer
        // the same handle rather than a plain string.
        this.label = new FakeActor({ text });
        this.label_actor = this.label;
        this.add_child(this.label);

        if (wantIcon) {
            this.icon = new FakeActor();
            this.add_child(this.icon);
        }

        this.menu = new PopupMenuSection();
        this.menu._ownerItem = this;
        this.add_child(this.menu);
    }

    get text() {
        return this.label.text;
    }

    set text(value) {
        this.label.text = value;
    }
}

export {
    MenuBase,
    PopupBaseMenuItem,
    PopupImageMenuItem,
    PopupMenuItem,
    PopupMenuSection,
    PopupSeparatorMenuItem,
    PopupSubMenuMenuItem,
    PopupSwitchMenuItem,
};
