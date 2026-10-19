// Keyboard shortcuts in GSettings accelerator form ('<Control><Shift>v'):
// building one from a key press and showing one to people.
//
// No GNOME imports, so this runs under plain Node for tests.

const MODIFIER_KEYS = new Set([
    'Shift_L', 'Shift_R', 'Control_L', 'Control_R', 'Alt_L', 'Alt_R',
    'Super_L', 'Super_R', 'Meta_L', 'Meta_R', 'Hyper_L', 'Hyper_R',
    'ISO_Level3_Shift', 'Caps_Lock', 'Num_Lock',
]);

// How accelerator modifiers read on screen. GTK accepts several spellings.
const MODIFIER_LABELS = {
    super: 'Super', mod4: 'Super',
    primary: 'Ctrl', control: 'Ctrl', ctrl: 'Ctrl',
    alt: 'Alt', mod1: 'Alt',
    shift: 'Shift',
};

/**
 * The accelerator for a key press, or null while it isn't a usable global
 * shortcut yet (only modifiers held, or a plain key that would steal typing).
 *
 * @param {string} keyName  keyval name, e.g. 'v', or 'V' when Shift is held
 * @param {{ctrl?: boolean, alt?: boolean, super?: boolean, shift?: boolean}} mods
 */
export function accelFromKey(keyName, mods) {
    if (!keyName || MODIFIER_KEYS.has(keyName))
        return null;
    // Shift turns 'v' into 'V'; accelerators name the unshifted key.
    if (/^[A-Z]$/.test(keyName))
        keyName = keyName.toLowerCase();
    const functionKey = /^F\d{1,2}$/.test(keyName);
    if (!mods.ctrl && !mods.alt && !mods.super && !functionKey)
        return null;

    let accel = '';
    if (mods.ctrl)
        accel += '<Control>';
    if (mods.alt)
        accel += '<Alt>';
    if (mods.super)
        accel += '<Super>';
    if (mods.shift)
        accel += '<Shift>';
    return accel + keyName;
}

/** '<Control><Shift>v' -> 'Ctrl+Shift+V'; '' -> 'Disabled'. */
export function formatAccel(accel) {
    if (!accel)
        return 'Disabled';
    const parts = [];
    const key = accel.replace(/<([^>]+)>/g, (_match, mod) => {
        parts.push(MODIFIER_LABELS[mod.toLowerCase()] ?? mod);
        return '';
    });
    if (key)
        parts.push(key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1));
    return parts.join('+');
}
