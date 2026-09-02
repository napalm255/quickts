# Security policy

## Supported versions

The most recent release. QuickTS targets a single GNOME Shell major version at a
time; older releases are not patched.

## Reporting a vulnerability

Report privately through
[GitHub's advisory form](https://github.com/napalm255/quickts/security/advisories/new)
rather than opening an issue.

Please include the GNOME Shell version, the QuickTS version, the Tailscale
version, and the steps to reproduce. You can expect an acknowledgement within a
week.

## Scope

QuickTS talks to the Tailscale daemon over its local Unix socket at
`/run/tailscale/tailscaled.sock`, using the same LocalAPI the `tailscale` CLI
uses. Anything you can do through the menu, you can already do from a terminal
as the tailscale operator; the extension grants no privilege you did not have.

The parts worth scrutinising:

- **The LocalAPI client** (`modules/io.js`, `modules/localapi.js`). Every request
  path is built in `localapi.js`, where node identifiers and Taildrop filenames
  are percent-encoded before they reach a URL.
- **Taildrop** (`modules/taildrop.js`). Files are chosen through the XDG desktop
  portal, so the file dialog runs outside the Shell process, and are streamed to
  a peer the daemon has already listed as an eligible target.
- **Data from the tailnet is not trusted.** Peer names, tags and health strings
  come from the coordination server and are rendered as text only. They are
  never used to build a path, a command, or markup.
- **Nothing is logged that identifies a node.** The extension logs one line at
  enable and warnings for misconfiguration; peer names, addresses and keys stay
  out of the journal.
