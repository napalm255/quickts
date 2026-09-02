set shell := ["bash", "-euo", "pipefail", "-c"]

# Derived, so metadata.json is the only place the uuid is written down.
uuid := shell("jq -r .uuid metadata.json")
install_dir := env_var('HOME') / ".local/share/gnome-shell/extensions" / uuid
src := "metadata.json extension.js prefs.js modules schemas icons stylesheet.css"

# List available recipes
default:
    @just --list

# Install dependencies and dev tooling
setup:
    mise install
    npm ci
    @for tool in gjs glib-compile-schemas gnome-shell; do \
        command -v "$tool" >/dev/null \
            || { echo "missing $tool — dnf install gjs glib2-devel gnome-shell"; exit 1; }; \
    done
    @echo "ready"

# Format code in place
fmt:
    npx prettier --write .
    npx eslint --fix .

# Static analysis; changes nothing
lint:
    npx eslint .
    npx prettier --check .
    glib-compile-schemas --strict --dry-run schemas
    shellcheck scripts/*.sh

# Run the unit suite
test *args:
    npx vitest run {{ args }}

# Unit suite with a coverage report
coverage:
    npx vitest run --coverage

# All three need something CI has not got: a real Shell, or a real tailscaled.
# Smoke-test in a headless gnome-shell, check the bundle, probe the live daemon
test-live:
    ./scripts/headless-check.sh
    ./scripts/pack-check.sh
    ./scripts/localapi-check.sh

# Check modules/io.js against the tailscaled running on this machine
localapi-check:
    ./scripts/localapi-check.sh

# Compare the built zip against what gnome-extensions pack produces
pack-check: build
    ./scripts/pack-check.sh

# Serve the documentation site locally
docs:
    @echo "http://localhost:8000"
    python3 -m http.server 8000 --directory docs

# Full local security scan
security:
    osv-scanner scan source --lockfile=package-lock.json
    gitleaks detect --no-banner --redact
    trivy fs --scanners vuln,secret,misconfig --exit-code 1 .
    actionlint
    zizmor .github/workflows/

# `ci` runs lint before this; a standalone `just build` deliberately does not,
# so it stays quick to iterate with.
# Produce the installable zip
build:
    rm -f {{ uuid }}.shell-extension.zip
    zip -qr {{ uuid }}.shell-extension.zip {{ src }} -x 'schemas/gschemas.compiled'
    @echo "built {{ uuid }}.shell-extension.zip"

# Run a nested gnome-shell to try the extension by hand
run:
    dbus-run-session -- gnome-shell --wayland

# Copy the extension into the user extensions directory
install:
    mkdir -p {{ install_dir }}
    rsync -a --delete --exclude '.git' {{ src }} {{ install_dir }}/
    glib-compile-schemas {{ install_dir }}/schemas

# Enable the extension
enable:
    gnome-extensions enable {{ uuid }}

# Disable the extension
disable:
    gnome-extensions disable {{ uuid }}

# Open the preferences window
prefs:
    gnome-extensions prefs {{ uuid }}

# Follow the extension's log output
logs:
    journalctl -f -o cat /usr/bin/gnome-shell | grep -i --line-buffered "quickts"

# Remove build output
[confirm("remove node_modules, coverage, the zip and compiled schemas?")]
clean:
    rm -rf node_modules coverage
    rm -f {{ uuid }}.shell-extension.zip schemas/gschemas.compiled

# Everything CI runs, in order
ci: lint test security build
