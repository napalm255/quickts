import { describe, expect, it } from 'vitest';

import { REASON } from '../modules/errors.js';
import {
    MAX_HEALTH_LINES,
    SEVERITY,
    SUMMARY,
    healthLines,
    isUp,
    needsLogin,
    problemOf,
    severityOf,
    summaryOf,
} from '../modules/health.js';
import { BACKEND, initialState } from '../modules/state.js';

const up = (overrides = {}) => ({
    ...initialState(),
    reachable: true,
    running: true,
    backendState: BACKEND.RUNNING,
    tailnetName: 'example@example.com',
    ...overrides,
});

describe('isUp', () => {
    it('is true only when the preference and the backend agree', () => {
        expect(isUp(up())).toBe(true);
    });

    // WantRunning stays true across a logout, so upstream's toggle — which
    // reads only the preference — shows "on" against a backend doing nothing.
    it.each([
        ['the backend needs a login', { backendState: BACKEND.NEEDS_LOGIN }],
        ['the backend is starting', { backendState: BACKEND.STARTING }],
        ['the backend is stopped', { backendState: BACKEND.STOPPED }],
        ['the preference is off', { running: false }],
    ])('is false when %s', (_reason, overrides) => {
        expect(isUp(up(overrides))).toBe(false);
    });
});

describe('needsLogin', () => {
    it('recognises the state that has no other way out', () => {
        expect(needsLogin(up({ backendState: BACKEND.NEEDS_LOGIN }))).toBe(true);
    });

    it('is false while running', () => {
        expect(needsLogin(up())).toBe(false);
    });
});

describe('healthLines', () => {
    it('passes warnings through', () => {
        expect(healthLines(up({ health: ['a', 'b'] }))).toEqual({
            lines: ['a', 'b'],
            hidden: 0,
        });
    });

    // The same warning can be reported by more than one subsystem.
    it('deduplicates', () => {
        expect(healthLines(up({ health: ['same', 'same', 'other'] })).lines).toEqual([
            'same',
            'other',
        ]);
    });

    it('caps the list and counts the remainder', () => {
        const health = ['a', 'b', 'c', 'd', 'e'];
        const result = healthLines(up({ health }));

        expect(result.lines).toHaveLength(MAX_HEALTH_LINES);
        expect(result.hidden).toBe(health.length - MAX_HEALTH_LINES);
    });

    it.each([
        ['an empty list', []],
        ['blank strings', ['', '   ']],
        ['a missing list', undefined],
        ['a null list', null],
    ])('reports %s as nothing wrong', (_reason, health) => {
        expect(healthLines(up({ health })).lines).toEqual([]);
    });
});

describe('summaryOf', () => {
    // Nothing else on screen can be trusted while the daemon is unreachable.
    it('puts an unreachable daemon above everything else', () => {
        const state = up({
            reachable: false,
            errorReason: REASON.PERMISSION_DENIED,
            exitNodeId: 'nGATE',
            exitNodeName: 'gateway',
            health: ['a warning'],
        });

        expect(summaryOf(state)).toEqual({
            kind: SUMMARY.ERROR,
            value: REASON.PERMISSION_DENIED,
        });
    });

    // The exit node does nothing until the login is finished.
    it('puts a needed login above the exit node', () => {
        const state = up({
            backendState: BACKEND.NEEDS_LOGIN,
            exitNodeId: 'nGATE',
            exitNodeName: 'gateway',
        });

        expect(summaryOf(state).kind).toBe(SUMMARY.NEEDS_LOGIN);
    });

    it.each([
        ['starting', { backendState: BACKEND.STARTING }, SUMMARY.STARTING],
        [
            'in use by another user',
            { backendState: BACKEND.IN_USE_OTHER_USER },
            SUMMARY.IN_USE,
        ],
        [
            'deliberately off',
            { running: false, backendState: BACKEND.STOPPED },
            SUMMARY.OFF,
        ],
    ])('reports %s', (_reason, overrides, kind) => {
        expect(summaryOf(up(overrides)).kind).toBe(kind);
    });

    it('names the exit node when there is one', () => {
        expect(summaryOf(up({ exitNodeId: 'nGATE', exitNodeName: 'gateway' }))).toEqual(
            {
                kind: SUMMARY.EXIT_NODE,
                value: 'gateway',
            },
        );
    });

    // Tailscale's automatic exit node sets ExitNodeID to an "auto:<expression>"
    // form, which matches no peer — so an exit node is in use and the derived
    // name is empty. Keying on the name would report that as no exit node.
    it('reports an automatic exit node that names no peer', () => {
        expect(summaryOf(up({ exitNodeId: 'auto:any', exitNodeName: '' }))).toEqual({
            kind: SUMMARY.EXIT_NODE,
            value: '',
        });
    });

    it('counts warnings, including the ones it did not show', () => {
        const state = up({ health: ['a', 'b', 'c', 'd'] });

        expect(summaryOf(state)).toEqual({ kind: SUMMARY.WARNINGS, value: 4 });
    });

    it('falls back to the tailnet name', () => {
        expect(summaryOf(up())).toEqual({
            kind: SUMMARY.CONNECTED,
            value: 'example@example.com',
        });
    });

    it('is happy with no tailnet name', () => {
        expect(summaryOf(up({ tailnetName: '' })).kind).toBe(SUMMARY.CONNECTED);
    });

    it('gives the initial state something to say', () => {
        expect(summaryOf(initialState()).kind).toBe(SUMMARY.ERROR);
    });
});

describe('severityOf', () => {
    it.each([
        ['an unreachable daemon', { reachable: false }, SEVERITY.ERROR],
        ['a needed login', { backendState: BACKEND.NEEDS_LOGIN }, SEVERITY.WARNING],
        ['warnings while up', { health: ['a'] }, SEVERITY.WARNING],
        ['a healthy tailnet', {}, SEVERITY.OK],
        ['being deliberately off', { running: false }, SEVERITY.OK],
    ])('rates %s', (_reason, overrides, severity) => {
        expect(severityOf(up(overrides))).toBe(severity);
    });

    // Warnings about a tailnet that is down are noise, not a problem.
    it('does not warn about health while the tailnet is off', () => {
        expect(severityOf(up({ running: false, health: ['a'] }))).toBe(SEVERITY.OK);
    });
});

describe('problemOf', () => {
    it('says nothing while the daemon is reachable', () => {
        expect(problemOf(up())).toBeNull();
    });

    // The one worth interrupting for: one command fixes it, and upstream logs
    // it to the journal and draws an empty menu instead.
    it('marks a permission failure as actionable', () => {
        const problem = problemOf(
            up({ reachable: false, errorReason: REASON.PERMISSION_DENIED }),
        );

        expect(problem.actionable).toBe(true);
        expect(problem.message).toContain('tailscale set --operator=');
    });

    it('does not make noise of an unreachable daemon', () => {
        expect(
            problemOf(up({ reachable: false, errorReason: REASON.CONNECTION_REFUSED }))
                .actionable,
        ).toBe(false);
    });

    it('still says something with no reason recorded', () => {
        expect(problemOf(up({ reachable: false, errorReason: '' })).message).toMatch(
            /\S/,
        );
    });
});
