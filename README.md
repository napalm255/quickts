# QuickTS

Tailscale in the GNOME quick settings menu.

Toggle the tailnet, pick an exit node, switch between profiles, copy a node's
address and send a file over Taildrop, without leaving the panel.

**[Documentation →](https://napalm255.github.io/quickts/)** — architecture,
testing, packaging and releasing.

## Requires

- GNOME Shell 50
- Tailscale, with your user set as the operator:

```bash
sudo tailscale set --operator=$USER
```

Without that, the daemon refuses the socket and QuickTS says so in the menu
rather than showing a tailnet that is silently disconnected.

## Install

```bash
curl -LO https://github.com/napalm255/quickts/releases/latest/download/quickts@napalm255.github.io.shell-extension.zip
gnome-extensions install --force quickts@napalm255.github.io.shell-extension.zip
gnome-extensions enable quickts@napalm255.github.io
```

From a clone:

```bash
just setup
just install
just enable
```

## Develop

```bash
just              # list every recipe
just test         # unit suite
just lint         # eslint, prettier, gschema, shellcheck
just ci           # what CI runs: lint, test, security, build
just test-live    # headless gnome-shell and bundle checks; needs a real Shell
just docs         # serve the documentation site
```

The suite runs on plain Node. Every decision QuickTS makes lives in a pure
module under `modules/`, and the two files that touch GNOME or libsoup are kept
deliberately free of branching — see the
[architecture notes](https://napalm255.github.io/quickts/#architecture).

## Releasing

Set the version in `metadata.json` (`version-name`) and `package.json`, commit,
then tag and push. The release workflow refuses a tag that disagrees with
either file.

## Licence

GPL-3.0-or-later.
