// In-popup settings: auto-paste, terminal-aware paste, the shortcut and the
// history size. The popup swaps this in for the history list at the same
// size, so the panel never jumps. Colors all come from the shell theme's own
// classes, so light/dark and the accent color follow the system.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {Switch} from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {verticalBox} from './compat.js';
import {accelFromKey, formatAccel} from './shortcut.js';

export const SETTINGS_HINT = 'Esc back    Tab next setting    Space toggle';

const SHORTCUT_KEY = 'toggle-popup';
const MAX_ITEMS_MIN = 1;
const MAX_ITEMS_MAX = 10000;
const MAX_ITEMS_STEP = 10;
// Lowering the limit deletes entries, so wait for the user to stop clicking or typing.
const MAX_ITEMS_APPLY_DELAY_MS = 800;
// Secondary text: the theme's own text color at reduced opacity, so it suits light and dark.
export const DIM_OPACITY = 166;
const INSENSITIVE_OPACITY = 115;

export class SettingsView {
    /**
     * @param {object} deps
     * @param {import('./daemonClient.js').DaemonClient} deps.client
     * @param {import('gi://Gio').default.Settings} deps.settings
     * @param {() => void} deps.onBack
     */
    constructor({client, settings, onBack}) {
        this._client = client;
        this._settings = settings;
        this._onBack = onBack;
        this._recording = false;
        this._applyId = 0;
        this._settingsIds = [];

        this.actor = verticalBox({style_class: 'gcm-clipboard-settings-view', x_expand: true});
        this.header = this._buildHeader();
        this.actor.add_child(this.header);
        this.actor.add_child(this._buildBody());
        this.actor.connect('destroy', () => this._onDestroy());
    }

    get isRecording() {
        return this._recording;
    }

    /** Called each time the view is shown. */
    async refresh() {
        this._syncShortcut();
        this._autoPasteRow.grab_key_focus();
        try {
            this._setCount(await this._client.getMaxItems());
            this._setCountEnabled(true);
            this._countSubtitle.text = 'Pinned entries don’t count';
        } catch (error) {
            console.warn(`gcm-clipboard: failed to read history size: ${error.message}`);
            this._setCount('');
            this._setCountEnabled(false);
            this._countSubtitle.text = 'Clipboard daemon is not responding';
        }
    }

    /** Called when the view is hidden: finish anything in flight. */
    leave() {
        this.cancelRecording();
        if (this._applyId) {
            GLib.source_remove(this._applyId);
            this._applyId = 0;
            this._applyCount();
        }
    }

    cancelRecording() {
        if (!this._recording)
            return;
        this._recording = false;
        this._shortcutButton.remove_style_pseudo_class('checked');
        this._syncShortcut();
    }

    /** Key presses that reach the panel while this view is showing. */
    handleKey(event) {
        const key = event.get_key_symbol();
        if (this._recording)
            return this._recordKey(event, key);

        switch (key) {
        case Clutter.KEY_Escape:
            this._onBack();
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Tab:
        case Clutter.KEY_Down:
            this._moveFocus(St.DirectionType.TAB_FORWARD);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_ISO_Left_Tab:
        case Clutter.KEY_Up:
            this._moveFocus(St.DirectionType.TAB_BACKWARD);
            return Clutter.EVENT_STOP;
        default:
            return Clutter.EVENT_PROPAGATE;
        }
    }

    // ---- layout -----------------------------------------------------------

    _buildHeader() {
        const header = new St.BoxLayout({style_class: 'gcm-clipboard-header', x_expand: true});
        const back = iconButton('go-previous-symbolic', 'Back to history');
        back.connect('clicked', () => this._onBack());
        const title = new St.Label({
            style_class: 'gcm-clipboard-settings-title',
            text: 'Settings',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const gear = iconButton('emblem-system-symbolic', 'Close settings');
        gear.add_style_pseudo_class('checked');
        gear.connect('clicked', () => this._onBack());

        header.add_child(back);
        header.add_child(title);
        header.add_child(gear);
        return header;
    }

    _buildBody() {
        const body = verticalBox({style_class: 'gcm-clipboard-settings', x_expand: true});

        this._autoPasteRow = this._switchRow(
            'Paste after choosing', 'Sends Ctrl+V to the focused app', 'auto-paste');
        this._terminalRow = this._switchRow(
            'Terminal-aware paste', 'Uses Ctrl+Shift+V when a terminal is focused',
            'terminal-aware-paste');
        // Terminal-aware only matters when GCM does the pasting.
        this._watch('changed::auto-paste', () => this._syncTerminalRow());
        this._syncTerminalRow();

        for (const child of [
            this._autoPasteRow, separator(),
            this._terminalRow, separator(),
            this._shortcutRow(), separator(),
            this._countRowBuild(),
        ])
            body.add_child(child);
        return body;
    }

    _switchRow(title, subtitle, key) {
        const toggle = new Switch(this._settings.get_boolean(key));
        toggle.y_align = Clutter.ActorAlign.CENTER;
        const row = settingRow(title, subtitle, toggle, {button: true});
        row.accessible_name = title;
        row.connect('clicked', () => this._settings.set_boolean(key, !this._settings.get_boolean(key)));
        this._watch(`changed::${key}`, () => (toggle.state = this._settings.get_boolean(key)));
        return row;
    }

    _shortcutRow() {
        this._shortcutButton = new St.Button({
            style_class: 'button gcm-clipboard-shortcut',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._shortcutButton.connect('clicked', () => this._startRecording());
        // Connected handlers run before St.Button's own, which would otherwise
        // take Space/Enter as a click instead of part of the new shortcut.
        this._shortcutButton.connect('key-press-event', (_actor, event) =>
            this._recording ? this._recordKey(event, event.get_key_symbol()) : Clutter.EVENT_PROPAGATE);
        const row = settingRow('Shortcut', 'Opens this popup', this._shortcutButton);
        this._shortcutSubtitle = row.subtitle;
        this._watch(`changed::${SHORTCUT_KEY}`, () => this._syncShortcut());
        return row;
    }

    _countRowBuild() {
        const minus = iconButton('list-remove-symbolic', 'Fewer entries');
        const plus = iconButton('list-add-symbolic', 'More entries');
        this._countEntry = new St.Entry({
            style_class: 'gcm-clipboard-count',
            can_focus: true,
            input_purpose: Clutter.InputContentPurpose.DIGITS,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._countEntry.clutter_text.connect('text-changed', () => this._scheduleApply());
        this._countEntry.clutter_text.connect('activate', () => this._applyNow());
        minus.connect('clicked', () => this._step(-MAX_ITEMS_STEP));
        plus.connect('clicked', () => this._step(MAX_ITEMS_STEP));
        this._countControls = [minus, this._countEntry, plus];

        const stepper = new St.BoxLayout({style_class: 'gcm-clipboard-stepper', y_align: Clutter.ActorAlign.CENTER});
        stepper.add_child(minus);
        stepper.add_child(this._countEntry);
        stepper.add_child(plus);

        this._countRow = settingRow('Entries to keep', 'Pinned entries don’t count', stepper);
        this._countSubtitle = this._countRow.subtitle;
        return this._countRow;
    }

    // ---- behaviour --------------------------------------------------------

    _syncTerminalRow() {
        const enabled = this._settings.get_boolean('auto-paste');
        this._terminalRow.reactive = enabled;
        this._terminalRow.can_focus = enabled;
        this._terminalRow.opacity = enabled ? 255 : INSENSITIVE_OPACITY;
    }

    _syncShortcut() {
        if (this._recording) {
            this._shortcutButton.label = 'Press new shortcut…';
            this._shortcutSubtitle.text = 'Esc cancels · Backspace disables';
            return;
        }
        const accel = this._settings.get_strv(SHORTCUT_KEY)[0] ?? '';
        this._shortcutButton.label = formatAccel(accel);
        this._shortcutButton.accessible_name = `Change shortcut, currently ${formatAccel(accel)}`;
        this._shortcutSubtitle.text = 'Opens this popup';
    }

    _startRecording() {
        this._recording = true;
        this._shortcutButton.add_style_pseudo_class('checked');
        this._shortcutButton.grab_key_focus();
        this._syncShortcut();
    }

    _recordKey(event, key) {
        if (key === Clutter.KEY_Escape) {
            this.cancelRecording();
        } else if (key === Clutter.KEY_BackSpace) {
            this._settings.set_strv(SHORTCUT_KEY, []);
            this.cancelRecording();
        } else {
            const state = event.get_state();
            const accel = accelFromKey(Clutter.keyval_name(key), {
                ctrl: (state & Clutter.ModifierType.CONTROL_MASK) !== 0,
                alt: (state & Clutter.ModifierType.MOD1_MASK) !== 0,
                super: (state & Clutter.ModifierType.MOD4_MASK) !== 0,
                shift: (state & Clutter.ModifierType.SHIFT_MASK) !== 0,
            });
            if (accel) {
                // Mutter re-reads the binding as soon as the setting changes.
                this._settings.set_strv(SHORTCUT_KEY, [accel]);
                this.cancelRecording();
            }
        }
        return Clutter.EVENT_STOP;
    }

    _moveFocus(direction) {
        const focus = global.stage.get_key_focus();
        this.actor.navigate_focus(this.actor.contains(focus) ? focus : null, direction, true);
    }

    _setCountEnabled(enabled) {
        for (const control of this._countControls) {
            control.reactive = enabled;
            control.can_focus = enabled;
        }
        this._countRow.opacity = enabled ? 255 : INSENSITIVE_OPACITY;
    }

    _setCount(value) {
        this._countEntry.text = String(value);
        // Showing the daemon's value is not a user edit: nothing to apply.
        if (this._applyId) {
            GLib.source_remove(this._applyId);
            this._applyId = 0;
        }
    }

    _step(delta) {
        const current = parseInt(this._countEntry.text, 10);
        const base = Number.isNaN(current) ? MAX_ITEMS_MIN : current;
        this._countEntry.text = String(clampCount(base + delta));
    }

    _scheduleApply() {
        if (this._applyId)
            GLib.source_remove(this._applyId);
        this._applyId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, MAX_ITEMS_APPLY_DELAY_MS, () => {
            this._applyId = 0;
            this._applyCount();
            return GLib.SOURCE_REMOVE;
        });
    }

    _applyNow() {
        if (this._applyId) {
            GLib.source_remove(this._applyId);
            this._applyId = 0;
        }
        this._applyCount();
    }

    _applyCount() {
        const value = parseInt(this._countEntry.text, 10);
        if (Number.isNaN(value))
            return;
        const clamped = clampCount(value);
        if (String(clamped) !== this._countEntry.text)
            this._setCount(clamped);
        this._client.setMaxItems(clamped).catch(error =>
            console.error(`gcm-clipboard: failed to set history size: ${error.message}`));
    }

    _watch(signal, callback) {
        this._settingsIds.push(this._settings.connect(signal, callback));
    }

    _onDestroy() {
        if (this._applyId)
            GLib.source_remove(this._applyId);
        this._applyId = 0;
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];
    }
}

function clampCount(value) {
    return Math.max(MAX_ITEMS_MIN, Math.min(MAX_ITEMS_MAX, value));
}

/**
 * Title and subtitle on the left, a control on the right. A button row toggles
 * on click/Space (switches); a plain row hosts its own focusable controls.
 */
function settingRow(title, subtitle, control, {button = false} = {}) {
    const text = verticalBox({style_class: 'gcm-clipboard-setting-text', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
    text.add_child(new St.Label({style_class: 'gcm-clipboard-setting-title', text: title}));
    const subtitleLabel = new St.Label({style_class: 'gcm-clipboard-setting-subtitle', text: subtitle, opacity: DIM_OPACITY});
    text.add_child(subtitleLabel);

    const box = new St.BoxLayout({style_class: 'gcm-clipboard-setting-box', x_expand: true});
    box.add_child(text);
    box.add_child(control);

    const row = button
        ? new St.Button({style_class: 'popup-menu-item gcm-clipboard-setting', child: box, can_focus: true, x_expand: true})
        : new St.Bin({style_class: 'gcm-clipboard-setting', child: box, x_expand: true});
    row.subtitle = subtitleLabel;
    return row;
}

function iconButton(iconName, accessibleName) {
    return new St.Button({
        style_class: 'icon-button gcm-clipboard-icon-button',
        child: new St.Icon({icon_name: iconName}),
        accessible_name: accessibleName,
        can_focus: true,
        y_align: Clutter.ActorAlign.CENTER,
    });
}

function separator() {
    // Nested like PopupSeparatorMenuItem so the theme's separator color applies.
    const line = new St.Widget({style_class: 'popup-separator-menu-item-separator', x_expand: true});
    return new St.Bin({style_class: 'popup-separator-menu-item gcm-clipboard-separator', child: line, x_expand: true});
}
