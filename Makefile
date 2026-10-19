# GCM Clipboard Manager: build, test, install (per-user, no root needed).

UUID     := gcm-clipboard@gcmclipboard.github.io
LIB_DIR  := $(HOME)/.local/lib/gcm-clipboard
EXT_DIR  := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
UNIT_DIR := $(HOME)/.config/systemd/user
DBUS_DIR := $(HOME)/.local/share/dbus-1/services

EXT_FILES := metadata.json extension.js prefs.js stylesheet.css lib schemas

.PHONY: all test test-daemon test-dbus test-extension check install install-daemon \
        install-extension uninstall logs logs-shell

all: check test

# ---- tests -------------------------------------------------------------------

test: test-daemon test-dbus test-extension

test-daemon:
	cd daemon && python3 -m unittest discover -s tests -t .

# Spins up a private session bus so it never touches a daemon you're running.
test-dbus:
	cd daemon && GCM_CLIPBOARD_DBUS_TEST=1 dbus-run-session -- python3 -m unittest tests.test_service

# Node is only needed for the extension tests and JS syntax checks; both are
# skipped (with a note) on machines that don't have it.
test-extension:
	@if command -v node >/dev/null; then node --test extension/tests/*.test.mjs; \
	else echo "node not found: skipping extension tests"; fi

# Static checks for things we can't run outside GNOME Shell.
check:
	glib-compile-schemas --strict --dry-run extension/schemas
	@if command -v node >/dev/null; then \
		for f in extension/*.js extension/lib/*.js; do node --check $$f || exit 1; done; \
	else echo "node not found: skipping JS syntax check"; fi
	python3 -m compileall -q daemon/gcm_clipboard
	@echo "checks passed"

# ---- install -----------------------------------------------------------------

install: install-daemon install-extension

install-daemon:
	mkdir -p $(LIB_DIR) $(UNIT_DIR) $(DBUS_DIR)
	rm -rf $(LIB_DIR)/gcm_clipboard
	cp -r daemon/gcm_clipboard $(LIB_DIR)/
	cp packaging/gcm-clipboard.service $(UNIT_DIR)/
	cp packaging/io.github.gcmclipboard.Daemon.service $(DBUS_DIR)/
	systemctl --user daemon-reload
	systemctl --user enable --now gcm-clipboard.service
	systemctl --user restart gcm-clipboard.service

install-extension:
	rm -rf $(EXT_DIR)
	mkdir -p $(EXT_DIR)
	cd extension && cp -r $(EXT_FILES) $(EXT_DIR)/
	glib-compile-schemas $(EXT_DIR)/schemas
	@echo
	@echo "Extension installed. On Wayland, log out and back in, then run:"
	@echo "  gnome-extensions enable $(UUID)"

uninstall:
	-systemctl --user disable --now gcm-clipboard.service
	rm -f $(UNIT_DIR)/gcm-clipboard.service $(DBUS_DIR)/io.github.gcmclipboard.Daemon.service
	rm -rf $(LIB_DIR) $(EXT_DIR)
	systemctl --user daemon-reload
	@echo "History kept in ~/.local/share/gcm-clipboard (delete it yourself if you want it gone)."

# ---- debugging ---------------------------------------------------------------

logs:
	journalctl --user -f -u gcm-clipboard.service

logs-shell:
	journalctl -f -o cat /usr/bin/gnome-shell | grep --line-buffered gcm-clipboard
