// What the menu should say about how things are going.
//
// tailscaled already computes this. /status carries a Health array of
// human-readable warnings — "Some peers are advertising routes but
// --accept-routes is false", "SELinux is enabled; Tailscale SSH may not work"
// — and a BackendState that says whether the daemon is running, starting or
// waiting to be logged in. The extension QuickTS replaces reads neither, which
// is why its toggle can sit there showing "on" while the backend waits for a
// login that nothing in the menu offers.
//
// Nothing here is translated, for the same reason nothing here imports: this
// file has to be loadable from Vitest. It returns a kind and a value, and
// modules/panel.js chooses the wording. That also keeps the format strings
// where a translator can see them, rather than assembled from fragments.
//
// This file imports only other pure modules.

import { REASON, isActionable, messageFor } from './errors.js';
import { BACKEND } from './state.js';

/** How many health warnings to show before summarising the rest. */
export const MAX_HEALTH_LINES = 3;

/** What the subtitle is about. modules/panel.js maps these to wording. */
export const SUMMARY = Object.freeze({
    /** The daemon could not be reached. `value` is a reason from REASON. */
    ERROR: 'error',
    /** Waiting for an interactive login. */
    NEEDS_LOGIN: 'needs-login',
    /** Another user on this machine is using Tailscale. */
    IN_USE: 'in-use',
    /** Coming up. */
    STARTING: 'starting',
    /** Deliberately down. */
    OFF: 'off',
    /** Routing through a peer. `value` is the node name. */
    EXIT_NODE: 'exit-node',
    /** Up, with warnings. `value` is the number of them. */
    WARNINGS: 'warnings',
    /** Up. `value` is the tailnet name, which may be empty. */
    CONNECTED: 'connected',
});

/** How loudly to say it. */
export const SEVERITY = Object.freeze({
    OK: 'ok',
    WARNING: 'warning',
    ERROR: 'error',
});

/**
 * Whether the daemon is waiting for someone to log in.
 *
 * This is the state upstream cannot represent, because it reads only
 * WantRunning from the preferences. WantRunning stays true across a logout, so
 * its toggle shows "on" against a backend that is doing nothing.
 *
 * @param {object} state A snapshot.
 * @returns {boolean} True if an interactive login would help.
 */
export function needsLogin(state) {
    return state.backendState === BACKEND.NEEDS_LOGIN;
}

/**
 * Whether the tailnet is actually carrying traffic.
 *
 * Both halves are required. The preference says what was asked for and the
 * backend state says what came of it, and a menu that reports only the first
 * is a menu that lies whenever they disagree.
 *
 * @param {object} state A snapshot.
 * @returns {boolean} True if up.
 */
export function isUp(state) {
    return state.running && state.backendState === BACKEND.RUNNING;
}

/**
 * The health warnings to show.
 *
 * Deduplicated because the same warning can be reported by more than one
 * subsystem, and capped because the list is rendered inside a menu that also
 * has to hold the nodes.
 *
 * @param {object} state A snapshot.
 * @returns {{lines: string[], hidden: number}} What to show, and how many were not shown.
 */
export function healthLines(state) {
    const unique = [...new Set((state.health ?? []).filter(line => line?.trim()))];

    return {
        lines: unique.slice(0, MAX_HEALTH_LINES),
        hidden: Math.max(0, unique.length - MAX_HEALTH_LINES),
    };
}

/**
 * What the toggle's subtitle should be about.
 *
 * Ordered by what a person most needs to know. An unreachable daemon outranks
 * everything, because nothing else on screen can be trusted while it holds; a
 * login prompt outranks the exit node, because the exit node does nothing
 * until the login is done.
 *
 * @param {object} state A snapshot.
 * @returns {{kind: string, value: string|number}} Subject and its parameter.
 */
export function summaryOf(state) {
    if (!state.reachable)
        return { kind: SUMMARY.ERROR, value: state.errorReason || REASON.UNKNOWN };

    if (needsLogin(state)) return { kind: SUMMARY.NEEDS_LOGIN, value: '' };
    if (state.backendState === BACKEND.IN_USE_OTHER_USER)
        return { kind: SUMMARY.IN_USE, value: '' };
    if (state.backendState === BACKEND.STARTING)
        return { kind: SUMMARY.STARTING, value: '' };

    if (!isUp(state)) return { kind: SUMMARY.OFF, value: '' };

    if (state.exitNodeName)
        return { kind: SUMMARY.EXIT_NODE, value: state.exitNodeName };

    const { lines, hidden } = healthLines(state);
    if (lines.length > 0)
        return { kind: SUMMARY.WARNINGS, value: lines.length + hidden };

    return { kind: SUMMARY.CONNECTED, value: state.tailnetName };
}

/**
 * How serious the current state is.
 *
 * @param {object} state A snapshot.
 * @returns {string} One of {@link SEVERITY}.
 */
export function severityOf(state) {
    if (!state.reachable) return SEVERITY.ERROR;
    if (needsLogin(state) || state.backendState === BACKEND.IN_USE_OTHER_USER)
        return SEVERITY.WARNING;
    if (isUp(state) && healthLines(state).lines.length > 0) return SEVERITY.WARNING;

    return SEVERITY.OK;
}

/**
 * The message for an unreachable daemon, and whether it is worth a row of its own.
 *
 * A permission failure is the one worth interrupting for: tailscaled answers
 * 403 to anyone who is not the tailscale operator, and one command fixes it.
 * Upstream logs that to the journal and draws an empty menu, so the fix is
 * discoverable only by reading its source.
 *
 * @param {object} state A snapshot.
 * @returns {{message: string, actionable: boolean}|null} What to say, or null if fine.
 */
export function problemOf(state) {
    if (state.reachable) return null;

    const reason = state.errorReason || REASON.UNKNOWN;

    return { message: messageFor(reason), actionable: isActionable(reason) };
}
