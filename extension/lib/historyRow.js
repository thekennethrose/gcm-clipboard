// One entry in the popup list: optional thumbnail, highlighted preview, pin marker.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {highlightMarkup} from './highlight.js';

const THUMBNAIL_SIZE = 48;

export const HistoryRow = GObject.registerClass(
class HistoryRow extends St.Button {
    /** @param {import('./daemonClient.js').HistoryEntry} entry */
    _init(entry) {
        super._init({
            // candidate-box: the theme's hover and accent-colored :selected styles.
            style_class: 'candidate-box gcm-clipboard-row',
            x_expand: true,
            can_focus: false, // focus stays in the search box; arrows move the selection
            track_hover: true,
        });
        this.entry = entry;

        const box = new St.BoxLayout({style_class: 'gcm-clipboard-row-box', x_expand: true});
        if (entry.kind === 'image' && entry.imagePath)
            box.add_child(this._thumbnail(entry.imagePath));
        box.add_child(this._label(entry));
        if (entry.pinned)
            box.add_child(this._pinMarker());
        this.set_child(box);
    }

    setSelected(selected) {
        if (selected)
            this.add_style_pseudo_class('selected');
        else
            this.remove_style_pseudo_class('selected');
    }

    _thumbnail(path) {
        return new St.Icon({
            gicon: new Gio.FileIcon({file: Gio.File.new_for_path(path)}),
            icon_size: THUMBNAIL_SIZE,
            style_class: 'gcm-clipboard-thumb',
        });
    }

    _label(entry) {
        const label = new St.Label({
            style_class: 'gcm-clipboard-label',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        label.clutter_text.set_markup(highlightMarkup(entry.preview, entry.positions));
        return label;
    }

    _pinMarker() {
        return new St.Icon({
            icon_name: 'view-pin-symbolic',
            style_class: 'gcm-clipboard-pin',
            opacity: 180,
            y_align: Clutter.ActorAlign.CENTER,
        });
    }
});
