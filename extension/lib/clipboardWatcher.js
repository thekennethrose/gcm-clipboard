// Notices every new clipboard owner and reads what was copied.
//
// This is the part that has to live inside GNOME Shell: on Wayland only the
// compositor can read the clipboard of whatever app currently owns it.

import Meta from 'gi://Meta';
import St from 'gi://St';

// Password managers (KeePassXC, Bitwarden, ...) tag secrets with this type.
const SECRET_HINT_MIME = 'x-kde-passwordManagerHint';
const TEXT_MIMES = ['text/plain;charset=utf-8', 'text/plain', 'UTF8_STRING', 'STRING'];
const IMAGE_MIMES = ['image/png'];

export class ClipboardWatcher {
    /**
     * @param {object} handlers
     * @param {(text: string) => void} handlers.onText
     * @param {(mime: string, bytes: import('gi://GLib').default.Bytes) => void} handlers.onImage
     */
    constructor({onText, onImage}) {
        this._onText = onText;
        this._onImage = onImage;
        this._clipboard = St.Clipboard.get_default();
        this._selection = global.display.get_selection();
        this._ownerChangedId = this._selection.connect('owner-changed', (_selection, type) => {
            if (type === Meta.SelectionType.SELECTION_CLIPBOARD)
                this._readClipboard();
        });
    }

    destroy() {
        this._selection.disconnect(this._ownerChangedId);
    }

    _readClipboard() {
        const type = St.ClipboardType.CLIPBOARD;
        const mimes = this._clipboard.get_mimetypes(type);
        if (mimes.includes(SECRET_HINT_MIME))
            return;

        // Text wins when both are offered: spreadsheets and office apps put a
        // rendered PNG next to the text of a cell copy, and the text is what
        // you want back. A "Copy Image" from a browser offers no plain text.
        if (TEXT_MIMES.some(mime => mimes.includes(mime))) {
            this._clipboard.get_text(type, (_clipboard, text) => {
                if (text)
                    this._onText(text);
            });
            return;
        }

        const imageMime = IMAGE_MIMES.find(mime => mimes.includes(mime));
        if (imageMime) {
            this._clipboard.get_content(type, imageMime, (_clipboard, bytes) => {
                if (bytes && bytes.get_size() > 0)
                    this._onImage(imageMime, bytes);
            });
        }
    }
}
