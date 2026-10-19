// GCM Clipboard Manager shell extension: wires the pieces together and nothing else.
//
//   ClipboardWatcher ──copies──▶ DaemonClient ──D-Bus──▶ GCM daemon
//   keybinding ──▶ HistoryPopup ──search──▶ DaemonClient
//                       └──chosen entry──▶ Paster (clipboard + Ctrl+V or Ctrl+Shift+V)

import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {ClipboardWatcher} from './lib/clipboardWatcher.js';
import {DaemonClient} from './lib/daemonClient.js';
import {Paster} from './lib/paster.js';
import {HistoryPopup} from './lib/popup.js';

const KEYBINDING = 'toggle-popup';

export default class GcmClipboardExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._client = new DaemonClient(() => this._popup?.refreshIfOpen());
        // The shortcut can be the very keys the Paster types (Ctrl+Shift+V
        // into a terminal), and Mutter would take them as the shortcut
        // instead of passing them to the app. So it is paused meanwhile.
        this._paster = new Paster({
            pauseShortcut: () => Main.wm.removeKeybinding(KEYBINDING),
            resumeShortcut: () => this._addShortcut(),
        });

        this._watcher = new ClipboardWatcher({
            onText: text => this._client.addText(text).catch(logFailure('store copied text')),
            onImage: (mime, bytes) =>
                this._client.addImage(mime, bytes).catch(logFailure('store copied image')),
        });

        this._popup = new HistoryPopup({
            client: this._client,
            settings: this._settings,
            onChoose: entry => this._paste(entry),
        });
        Main.layoutManager.uiGroup.add_child(this._popup);

        this._addShortcut();
    }

    disable() {
        // The Paster goes first so a paused shortcut can't come back after this.
        this._paster.destroy();
        this._paster = null;
        Main.wm.removeKeybinding(KEYBINDING);

        this._popup.close();
        this._popup.destroy();
        this._popup = null;

        this._watcher.destroy();
        this._watcher = null;
        this._client.destroy();
        this._client = null;
        this._settings = null;
    }

    _addShortcut() {
        Main.wm.addKeybinding(
            KEYBINDING, this._settings, Meta.KeyBindingFlags.NONE,
            // POPUP is included so the same shortcut closes our own popup.
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
            () => this._popup.toggle());
    }

    async _paste(entry) {
        try {
            const content = await this._client.getContent(entry.id);
            if (!this._paster)
                return; // disabled while the reply was in flight
            this._paster.setClipboard(content);
            if (this._settings.get_boolean('auto-paste'))
                this._paster.pasteSoon({terminalAware: this._settings.get_boolean('terminal-aware-paste')});
        } catch (error) {
            logFailure('paste entry')(error);
        }
    }
}

function logFailure(what) {
    return error => console.error(`gcm-clipboard: failed to ${what}: ${error.message}`);
}
