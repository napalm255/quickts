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

class PopupMenuItem extends PopupBaseMenuItem {
    _init(text, props = {}) {
        super._init(props);
        this.text = text;
    }
}

class PopupImageMenuItem extends PopupBaseMenuItem {
    _init(text, icon, props = {}) {
        super._init(props);
        this.text = text;
        this.icon = icon;
    }

    setIcon(icon) {
        this.icon = icon;
    }
}

class PopupSwitchMenuItem extends PopupBaseMenuItem {
    _init(text, active, props = {}) {
        super._init(props);
        this.text = text;
        this.state = Boolean(active);
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
        this.text = text;
        this.wantIcon = wantIcon;
        this.menu = new PopupMenuSection();
        this.add_child(this.menu);
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
