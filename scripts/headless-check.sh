#!/usr/bin/env bash
# Boot a throwaway headless gnome-shell with QuickTS installed and assert that
# it enables cleanly, disables cleanly, and can be enabled again without
# leaking.
#
# The enable/disable/enable cycle is the point. It is the exact shape of the bug
# in the extension QuickTS replaces: its watch loop awaits a GLib timeout that
# disable() removes out from under it, so the promise never settles, the loop
# never returns, and the Soup session and its input stream stay alive for the
# rest of the session. A single enable would never show it.
#
# This needs a real gnome-shell and so runs locally only; GitHub's runners have
# no GNOME 50.

set -euo pipefail

UUID="quickts@napalm255.github.io"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TIMEOUT="${TIMEOUT:-60}"

# The private XDG directories must be exported BEFORE dbus-run-session starts,
# not after. D-Bus activates dconf as a child of the bus, so a service started
# by a bus that inherited the real XDG_CONFIG_HOME will read and write the
# developer's own dconf database — `gsettings set` then silently affects the
# real session and the shell under test loads the real extension list.
if [[ -z "${QUICKTS_HEADLESS:-}" ]]; then
    QUICKTS_WORK="$(mktemp -d)"
    export QUICKTS_HEADLESS=1
    export QUICKTS_WORK
    export XDG_CONFIG_HOME="$QUICKTS_WORK/config"
    export XDG_DATA_HOME="$QUICKTS_WORK/data"
    export XDG_CACHE_HOME="$QUICKTS_WORK/cache"
    export XDG_RUNTIME_DIR="$QUICKTS_WORK/run"
    mkdir -p "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$XDG_RUNTIME_DIR"
    chmod 700 "$XDG_RUNTIME_DIR"

    exec dbus-run-session -- "${BASH_SOURCE[0]}" "$@"
fi

WORK="$QUICKTS_WORK"
LOG="$WORK/shell.log"

EXT_DIR="$XDG_DATA_HOME/gnome-shell/extensions/$UUID"
mkdir -p "$EXT_DIR"
cp -r "$REPO_ROOT"/metadata.json "$REPO_ROOT"/extension.js "$REPO_ROOT"/prefs.js \
      "$REPO_ROOT"/stylesheet.css "$REPO_ROOT"/modules "$REPO_ROOT"/schemas \
      "$REPO_ROOT"/icons "$EXT_DIR/"
glib-compile-schemas "$EXT_DIR/schemas"

gsettings set org.gnome.shell disable-user-extensions false
gsettings set org.gnome.shell enabled-extensions "['$UUID']"

# Guard against the isolation failing: if dconf were leaking into the real
# session, this would come back holding the developer's extensions.
enabled="$(gsettings get org.gnome.shell enabled-extensions)"
if [[ "$enabled" != "['$UUID']" ]]; then
    echo "FAIL: dconf is not isolated; enabled-extensions = $enabled" >&2
    rm -rf "$WORK"
    exit 1
fi

# The enable marker is logged at debug level, which GLib drops unless asked
# for. Without this the shell starts perfectly and the check still fails.
export G_MESSAGES_DEBUG=all

gnome-shell --wayland --headless --virtual-monitor 3840x1600 >"$LOG" 2>&1 &
SHELL_PID=$!
# shellcheck disable=SC2317  # invoked via trap
cleanup() {
    # Captured first: this trap's own last command would otherwise become the
    # script's exit status, which is how a run that printed PASS still exited 1.
    local status=$?

    kill "$SHELL_PID" 2>/dev/null || true
    wait "$SHELL_PID" 2>/dev/null || true

    # D-Bus activates gvfs inside the throwaway XDG_RUNTIME_DIR, and its fuse
    # mount is not ours to unmount, so the directory may refuse to go. Leaving a
    # few files in /tmp must not turn a passing check into a failing one.
    rm -rf "$WORK" 2>/dev/null || true

    return "$status"
}
trap cleanup EXIT

fail() {
    echo "FAIL: $1" >&2
    echo "---- shell log (quickts and errors only) ----" >&2
    grep -aiE 'quickts|JS ERROR|Extension' "$LOG" >&2 || echo "(nothing matched)" >&2
    exit 1
}

# Counts occurrences rather than truncating between phases: gnome-shell keeps
# the log open, so truncating leaves its file offset intact and the next write
# pads the gap with NULs — grep then reports "binary file matches" and the
# failure diagnostics come out empty at exactly the wrong moment.
wait_for() {
    local pattern="$1" wanted="${2:-1}" waited=0
    while ((waited < TIMEOUT)); do
        (($(grep -ac "$pattern" "$LOG") >= wanted)) && return 0
        kill -0 "$SHELL_PID" 2>/dev/null || fail "gnome-shell exited early"
        sleep 1
        ((waited++))
    done
    return 1
}

wait_for '\[quickts\] enabled' || fail "extension never reported enabled within ${TIMEOUT}s"
echo "ok: enabled"

# A second enable must be as clean as the first.
gnome-extensions disable "$UUID"
sleep 3
gnome-extensions enable "$UUID"
wait_for '\[quickts\] enabled' 2 || fail "extension did not re-enable after disable"
echo "ok: re-enabled after disable"

if grep -qaE 'JS ERROR|Extension .* had error' "$LOG"; then
    fail "javascript errors in the shell log"
fi

if grep -qaiE 'No signal handler|instance with invalid|Object .* has been already deallocated' "$LOG"; then
    fail "signal or object lifetime warnings after re-enable"
fi

# The watch loop must not survive its disable. A source removed without its
# awaiter being settled shows up here, and this is the assertion the replaced
# extension would fail.
if grep -qaiE 'Source ID .* was not found|GSource .* still active' "$LOG"; then
    fail "a GLib source outlived its disable"
fi

echo "ok: no errors or lifetime warnings"
echo "PASS"
