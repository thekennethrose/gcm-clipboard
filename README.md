# GCM Clipboard Manager

GCM is short for GOATed Clipboard Manager.

Clipboard history for GNOME on Ubuntu and Debian. It keeps text and images
up to a history size you choose, finds them with fuzzy or exact search, and
opens its list right at the mouse pointer.

> **Status: v0.1.** The daemon is tested end to end over D-Bus, and the
> shell extension runs day to day on GNOME Shell 46 (Wayland).

## Why it's two pieces

On Wayland only the compositor (GNOME Shell) can read another app's
clipboard, see the global pointer position, or put a window wherever it
wants. A background service alone can't do any of that, and a kernel module
can't either, because the clipboard is a userspace compositor concept the
kernel never sees. So:

| Piece | Runs as | Job |
|---|---|---|
| **daemon/** | systemd user service (Python) | Stores history, enforces the size limit, runs search, serves D-Bus |
| **extension/** | GNOME Shell extension (GJS) | Watches the clipboard, shows the popup, pastes your choice |

If the shell crashes, your history is safe in the daemon, and the daemon
can't take the shell down with it. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Requirements

- GNOME Shell **45 or newer** (Ubuntu 24.04+, Debian 13+)
- `python3` and `python3-gi`, already present on any GNOME desktop
- `git`, `make` and `glib-compile-schemas` to install
  (`sudo apt install git make libglib2.0-bin`)
- Optional, for `make test`: `nodejs` (extension tests are skipped without it)
- Works on Wayland and X11 sessions

## Install

```sh
git clone https://github.com/thekennethrose/gcm-clipboard.git
cd gcm-clipboard
make test          # optional: daemon unit + D-Bus tests, extension tests
make install       # daemon -> systemd user unit, extension -> ~/.local/share
```

Then log out and back in (Wayland needs it to pick up a new extension) and run:

```sh
gnome-extensions enable gcm-clipboard@gcmclipboard.github.io
```

Everything installs per-user and nothing needs root. `make uninstall` removes
it all but leaves your history in `~/.local/share/gcm-clipboard/`.

## Use

Press **Ctrl+Shift+V**.

| Key | Action |
|---|---|
| type | filter |
| ↑ / ↓ | move selection |
| Enter / click | paste the selected entry |
| Tab | switch between fuzzy and exact search |
| ⚙ (gear) | settings, in place of the list (Esc goes back) |
| Ctrl+P | pin / unpin (pinned entries never expire) |
| Shift+Delete | remove from history |
| Esc / click outside | close |

**Fuzzy** matches characters in order with gaps allowed (`gco` finds
`git checkout`), and space-separated words must all match. **Exact** matches
a literal substring. Both use smart case: lowercase queries ignore case,
and any capital letter makes the search case-sensitive.

## Configure

- **Quick settings:** click the gear in the popup to turn auto-paste and
  terminal-aware paste on or off, record a new shortcut (click it, then press
  the keys; Backspace disables it) and set how many entries to keep.
- **Everything else** (default search mode, entries shown, popup width):
  `gnome-extensions prefs gcm-clipboard@gcmclipboard.github.io`
- **History size** is also in `~/.config/gcm-clipboard/daemon.conf`:

  ```ini
  [history]
  max_items = 100          # unpinned entries to keep (1-10000)
  max_text_bytes = 1048576 # larger copies are ignored
  max_image_bytes = 16777216
  ```

## Develop

```
daemon/gcm_clipboard/
  models.py     data types
  payload.py    raw copy -> preview / search text
  store.py      SQLite + image blob files
  search.py     fuzzy & exact matching (pure functions)
  history.py    policy: limits, pruning, change events
  config.py     daemon.conf
  service.py    D-Bus adapter (the only module that imports gi)
  interface.xml the D-Bus contract
  cli.py        debugging client
extension/
  extension.js  wiring only
  lib/          daemonClient, clipboardWatcher, popup, settingsView, historyRow,
                paster, terminals, shortcut, highlight, compat
  prefs.js      settings window
packaging/      systemd unit + D-Bus activation file
```

| Command | What it does |
|---|---|
| `make test` | all tests |
| `make check` | schema validation, JS syntax, Python compile |
| `python3 -m gcm_clipboard.cli list` | poke the running daemon (run from `daemon/`) |
| `make logs` / `make logs-shell` | follow daemon / extension logs |

To try the extension without risking your session, run a nested shell:
`dbus-run-session -- gnome-shell --nested --wayland` on GNOME 45-48, or
`gnome-shell --devkit` on 49+.

## Known limitations (v0.1)

- **Terminal detection is a list of known terminals** (GNOME Terminal,
  Console, Ptyxis, Kitty, Alacritty, WezTerm, Konsole and more). A terminal
  inside another app, like VS Code's, still gets Ctrl+V.
- **Opens at the mouse pointer**, not the text caret.
- **Only the regular clipboard**, not the middle-click PRIMARY selection.
- **Images are PNG only**, and thumbnails decode the full image.
- **Search covers the first 4,000 characters** of each entry.
- **History is stored unencrypted** under `~/.local/share/gcm-clipboard/`.
  Copies that password managers flag as secret are never recorded.

## License

MIT. See [LICENSE](LICENSE).
