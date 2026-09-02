import { describe, expect, it } from 'vitest';

import * as bus from '../modules/bus.js';
import {
    NOTHING_DIRTY,
    dirtyFrom,
    isDirty,
    mergeDirty,
    parseBusLine,
} from '../modules/bus.js';

// The shape tailscaled actually sends, captured from a real initial
// notification: every field present, all but one of them null. Written out by
// hand rather than pasted, because a real payload carries the tailnet name, a
// session id and node keys, and this repository is public.
const INITIAL = JSON.stringify({
    Version: '1.0.0-tSOMEHASH-gSOMEHASH',
    SessionID: '0000000000000000',
    ErrMessage: null,
    LoginFinished: null,
    State: 6,
    Prefs: null,
    NetMap: null,
    Engine: null,
    BrowseToURL: null,
    DriveShares: null,
});

describe('the module contract', () => {
    // This is the load-bearing assertion of the whole file. If a way to get a
    // peer out of a notification ever appears here, the second peer shape that
    // produced upstream issues #35 and #28 has come back.
    it('offers no way to extract data from a notification', () => {
        expect(Object.keys(bus).sort()).toEqual([
            'NOTHING_DIRTY',
            'dirtyFrom',
            'isDirty',
            'mergeDirty',
            'parseBusLine',
        ]);
    });

    it('reports nothing dirty as nothing dirty', () => {
        expect(isDirty(NOTHING_DIRTY)).toBe(false);
    });
});

describe('parseBusLine', () => {
    it('parses a notification', () => {
        const result = parseBusLine(INITIAL);

        expect(result.ok).toBe(true);
        expect(result.notify.State).toBe(6);
    });

    // A truncated read at the moment tailscaled restarts looks exactly like
    // this. Tearing down the whole subscription for it would turn a hiccup
    // into a visible outage.
    it.each([
        ['a truncated object', '{"State":'],
        ['nonsense', 'not json at all'],
        ['an empty line', ''],
        ['whitespace', '   '],
        ['a JSON array', '[1,2,3]'],
        ['JSON null', 'null'],
        ['a bare number', '42'],
        ['a non-string', undefined],
    ])('rejects %s without throwing', (_reason, line) => {
        const result = parseBusLine(line);

        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/\S/);
    });
});

describe('dirtyFrom', () => {
    // The daemon sends every field on every notification and nulls the ones
    // that do not apply, so "present" has to mean "not null" or nothing
    // discriminates and every signal would look like every other.
    it('treats a null field as absent', () => {
        expect(dirtyFrom(JSON.parse(INITIAL))).toEqual({
            prefs: false,
            peers: false,
            state: true,
            health: false,
        });
    });

    it.each([
        ['Prefs', { Prefs: { WantRunning: true } }, 'prefs'],
        ['NetMap', { NetMap: { Peers: [] } }, 'peers'],
        ['State', { State: 2 }, 'state'],
        ['LoginFinished', { LoginFinished: {} }, 'state'],
        ['BrowseToURL', { BrowseToURL: 'https://login.tailscale.com/a/abc' }, 'state'],
        ['ErrMessage', { ErrMessage: 'something broke' }, 'health'],
    ])('%s marks %s dirty', (_field, notify, flag) => {
        expect(dirtyFrom(notify)[flag]).toBe(true);
    });

    // State 0 is ipn.NoState and BrowseToURL '' is a cleared URL. Both are
    // falsy and both are real changes, so a truthiness test here would drop
    // exactly the transition into "logged out".
    it.each([
        ['State 0', { State: 0 }],
        ['an empty BrowseToURL', { BrowseToURL: '' }],
    ])('does not mistake %s for an absent field', (_reason, notify) => {
        expect(dirtyFrom(notify).state).toBe(true);
    });

    // Engine updates are the noisiest thing on the bus and change nothing the
    // menu shows.
    it.each([
        ['Engine', { Engine: { RBytes: 1 } }],
        ['Version', { Version: '1.0.0' }],
        ['SessionID', { SessionID: 'abc' }],
        ['DriveShares', { DriveShares: [] }],
    ])('ignores %s', (_field, notify) => {
        expect(isDirty(dirtyFrom(notify))).toBe(false);
    });

    it.each([
        ['null', null],
        ['undefined', undefined],
        ['an empty object', {}],
    ])('reports %s as nothing to do', (_reason, notify) => {
        expect(dirtyFrom(notify)).toEqual(NOTHING_DIRTY);
    });
});

describe('mergeDirty', () => {
    // A flush must read the union of what every signal in its burst asked for,
    // or a change gets coalesced away rather than merely delayed.
    it('takes the union', () => {
        expect(mergeDirty(dirtyFrom({ Prefs: {} }), dirtyFrom({ NetMap: {} }))).toEqual(
            { prefs: true, peers: true, state: false, health: false },
        );
    });

    it('leaves a flag set once anything set it', () => {
        expect(mergeDirty({ ...NOTHING_DIRTY, peers: true }, NOTHING_DIRTY).peers).toBe(
            true,
        );
    });

    it('is unchanged by merging nothing into nothing', () => {
        expect(mergeDirty(NOTHING_DIRTY, NOTHING_DIRTY)).toEqual(NOTHING_DIRTY);
    });
});
