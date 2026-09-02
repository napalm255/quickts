// A recording stand-in for a Clutter actor.
//
// The stubs under tests/stubs/ are built on this. It exists so that
// tests/panel.test.js can assert QuickTS's own bookkeeping — how many handlers
// are connected, how many are left after destroy, what style was applied, which
// children were added — rather than asserting that a stub behaves like a stub.
//
// GObject subclasses in gnome-shell are constructed through _init rather than a
// constructor, so the base here calls _init from its constructor and
// registerClass is the identity. That is why nothing in modules/panel.js may
// use class fields: they initialise after super() returns, which is after
// _init has already run — exactly as in real GJS.

/** Handlers connected anywhere, so a test can prove they were all released. */
export const liveHandlers = new Set();

/** Reset between tests. */
export function resetActors() {
    liveHandlers.clear();
}

let nextHandlerId = 1;

/** The behaviour every fake actor and menu item shares. */
export class FakeActor {
    constructor(...args) {
        this.children = [];
        this.actions = [];
        this.style = null;
        this.visible = true;
        this.reactive = true;
        this.destroyed = false;
        this.styleClasses = new Set();

        // Handler id -> {signal, callback, owner}
        this.handlers = new Map();

        this._init(...args);
    }

    /**
     * @param {object} [props] Properties to assign, as GJS does.
     */
    _init(props = {}) {
        Object.assign(this, props);
    }

    connect(signal, callback) {
        const id = nextHandlerId++;
        this.handlers.set(id, { signal, callback, owner: null });
        liveHandlers.add(id);
        return id;
    }

    disconnect(id) {
        this.handlers.delete(id);
        liveHandlers.delete(id);
    }

    /** gnome-shell's owner-scoped connect, which modules/panel.js uses throughout. */
    connectObject(...args) {
        const owner = args.pop();
        while (args.length >= 2) {
            const [signal, callback] = args.splice(0, 2);
            const id = nextHandlerId++;
            this.handlers.set(id, { signal, callback, owner });
            liveHandlers.add(id);
        }
    }

    disconnectObject(owner) {
        for (const [id, handler] of [...this.handlers])
            if (handler.owner === owner) this.disconnect(id);
    }

    /** Fire every handler for a signal, as the Shell would. */
    emit(signal, ...args) {
        for (const handler of [...this.handlers.values()])
            if (handler.signal === signal) handler.callback(this, ...args);
    }

    add_child(child) {
        this.children.push(child);
    }

    remove_child(child) {
        this.children = this.children.filter(existing => existing !== child);
    }

    remove_all_children() {
        this.children = [];
    }

    get_children() {
        return [...this.children];
    }

    add_action(action) {
        this.actions.push(action);
    }

    add_style_class_name(name) {
        this.styleClasses.add(name);
    }

    remove_style_class_name(name) {
        this.styleClasses.delete(name);
    }

    add_style_pseudo_class() {}
    remove_style_pseudo_class() {}

    set_style(style) {
        this.style = style;
    }

    get_theme_node() {
        // Enough of a theme node for modules/layout.js's output to be read
        // back the way St would read it.
        const match = /max-height:\s*(\d+)px/.exec(this.style ?? '');
        return { get_max_height: () => (match ? Number(match[1]) : -1) };
    }

    get_transformed_position() {
        return [0, this.transformedTop ?? 0];
    }

    get_preferred_height() {
        return [0, this.naturalHeight ?? 0];
    }

    navigate_focus() {
        this.focusNavigated = true;
        return true;
    }

    show() {
        this.visible = true;
    }

    hide() {
        this.visible = false;
    }

    destroy() {
        this.destroyed = true;
        for (const id of [...this.handlers.keys()]) this.disconnect(id);
        for (const child of this.children) child.destroy?.();
        this.children = [];
    }
}

/** Depth-first walk, for finding a row in a built menu. */
export function descendants(actor) {
    const found = [];
    const visit = node => {
        for (const child of node.children ?? []) {
            found.push(child);
            visit(child);
        }
    };
    visit(actor);
    return found;
}
