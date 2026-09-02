import { describe, expect, it } from 'vitest';

import {
    HOST,
    NOTIFY,
    SOCKET_PATHS,
    WATCH_MASK,
    currentProfileRequest,
    filePutRequest,
    fileTargetsRequest,
    loginRequest,
    logoutRequest,
    patchPrefsRequest,
    pickSocket,
    prefsRequest,
    profilesRequest,
    statusRequest,
    switchProfileRequest,
    watchBusRequest,
} from '../modules/localapi.js';

describe('pickSocket', () => {
    it('prefers the first path that exists', () => {
        expect(pickSocket(SOCKET_PATHS, path => path === SOCKET_PATHS[1])).toBe(
            SOCKET_PATHS[1],
        );
    });

    it('takes /run over /var/run when both exist', () => {
        expect(pickSocket(SOCKET_PATHS, () => true)).toBe(
            '/run/tailscale/tailscaled.sock',
        );
    });

    // Tailscale not installed at all. The caller turns this into the "not
    // running" message rather than letting a connect fail with no explanation.
    it('returns null when nothing exists', () => {
        expect(pickSocket(SOCKET_PATHS, () => false)).toBeNull();
    });
});

describe('statusRequest', () => {
    it('asks for peers by default', () => {
        expect(statusRequest()).toEqual({ method: 'GET', path: '/localapi/v0/status' });
    });

    // The cheap poll. Everything the closed menu needs survives the omission,
    // which is what lets the IPN bus be treated as a signal rather than data.
    it('can omit the peer map', () => {
        expect(statusRequest({ peers: false }).path).toBe(
            '/localapi/v0/status?peers=false',
        );
    });
});

describe('patchPrefsRequest', () => {
    // Without the mask, every preference the body does not mention reads as its
    // Go zero value and is reset — turning on SSH would silently clear the exit
    // node, accept-routes and accept-DNS.
    it('sets a mask field for every change', () => {
        expect(patchPrefsRequest({ WantRunning: true })).toEqual({
            method: 'PATCH',
            path: '/localapi/v0/prefs',
            body: { WantRunning: true, WantRunningSet: true },
        });
    });

    it('masks every field of a multi-key change', () => {
        const { body } = patchPrefsRequest({ RouteAll: true, CorpDNS: false });

        expect(body).toEqual({
            RouteAll: true,
            RouteAllSet: true,
            CorpDNS: false,
            CorpDNSSet: true,
        });
    });

    // ipn/prefs.go spells these with a capital S. The extension this replaces
    // sent `WantRunningset`, which works only because encoding/json matches
    // field names case-insensitively — encoding/json/v2 does not.
    it('spells the mask field the way ipn.MaskedPrefs does', () => {
        const { body } = patchPrefsRequest({ ExitNodeAllowLANAccess: true });

        expect(body).toHaveProperty('ExitNodeAllowLANAccessSet', true);
        expect(body).not.toHaveProperty('ExitNodeAllowLANAccessset');
    });

    // Clearing the exit node is a write of the empty string, not an omission,
    // so a falsy value must still get its mask.
    it('masks a value that is falsy', () => {
        expect(patchPrefsRequest({ ExitNodeID: '' }).body).toEqual({
            ExitNodeID: '',
            ExitNodeIDSet: true,
        });
    });

    it('does not mutate the object it was given', () => {
        const changes = { ShieldsUp: true };
        patchPrefsRequest(changes);

        expect(changes).toEqual({ ShieldsUp: true });
    });
});

describe('profile requests', () => {
    it('lists profiles from the collection path', () => {
        expect(profilesRequest().path).toBe('/localapi/v0/profiles/');
    });

    it('reads the active profile from its own endpoint', () => {
        expect(currentProfileRequest()).toEqual({
            method: 'GET',
            path: '/localapi/v0/profiles/current',
        });
    });

    it('switches by posting to the profile id', () => {
        expect(switchProfileRequest('4964')).toEqual({
            method: 'POST',
            path: '/localapi/v0/profiles/4964',
            body: {},
        });
    });
});

describe('filePutRequest', () => {
    it('addresses the target and the filename', () => {
        expect(filePutRequest('nLqQ5Jp3x721CNTRL', 'notes.txt')).toEqual({
            method: 'PUT',
            path: '/localapi/v0/file-put/nLqQ5Jp3x721CNTRL/notes.txt',
        });
    });

    // A filename is arbitrary user input. Each of these would otherwise change
    // which endpoint is addressed rather than which file is sent.
    it.each([
        ['a space', 'my notes.txt', 'my%20notes.txt'],
        ['a slash', 'a/b.txt', 'a%2Fb.txt'],
        ['a hash', 'draft#2.txt', 'draft%232.txt'],
        ['a question mark', 'what?.txt', 'what%3F.txt'],
        ['a percent', '100%.txt', '100%25.txt'],
        ['a non-ascii letter', 'café.txt', 'caf%C3%A9.txt'],
        ['a newline', 'a\nb.txt', 'a%0Ab.txt'],
    ])('escapes %s', (_reason, filename, encoded) => {
        expect(filePutRequest('n1', filename).path).toBe(
            `/localapi/v0/file-put/n1/${encoded}`,
        );
    });

    // Traversal cannot escape the endpoint once the separators are encoded.
    it('cannot be walked out of the file-put path', () => {
        expect(filePutRequest('n1', '../../prefs').path).toBe(
            '/localapi/v0/file-put/n1/..%2F..%2Fprefs',
        );
    });

    it('escapes the target id too', () => {
        expect(filePutRequest('a/b', 'x.txt').path).toBe(
            '/localapi/v0/file-put/a%2Fb/x.txt',
        );
    });
});

describe('the remaining endpoints', () => {
    it.each([
        [prefsRequest, 'GET', '/localapi/v0/prefs'],
        [fileTargetsRequest, 'GET', '/localapi/v0/file-targets'],
    ])('%o addresses its endpoint', (request, method, path) => {
        expect(request()).toEqual({ method, path });
    });

    it.each([
        [loginRequest, '/localapi/v0/login-interactive'],
        [logoutRequest, '/localapi/v0/logout'],
    ])('%o posts to its endpoint', (request, path) => {
        expect(request()).toEqual({ method: 'POST', path, body: {} });
    });
});

describe('watchBusRequest', () => {
    it('subscribes with the mask QuickTS needs', () => {
        expect(watchBusRequest()).toEqual({
            method: 'GET',
            path: '/localapi/v0/watch-ipn-bus?mask=258',
        });
    });

    // Without INITIAL_STATE the daemon says nothing until something changes,
    // so an established subscription is indistinguishable from a dead one and
    // the reconnect loop has no event on which to reset its backoff.
    it('asks for the initial state', () => {
        expect(WATCH_MASK & NOTIFY.INITIAL_STATE).toBeTruthy();
    });

    // Complementary to flushDelay, not a replacement: the daemon throttles what
    // it sends, QuickTS still batches what it receives.
    it('lets the daemon rate-limit netmap bursts', () => {
        expect(WATCH_MASK & NOTIFY.RATE_LIMIT).toBeTruthy();
    });

    it('accepts an explicit mask', () => {
        expect(watchBusRequest(0).path).toBe('/localapi/v0/watch-ipn-bus?mask=0');
    });
});

describe('HOST', () => {
    // tailscaled refuses any other Host header on the socket.
    it('is the name tailscaled expects', () => {
        expect(HOST).toBe('local-tailscaled.sock');
    });
});
