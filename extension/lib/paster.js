// Puts a chosen entry back on the clipboard and (optionally) types Ctrl+V,
// or Ctrl+Shift+V for terminals, into the window that had focus before the
// popup opened.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {isTerminal} from './terminals.js';

// After the popup releases its grab, focus needs a moment to land back on
// the app window before the synthetic keystroke arrives.
const PASTE_DELAY_MS = 60;

export class Paster {
    constructor() {
        const seat = Clutter.get_default_backend().get_default_seat();
        this._keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        this._pasteTimeoutId = 0;
    }

    destroy() {
        if (this._pasteTimeoutId)
            GLib.source_remove(this._pasteTimeoutId);
        this._pasteTimeoutId = 0;
        this._keyboard = null;
    }

    /** @param {{mime: string, bytes: GLib.Bytes}} content */
    setClipboard({mime, bytes}) {
        const clipboard = St.Clipboard.get_default();
        const type = St.ClipboardType.CLIPBOARD;
        if (mime.startsWith('text/'))
            clipboard.set_text(type, new TextDecoder().decode(bytes.get_data()));
        else
            clipboard.set_content(type, mime, bytes);
    }

    /** @param {{terminalAware?: boolean}} [options] */
    pasteSoon({terminalAware = false} = {}) {
        if (this._pasteTimeoutId)
            GLib.source_remove(this._pasteTimeoutId);
        this._pasteTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PASTE_DELAY_MS, () => {
            this._pasteTimeoutId = 0;
            // Checked now, not when the popup opened: this is the window that gets the keys.
            this._pressPaste(terminalAware && focusedWindowIsTerminal());
            return GLib.SOURCE_REMOVE;
        });
    }

    _pressPaste(withShift) {
        const now = GLib.get_monotonic_time();
        const press = (key, state) => this._keyboard.notify_keyval(now, key, state);
        press(Clutter.KEY_Control_L, Clutter.KeyState.PRESSED);
        if (withShift)
            press(Clutter.KEY_Shift_L, Clutter.KeyState.PRESSED);
        press(Clutter.KEY_v, Clutter.KeyState.PRESSED);
        press(Clutter.KEY_v, Clutter.KeyState.RELEASED);
        if (withShift)
            press(Clutter.KEY_Shift_L, Clutter.KeyState.RELEASED);
        press(Clutter.KEY_Control_L, Clutter.KeyState.RELEASED);
    }
}

function focusedWindowIsTerminal() {
    const window = global.display.focus_window;
    if (!window)
        return false;
    const app = Shell.WindowTracker.get_default().get_window_app(window);
    return isTerminal({wmClass: window.get_wm_class(), appId: app?.get_id() ?? null});
}
