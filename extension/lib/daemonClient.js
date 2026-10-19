// Promise-based client for the daemon's D-Bus API (daemon/gcm_clipboard/interface.xml).
//
// Plain connection calls rather than a proxy object: there's nothing to set
// up asynchronously, and if the daemon isn't running the first call starts
// it through D-Bus activation.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {BUS_NAME, INTERFACE, OBJECT_PATH} from './dbusNames.js';

const CALL_TIMEOUT_MS = 3000;
const PROPERTIES = 'org.freedesktop.DBus.Properties';

/**
 * @typedef {object} HistoryEntry
 * @property {number} id
 * @property {'text'|'image'} kind
 * @property {string} preview
 * @property {string} imagePath  '' for text entries
 * @property {number} lastUsed   ms since epoch
 * @property {boolean} pinned
 * @property {number[]} positions  code-point indices into preview to highlight
 */

export class DaemonClient {
    /** @param {() => void} onHistoryChanged */
    constructor(onHistoryChanged) {
        this._bus = Gio.DBus.session;
        // Sender is left null: the signal is matched on path + interface,
        // which avoids depending on well-known-name tracking for signals.
        this._subscription = this._bus.signal_subscribe(
            null, INTERFACE, 'HistoryChanged', OBJECT_PATH, null,
            Gio.DBusSignalFlags.NONE, () => onHistoryChanged());
    }

    destroy() {
        this._bus.signal_unsubscribe(this._subscription);
    }

    addText(text) {
        return this._call('AddText', new GLib.Variant('(s)', [text]), '(t)');
    }

    /** @param {GLib.Bytes} bytes */
    addImage(mime, bytes) {
        const params = GLib.Variant.new_tuple([
            GLib.Variant.new_string(mime),
            GLib.Variant.new_from_bytes(new GLib.VariantType('ay'), bytes, true),
        ]);
        return this._call('AddImage', params, '(t)');
    }

    /** @returns {Promise<HistoryEntry[]>} */
    async search(query, mode, limit) {
        const reply = await this._call(
            'Search', new GLib.Variant('(ssu)', [query, mode, limit]), '(a(tsssxbau))');
        const [rows] = reply.deepUnpack();
        return rows.map(([id, kind, preview, imagePath, lastUsed, pinned, positions]) =>
            ({id, kind, preview, imagePath, lastUsed, pinned, positions}));
    }

    /** @returns {Promise<{mime: string, bytes: GLib.Bytes}>} */
    async getContent(id) {
        const reply = await this._call('GetContent', new GLib.Variant('(t)', [id]), '(say)');
        return {
            mime: reply.get_child_value(0).get_string()[0],
            bytes: reply.get_child_value(1).get_data_as_bytes(),
        };
    }

    delete(id) {
        return this._call('Delete', new GLib.Variant('(t)', [id]), null);
    }

    setPinned(id, pinned) {
        return this._call('SetPinned', new GLib.Variant('(tb)', [id, pinned]), null);
    }

    /** @returns {Promise<number>} unpinned entries the daemon keeps */
    async getMaxItems() {
        const reply = await this._call(
            'Get', new GLib.Variant('(ss)', [INTERFACE, 'MaxItems']), '(v)', PROPERTIES);
        return reply.recursiveUnpack()[0];
    }

    setMaxItems(value) {
        return this._call(
            'Set', new GLib.Variant('(ssv)', [INTERFACE, 'MaxItems', new GLib.Variant('u', value)]),
            null, PROPERTIES);
    }

    _call(method, params, replyType, iface = INTERFACE) {
        return new Promise((resolve, reject) => {
            this._bus.call(
                BUS_NAME, OBJECT_PATH, iface, method, params,
                replyType ? new GLib.VariantType(replyType) : null,
                Gio.DBusCallFlags.NONE, CALL_TIMEOUT_MS, null,
                (bus, result) => {
                    try {
                        resolve(bus.call_finish(result));
                    } catch (error) {
                        reject(error);
                    }
                });
        });
    }
}
