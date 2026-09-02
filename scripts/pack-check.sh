#!/usr/bin/env bash
# Check the zip `just build` produces against the one GNOME's own packer makes.
#
# `just build` uses plain `zip`, because `gnome-extensions` ships inside the
# gnome-shell package and CI has no GNOME — making the build depend on it would
# pull the whole desktop onto every runner. The cost of hand-rolling the archive
# is that nothing checks the layout, and extensions.gnome.org is strict about it:
# metadata.json must sit at the archive root, never nested.
#
# So the official tool is kept as the authority and consulted here instead. This
# needs a real gnome-shell and so runs locally only, via `just test-live`.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

command -v gnome-extensions >/dev/null || {
    echo "FAIL: gnome-extensions not found; it ships with the gnome-shell package" >&2
    exit 1
}

UUID="$(jq -r .uuid metadata.json)"
ZIP="$UUID.shell-extension.zip"
SCHEMA="schemas/$(jq -r '."settings-schema"' metadata.json).gschema.xml"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

[[ -f "$SCHEMA" ]] || {
    echo "FAIL: metadata.json names settings-schema not found at $SCHEMA" >&2
    exit 1
}

# --extra-source takes a directory and recurses, so modules/ and icons/ go in
# whole. That matters: naming files individually would silently drop a newly
# added module. stylesheet.css is named explicitly because it is a single file.
gnome-extensions pack --force -o "$WORK" \
    --extra-source=modules \
    --extra-source=icons \
    --extra-source=stylesheet.css \
    --schema="$SCHEMA" \
    . >/dev/null

[[ -f "$ZIP" ]] || {
    echo "FAIL: $ZIP not found; run 'just build' first" >&2
    exit 1
}

# Directory entries only differ in whether each tool records them, which changes
# nothing about what the Shell loads.
listing() { unzip -Z1 "$1" | grep -v '/$' | LC_ALL=C sort; }

if ! diff -u <(listing "$WORK/$ZIP") <(listing "$ZIP") \
        --label 'gnome-extensions pack' --label 'just build'; then
    echo "FAIL: the built zip does not contain what the official packer produces" >&2
    exit 1
fi

# The one rule extensions.gnome.org will not bend on.
if [[ "$(unzip -Z1 "$ZIP" | grep -c '^metadata.json$')" -ne 1 ]]; then
    echo "FAIL: metadata.json is not at the archive root" >&2
    exit 1
fi

# Every shipped icon must actually decode.
#
# This exists because one did not. A long XML comment placed before the <svg>
# element defeats gdk-pixbuf's format sniffing, so the file loads as "couldn't
# recognize the image file format" and the extension renders with no icon at
# all — and nothing appears in the shell log to say why. Neither the unit suite
# nor headless-check.sh looks at an icon, so only this notices.
for icon in "$REPO_ROOT"/icons/*.svg; do
    [[ -e "$icon" ]] || continue
    if ! gjs -m "$REPO_ROOT/scripts/icon-check.js" "$icon" >/dev/null 2>&1; then
        echo "FAIL: $(basename "$icon") does not decode as an image" >&2
        exit 1
    fi
done
echo "ok: $(find "$REPO_ROOT/icons" -name '*.svg' | wc -l) icon(s) decode"

echo "ok: $(listing "$ZIP" | wc -l) files, matching gnome-extensions pack"
echo "ok: metadata.json at the archive root"
echo "PASS"
