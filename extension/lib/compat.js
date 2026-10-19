// Small shims for St API differences between GNOME Shell versions.
// Keeping them here means the UI code reads the same on every version.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

/** A vertical St.BoxLayout. GNOME 48 replaced `vertical` with `orientation`. */
export function verticalBox(params = {}) {
    const box = new St.BoxLayout(params);
    if ('orientation' in box)
        box.orientation = Clutter.Orientation.VERTICAL;
    else
        box.vertical = true;
    return box;
}
