// resource:///org/gnome/shell/ui/quickSettings.js, as far as modules/panel.js uses it.

import { FakeActor } from '../support/actors.js';
import { MenuBase } from './shell-popupmenu.js';

/** The menu a QuickMenuToggle owns, with the header the real one provides. */
class QuickToggleMenu extends MenuBase {
    _init(props = {}) {
        super._init(props);
        this.header = { icon: null, title: '', subtitle: '' };
        this.headerSuffixes = [];
    }

    setHeader(icon, title, subtitle = '') {
        this.header = { icon, title, subtitle };
    }

    addHeaderSuffix(actor) {
        this.headerSuffixes.push(actor);
    }
}

class QuickMenuToggle extends FakeActor {
    _init(props = {}) {
        super._init(props);
        this.menu = new QuickToggleMenu();
        this.checked = Boolean(props.checked);
    }

    /** Fire the toggle as a click would, flipping it first. */
    click() {
        this.checked = !this.checked;
        this.emit('clicked', this);
    }
}

class SystemIndicator extends FakeActor {
    _init(props = {}) {
        super._init(props);
        this.quickSettingsItems = [];
        this.indicators = [];
    }

    _addIndicator() {
        const icon = new FakeActor();
        this.indicators.push(icon);
        this.add_child(icon);
        return icon;
    }
}

export { QuickMenuToggle, QuickToggleMenu, SystemIndicator };
