# GCM Clipboard Manager: architecture

## The constraint that shapes everything

GNOME on Wayland gives ordinary apps three hard "no"s:

1. **No reading the clipboard unless you're focused.** A background process
   can't watch copies.
2. **No global pointer position.** A client doesn't know where the mouse is
   outside its own windows.
3. **No absolute window placement.** A client can't say "put me at (x, y)".

Other compositors work around (1) with the `wlr-data-control` protocol, but
Mutter doesn't implement it. A kernel module doesn't help either: the
clipboard is negotiated between apps through the compositor, entirely in
userspace.

The only code that can do all three is code running *inside* GNOME Shell,
which means an extension. But a shell extension is a risky place for state:
it shares a process with the compositor, so a bug can freeze the desktop and
there's no clean test harness. So we split it the way GPaste does:

```
┌──────────────────── gnome-shell process ────────────────────┐
│                                                             │
│  ClipboardWatcher ─ Meta.Selection "owner-changed"          │
│        │ text / PNG                                         │
│        ▼                                                    │
│  DaemonClient ◀──── HistoryPopup ◀── keybinding             │
│        │   ▲            │ chosen entry                      │
│        │   │            ▼                                   │
│        │   │         Paster ─ St.Clipboard + virtual Ctrl+V │
└────────┼───┼────────────────────────────────────────────────┘
         │   │  session D-Bus: io.github.gcmclipboard.Daemon
┌────────▼───┴─────── gcm-clipboard.service (systemd --user) ─┐
│  service.py   D-Bus ⇄ Python                                │
│  history.py   limits, pruning, change notifications         │
│  search.py    fuzzy / exact ranking                         │
│  store.py     SQLite (text + metadata), blobs/ (images)     │
└─────────────────────────────────────────────────────────────┘
```

## Lifecycle

- **Copy:** an app takes clipboard ownership → Mutter emits `owner-changed`
  → the watcher reads the content (text preferred, else `image/png`) → `AddText`
  or `AddImage` → the daemon dedups by SHA-256, prunes to `MaxItems`, and emits
  `HistoryChanged`.
- **Open:** shortcut → the popup takes a modal grab, reads the pointer, and
  places itself in the current monitor's work area (flipping above the
  pointer near the bottom edge) → `Search("", mode, limit)`.
- **Type:** each keystroke sends `Search`. Every request gets a sequence
  number, and replies that aren't the latest are dropped, so a slow reply
  for `"ab"` can never overwrite the results for `"abc"`.
- **Choose:** `GetContent` → put it on the clipboard → close the popup →
  60 ms later, a virtual keyboard sends Ctrl+V (Ctrl+Shift+V for a terminal)
  to the window that now has focus again. Mutter would take those keys as our
  own shortcut when they match it, as the default Ctrl+Shift+V does, so the
  shortcut is unregistered while they're sent and comes back 250 ms later.
  Setting the clipboard fires `owner-changed` again, the copy is
  re-added, and dedup bumps it to the top. That gives "most recently used"
  ordering without any extra code.

The daemon is **D-Bus activated**: the first call to its bus name starts the
systemd unit, so the extension never has to start or supervise it.

## Module responsibilities

Each module has one reason to change.

| Module | Owns | Doesn't know about |
|---|---|---|
| `payload.py` | how a raw copy becomes a preview + search key | storage, D-Bus |
| `store.py` | the SQLite schema, blob files, dedup, recency stamps | limits, search |
| `search.py` | matching and scoring (pure functions) | anything with I/O |
| `history.py` | policy: size caps, retention, change events | D-Bus, files |
| `config.py` | `daemon.conf` load/validate/save | everything else |
| `service.py` | D-Bus marshalling and errors | policy |
| `clipboardWatcher.js` | detecting and reading copies | the daemon, the UI |
| `daemonClient.js` | D-Bus calls as promises | the UI |
| `popup.js` / `historyRow.js` | the UI, keys, layout | D-Bus details |
| `paster.js` | setting the clipboard and synthesizing Ctrl+V | history |
| `compat.js` | St API differences between shell versions | — |

Only `service.py` and `cli.py` import `gi`, which is why the core runs
under plain `unittest` with no desktop at all.

## Storage

```
~/.local/share/gcm-clipboard/
  history.sqlite3     one row per entry: kind, mime, digest, text, search_key, last_used, pinned
  blobs/<sha256>.png  image bytes; the extension reads thumbnails straight from here
~/.config/gcm-clipboard/daemon.conf
```

- **Dedup:** `digest` is UNIQUE. Re-copying updates `last_used` and nothing else.
- **Ordering:** `last_used` is stamped strictly increasing, even if the
  wall clock stalls or steps backwards, so "newest" is always well defined.
  `History.search` lists pinned entries above all others, with or without a
  query; each group is ranked on its own and the result limit applies after.
- **Retention:** after every add, unpinned rows beyond the newest `max_items`
  are deleted along with their blob files. Pinned rows never count against
  the limit and never expire.
- **Crash safety:** blobs are written to `*.partial` and renamed into place,
  and on startup any blob the database doesn't reference gets swept.

## Search

`search_key` is the entry's text, whitespace-collapsed and capped at 4,000
characters. The popup's preview is the first 300 characters of that same
string, so the match positions search returns highlight the preview directly.

**Fuzzy** is a simplified version of fzf's v1 algorithm:

1. **Forward scan** with `str.find`, one call per query character: is the
   query a subsequence at all, and where's the earliest a match can end?
2. **Backward scan** with `str.rfind` from that end, to find the tightest window.
3. **Score** that window: +16 per character, bonuses for word boundaries
   (+8), camelCase humps (+7), and consecutive runs (+4), the first
   character's bonus doubled, and penalties for gaps (−3 to open, −1 per
   extra character).

Steps 1 and 2 are C-speed string searches, so rejecting a non-match is cheap.
Ties go to the more recent entry, because a stable sort preserves the
newest-first input order.

**Exact** is a smart-case substring match that prefers the first occurrence
starting on a word boundary.

Measured on 10,000 entries (the maximum): 10–45 ms per query, depending on
the query. At the default of 100 entries it doesn't register. The index is
built in memory on first search and dropped whenever history changes.

## D-Bus API

[`daemon/gcm_clipboard/interface.xml`](../daemon/gcm_clipboard/interface.xml) is the
contract, documented inline. In short: `AddText`, `AddImage`, `Search`,
`GetContent`, `Delete`, `SetPinned`, `Clear`, a read/write `MaxItems`
property, and a `HistoryChanged` signal.

## Decisions worth knowing

- **The daemon owns `MaxItems`; the extension owns UI settings.** History
  size is a property of the data, so it lives with the data. That gives one
  source of truth, and it works the same from the CLI.
- **Text beats image when both are offered.** Office apps attach a rendered
  PNG to cell and text copies, while browser "Copy Image" offers no plain
  text, so this rule gets both cases right.
- **No caret positioning yet.** The text caret's position is only known
  through the input-method path (text-input-v3), which is private shell
  API. The pointer is reliable everywhere.

## Roadmap

1. First run on real GNOME 46–50: fix whatever the API reality disagrees with.
2. Terminal-aware paste (Ctrl+Shift+V when the focused window is a terminal).
3. Daemon-generated thumbnails, so the popup doesn't decode full images.
4. Optional PRIMARY-selection capture.
5. Per-app ignore list, and auto-expiry by age.
6. `.deb` packaging.
