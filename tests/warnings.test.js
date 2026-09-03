import { describe, expect, it } from 'vitest';

import { describeWarning, hasLink } from '../modules/warnings.js';

// The real messages, from tailscale's health/healthmsg package and from a
// live daemon. These are the ones that have to come out well; anything else
// is a bonus.
const REAL = {
    selinux:
        'SELinux is enabled; Tailscale SSH may not work. See https://tailscale.com/s/ssh-selinux',
    routes: 'Some peers are advertising routes but --accept-routes is false',
    lockedOut:
        'this node is locked out; it will not have connectivity until it is signed. For more info, see https://tailscale.com/s/locked-out',
    tailnetLock:
        'Tailnet Lock state is only being stored in-memory. Set --statedir to store state on disk, which is more secure. See https://tailscale.com/kb/1226/tailnet-lock#tailnet-lock-state',
};

describe('describeWarning', () => {
    it('takes the link out of the text', () => {
        expect(describeWarning(REAL.selinux)).toEqual({
            text: 'SELinux is enabled; Tailscale SSH may not work.',
            url: 'https://tailscale.com/s/ssh-selinux',
        });
    });

    // "For more info, see" is two lead-ins; stripping once leaves a dangling
    // "For more info," which reads worse than leaving the URL in.
    it('strips a chain of lead-ins', () => {
        expect(describeWarning(REAL.lockedOut).text).toBe(
            'this node is locked out; it will not have connectivity until it is signed.',
        );
    });

    it('keeps a fragment identifier in the link', () => {
        expect(describeWarning(REAL.tailnetLock).url).toBe(
            'https://tailscale.com/kb/1226/tailnet-lock#tailnet-lock-state',
        );
    });

    it('leaves a message with no link alone', () => {
        expect(describeWarning(REAL.routes)).toEqual({ text: REAL.routes, url: '' });
    });

    it.each([
        [
            'a trailing full stop',
            'Broken. See https://example.com/a.',
            'https://example.com/a',
        ],
        [
            'a trailing comma',
            'Broken, see https://example.com/a,',
            'https://example.com/a',
        ],
        [
            'a closing bracket',
            'Broken (see https://example.com/a)',
            'https://example.com/a',
        ],
    ])('trims %s from the link', (_reason, message, url) => {
        expect(describeWarning(message).url).toBe(url);
    });

    it('does not add a second full stop to text that already ends in one', () => {
        expect(describeWarning('Something broke! See https://example.com/x').text).toBe(
            'Something broke!',
        );
    });

    it('restores the full stop the lead-in took with it', () => {
        expect(
            describeWarning('Something is wrong, see https://example.com/x').text,
        ).toBe('Something is wrong.');
    });

    // Better a redundant URL on screen than a row with no text at all.
    it('keeps the original when the message is only a link', () => {
        const message = 'https://example.com/only';

        expect(describeWarning(message).text).toBe(message);
    });

    it('takes only the first link', () => {
        const result = describeWarning(
            'One https://example.com/a and https://example.com/b',
        );

        expect(result.url).toBe('https://example.com/a');
    });

    it.each([
        ['plain http', 'Go to http://example.com/x', 'http://example.com/x'],
        ['no protocol', 'Go to example.com/x', ''],
        ['ftp', 'Go to ftp://example.com/x', ''],
    ])('handles %s', (_reason, message, url) => {
        expect(describeWarning(message).url).toBe(url);
    });

    it.each([
        ['null', null],
        ['undefined', undefined],
        ['an empty string', ''],
        ['whitespace', '   '],
    ])('returns a usable pair for %s', (_reason, message) => {
        expect(describeWarning(message)).toEqual({ text: '', url: '' });
    });

    // The pattern runs over text the daemon controls, so it must not be a
    // place where a long message can hang the Shell.
    it('is linear against a pathological message', () => {
        const nasty = `${' '.repeat(20000)}see${' '.repeat(20000)}`;
        const started = Date.now();

        describeWarning(nasty);

        expect(Date.now() - started).toBeLessThan(1000);
    });
});

describe('hasLink', () => {
    it.each([
        ['the SELinux warning', REAL.selinux, true],
        ['the accept-routes warning', REAL.routes, false],
        ['nothing', '', false],
    ])('reports %s correctly', (_reason, message, expected) => {
        expect(hasLink(message)).toBe(expected);
    });
});
