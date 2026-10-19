// The history popup: a search box over a scrollable list, opened at the pointer.
//
// Structure: the HistoryPopup actor itself is an invisible backdrop covering
// the whole stage, so a click anywhere outside the panel closes it. The
// visible panel is its only child, positioned near the pointer. The gear in
// the header swaps the list for the settings view at the same size.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';

import {verticalBox} from './compat.js';
import {HistoryRow} from './historyRow.js';
import {DIM_OPACITY, SETTINGS_HINT, SettingsView} from './settingsView.js';

const KEY_HINT = '↑↓ select    ⏎ paste    Tab fuzzy/exact    Ctrl+P pin    Shift+Del remove';

export const HistoryPopup = GObject.registerClass(
class HistoryPopup extends St.Widget {
    /**
     * @param {object} deps
     * @param {import('./daemonClient.js').DaemonClient} deps.client
     * @param {import('gi://Gio').default.Settings} deps.settings
     * @param {(entry: import('./daemonClient.js').HistoryEntry) => void} deps.onChoose
     */
    _init({client, settings, onChoose}) {
        super._init({reactive: true, visible: false});
        this.add_constraint(new Clutter.BindConstraint({
            source: global.stage,
            coordinate: Clutter.BindCoordinate.ALL,
        }));

        this._client = client;
        this._settings = settings;
        this._onChoose = onChoose;

        this._grab = null;
        this._mode = 'fuzzy';
        this._rows = [];
        this._selectedIndex = -1;
        this._lastQuery = null;
        // Bumped on every search and on close. A reply whose number is no
        // longer current is stale (the user kept typing) and gets dropped.
        this._requestSeq = 0;

        this._buildPanel();
        this.connect('button-press-event', () => {
            this.close();
            return Clutter.EVENT_STOP;
        });
    }

    // ---- public -----------------------------------------------------------

    toggle() {
        // While a new shortcut is being recorded, pressing the current one
        // (which Mutter grabs before we see it) just ends the recording.
        if (this._settingsView.isRecording)
            this._settingsView.cancelRecording();
        else if (this.visible)
            this.close();
        else
            this.open();
    }

    open() {
        if (this.visible)
            return;

        const [pointerX, pointerY] = global.get_pointer();
        this.get_parent()?.set_child_above_sibling(this, null);
        this.show();

        this._grab = Main.pushModal(this, {actionMode: Shell.ActionMode.POPUP});
        if ((this._grab.get_seat_state() & Clutter.GrabState.KEYBOARD) === 0) {
            // Something else holds the keyboard (an open menu, say). Back off.
            Main.popModal(this._grab);
            this._grab = null;
            this.hide();
            return;
        }

        this._mode = this._settings.get_string('default-search-mode');
        this._panel.width = this._settings.get_int('popup-width');
        this._lockModeLabelWidth();
        this._updateModeLabel();
        this._searchEntry.set_text('');
        this._placeNear(pointerX, pointerY);
        this._searchEntry.grab_key_focus();
        this._refresh();
    }

    close() {
        if (!this.visible)
            return;
        this._requestSeq++;
        this._showSettings(false);
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this.hide();
        this._setRows([]);
        this._lastQuery = null;
    }

    refreshIfOpen() {
        if (this.visible)
            this._refresh();
    }

    // ---- layout -----------------------------------------------------------

    _buildPanel() {
        // candidate-popup-content: the shell theme's own popup background,
        // border and shadow, so the panel follows light/dark like the shell does.
        this._panel = verticalBox({style_class: 'candidate-popup-content gcm-clipboard-popup', reactive: true});
        // Clicks on the panel's own background must not reach the backdrop.
        this._panel.connect('button-press-event', () => Clutter.EVENT_STOP);

        const header = new St.BoxLayout({style_class: 'gcm-clipboard-header', x_expand: true});
        this._header = header;
        this._searchEntry = new St.Entry({
            style_class: 'gcm-clipboard-search',
            hint_text: 'Search clipboard…',
            can_focus: true,
            x_expand: true,
        });
        this._modeLabel = new St.Label({
            style_class: 'gcm-clipboard-mode',
            y_align: Clutter.ActorAlign.CENTER,
            opacity: DIM_OPACITY,
        });
        const gear = new St.Button({
            style_class: 'icon-button gcm-clipboard-icon-button',
            child: new St.Icon({icon_name: 'emblem-system-symbolic'}),
            accessible_name: 'Settings',
            can_focus: false, // typing stays in the search box
            y_align: Clutter.ActorAlign.CENTER,
        });
        gear.connect('clicked', () => this._showSettings(true));
        header.add_child(this._searchEntry);
        header.add_child(this._modeLabel);
        header.add_child(gear);

        this._list = verticalBox({style_class: 'gcm-clipboard-list', x_expand: true});
        this._scroll = new St.ScrollView({
            style_class: 'gcm-clipboard-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
        });
        this._scroll.set_child(this._list);

        this._status = new St.Label({style_class: 'gcm-clipboard-status', visible: false, opacity: DIM_OPACITY});
        this._hint = new St.Label({style_class: 'gcm-clipboard-hint', text: KEY_HINT, opacity: DIM_OPACITY});

        this._settingsView = new SettingsView({
            client: this._client,
            settings: this._settings,
            onBack: () => this._showSettings(false),
        });
        this._settingsView.actor.visible = false;
        this._inSettings = false;

        for (const child of [header, this._status, this._scroll, this._settingsView.actor, this._hint])
            this._panel.add_child(child);
        this.add_child(this._panel);
        // Key presses bubble up here from whichever settings control has focus.
        this._panel.connect('key-press-event', (_actor, event) =>
            this._inSettings ? this._settingsView.handleKey(event) : Clutter.EVENT_PROPAGATE);

        const text = this._searchEntry.clutter_text;
        text.connect('text-changed', () => this._refresh());
        text.connect('key-press-event', (_actor, event) => this._onKeyPress(event));
    }

    _placeNear(x, y) {
        const area = Main.layoutManager.getWorkAreaForMonitor(global.display.get_current_monitor());
        const width = this._panel.width;
        const [, height] = this._panel.get_preferred_height(width);

        const left = Math.max(area.x, Math.min(x, area.x + area.width - width));
        // Open below the pointer, or above it when there isn't room below.
        const fitsBelow = y + height <= area.y + area.height;
        const top = fitsBelow ? y : Math.max(area.y, y - height);
        this._panel.set_position(Math.round(left), Math.round(top));
    }

    // Pin the label to the wider of its two texts so toggling the mode never
    // resizes the search entry. Measured here because it needs the theme.
    _lockModeLabelWidth() {
        if (this._modeLabelWidth)
            return;
        this._modeLabel.set_width(-1);
        let widest = 0;
        for (const text of ['Fuzzy', 'Exact']) {
            this._modeLabel.text = text;
            widest = Math.max(widest, this._modeLabel.get_preferred_width(-1)[1]);
        }
        this._modeLabelWidth = Math.ceil(widest);
        this._modeLabel.set_width(this._modeLabelWidth);
    }

    _showSettings(show) {
        if (show === this._inSettings)
            return;
        if (show) {
            // Same header height as the list view, so the panel doesn't move.
            this._settingsView.header.height = this._header.height;
        } else {
            this._settingsView.leave();
        }
        this._inSettings = show;
        this._header.visible = !show;
        this._scroll.visible = !show;
        this._status.visible = !show && Boolean(this._status.text);
        this._settingsView.actor.visible = show;
        this._hint.text = show ? SETTINGS_HINT : KEY_HINT;
        if (show)
            this._settingsView.refresh();
        else if (this.visible)
            this._searchEntry.grab_key_focus();
    }

    _updateModeLabel() {
        this._modeLabel.text = this._mode === 'fuzzy' ? 'Fuzzy' : 'Exact';
    }

    _showStatus(message) {
        // A refresh can land while settings are showing (lowering the limit prunes history).
        this._status.visible = Boolean(message) && !this._inSettings;
        this._status.text = message ?? '';
    }

    // ---- data -------------------------------------------------------------

    async _refresh() {
        const seq = ++this._requestSeq;
        const query = this._searchEntry.get_text();
        const limit = this._settings.get_int('result-limit');

        let entries;
        try {
            entries = await this._client.search(query, this._mode, limit);
        } catch (error) {
            console.error(`gcm-clipboard: search failed: ${error.message}`);
            if (seq === this._requestSeq) {
                this._setRows([]);
                this._showStatus('Clipboard daemon is not responding');
            }
            return;
        }
        if (seq !== this._requestSeq)
            return;

        // Same query (e.g. a refresh after pinning): keep the selection where
        // it was. New query: start from the best match.
        const keepId = query === this._lastQuery ? this._selectedEntry()?.id : null;
        this._lastQuery = query;
        this._setRows(entries, keepId);

        if (entries.length === 0)
            this._showStatus(query ? 'No matches' : 'Clipboard history is empty');
        else
            this._showStatus(null);
    }

    _setRows(entries, keepId = null) {
        this._list.destroy_all_children();
        this._selectedIndex = -1;
        this._rows = entries.map(entry => {
            const row = new HistoryRow(entry);
            row.connect('clicked', () => this._choose(entry));
            this._list.add_child(row);
            return row;
        });
        const kept = this._rows.findIndex(row => row.entry.id === keepId);
        this._select(kept >= 0 ? kept : 0);
    }

    // ---- selection & keys -------------------------------------------------

    _select(index) {
        if (this._rows.length === 0)
            return;
        this._rows[this._selectedIndex]?.setSelected(false);
        this._selectedIndex = Math.max(0, Math.min(index, this._rows.length - 1));
        const row = this._rows[this._selectedIndex];
        row.setSelected(true);
        ensureActorVisibleInScrollView(this._scroll, row);
    }

    _selectedEntry() {
        return this._rows[this._selectedIndex]?.entry ?? null;
    }

    _choose(entry) {
        this.close();
        this._onChoose(entry);
    }

    _onKeyPress(event) {
        const key = event.get_key_symbol();
        const state = event.get_state();
        const ctrl = (state & Clutter.ModifierType.CONTROL_MASK) !== 0;
        const shift = (state & Clutter.ModifierType.SHIFT_MASK) !== 0;
        const entry = this._selectedEntry();

        switch (key) {
        case Clutter.KEY_Escape:
            this.close();
            break;
        case Clutter.KEY_Down:
            this._select(this._selectedIndex + 1);
            break;
        case Clutter.KEY_Up:
            this._select(this._selectedIndex - 1);
            break;
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
            if (entry)
                this._choose(entry);
            break;
        case Clutter.KEY_Tab:
        case Clutter.KEY_ISO_Left_Tab:
            this._mode = this._mode === 'fuzzy' ? 'exact' : 'fuzzy';
            this._updateModeLabel();
            this._refresh();
            break;
        case Clutter.KEY_Delete:
            if (!shift)
                return Clutter.EVENT_PROPAGATE; // plain Delete edits the search text
            if (entry)
                this._client.delete(entry.id).catch(logFailure('delete entry'));
            break;
        case Clutter.KEY_p:
        case Clutter.KEY_P:
            if (!ctrl)
                return Clutter.EVENT_PROPAGATE;
            if (entry)
                this._client.setPinned(entry.id, !entry.pinned).catch(logFailure('toggle pin'));
            break;
        default:
            return Clutter.EVENT_PROPAGATE;
        }
        // The daemon's HistoryChanged signal triggers the refresh after
        // delete/pin, so there's nothing more to do here.
        return Clutter.EVENT_STOP;
    }
});

function logFailure(what) {
    return error => console.error(`gcm-clipboard: failed to ${what}: ${error.message}`);
}
