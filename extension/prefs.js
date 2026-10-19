// Preferences window (runs in its own process, not inside the shell).
//
// UI settings go through GSettings. History size belongs to the daemon, so
// it's read and written over D-Bus: one source of truth.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {BUS_NAME, INTERFACE, OBJECT_PATH} from './lib/dbusNames.js';

const PROPERTIES = 'org.freedesktop.DBus.Properties';
const MODES = ['fuzzy', 'exact'];
// Lowering the limit deletes entries, so wait for the user to stop spinning.
const MAX_ITEMS_APPLY_DELAY_MS = 800;

export default class GcmClipboardPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        page.add(historyGroup());
        page.add(popupGroup(settings));
        window.add(page);
    }
}

// ---- History (daemon) --------------------------------------------------------

function historyGroup() {
    const group = new Adw.PreferencesGroup({title: 'History'});
    const row = Adw.SpinRow.new_with_range(1, 10000, 10);
    row.title = 'Entries to keep';
    row.subtitle = 'Pinned entries don’t count toward this';
    group.add(row);

    const current = readMaxItems();
    if (current === null) {
        row.sensitive = false;
        row.subtitle = 'Daemon not reachable. Is gcm-clipboard.service running?';
        return group;
    }
    row.value = current;

    let pendingId = 0;
    row.connect('notify::value', () => {
        if (pendingId)
            GLib.source_remove(pendingId);
        pendingId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, MAX_ITEMS_APPLY_DELAY_MS, () => {
            pendingId = 0;
            writeMaxItems(Math.round(row.value));
            return GLib.SOURCE_REMOVE;
        });
    });
    return group;
}

function readMaxItems() {
    try {
        const reply = Gio.DBus.session.call_sync(
            BUS_NAME, OBJECT_PATH, PROPERTIES, 'Get',
            new GLib.Variant('(ss)', [INTERFACE, 'MaxItems']),
            new GLib.VariantType('(v)'), Gio.DBusCallFlags.NONE, 2000, null);
        return reply.recursiveUnpack()[0];
    } catch (error) {
        console.warn(`gcm-clipboard prefs: ${error.message}`);
        return null;
    }
}

function writeMaxItems(value) {
    Gio.DBus.session.call(
        BUS_NAME, OBJECT_PATH, PROPERTIES, 'Set',
        new GLib.Variant('(ssv)', [INTERFACE, 'MaxItems', new GLib.Variant('u', value)]),
        null, Gio.DBusCallFlags.NONE, 2000, null,
        (bus, result) => {
            try {
                bus.call_finish(result);
            } catch (error) {
                console.warn(`gcm-clipboard prefs: ${error.message}`);
            }
        });
}

// ---- Popup (GSettings) -------------------------------------------------------

function popupGroup(settings) {
    const group = new Adw.PreferencesGroup({title: 'Popup'});
    group.add(shortcutRow(settings));

    const autoPaste = new Adw.SwitchRow({
        title: 'Paste after choosing',
        subtitle: 'Sends Ctrl+V to the focused app',
    });
    settings.bind('auto-paste', autoPaste, 'active', Gio.SettingsBindFlags.DEFAULT);
    group.add(autoPaste);

    const terminalAware = new Adw.SwitchRow({
        title: 'Terminal-aware paste',
        subtitle: 'Uses Ctrl+Shift+V when a terminal is focused',
    });
    settings.bind('terminal-aware-paste', terminalAware, 'active', Gio.SettingsBindFlags.DEFAULT);
    // Only matters when GCM does the pasting.
    settings.bind('auto-paste', terminalAware, 'sensitive', Gio.SettingsBindFlags.GET);
    group.add(terminalAware);

    const mode = new Adw.ComboRow({
        title: 'Default search mode',
        subtitle: 'Tab switches while the popup is open',
        model: Gtk.StringList.new(['Fuzzy', 'Exact']),
    });
    // Set after construction: `selected` given alongside `model` can be reset.
    mode.selected = Math.max(0, MODES.indexOf(settings.get_string('default-search-mode')));
    mode.connect('notify::selected', () =>
        settings.set_string('default-search-mode', MODES[mode.selected]));
    group.add(mode);

    group.add(spinRow(settings, 'result-limit', 'Entries shown', 5, 500, 5));
    group.add(spinRow(settings, 'popup-width', 'Width (px)', 280, 1200, 20));
    return group;
}

function shortcutRow(settings) {
    const row = new Adw.EntryRow({
        title: 'Shortcut, e.g. <Super><Shift>v',
        text: settings.get_strv('toggle-popup')[0] ?? '',
        show_apply_button: true,
    });
    row.connect('apply', () => {
        const accel = row.text.trim();
        const [valid] = Gtk.accelerator_parse(accel);
        if (valid) {
            settings.set_strv('toggle-popup', [accel]);
            row.remove_css_class('error');
        } else {
            row.add_css_class('error');
        }
    });
    return row;
}

function spinRow(settings, key, title, min, max, step) {
    const row = Adw.SpinRow.new_with_range(min, max, step);
    row.title = title;
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}
