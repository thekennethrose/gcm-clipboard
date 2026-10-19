// Which windows are terminals, for terminal-aware paste (Ctrl+Shift+V).
//
// No GNOME imports, so this runs under plain Node for tests.

// Lowercased WM_CLASS values and .desktop app ids. Either one matching is enough.
const TERMINALS = new Set([
    'gnome-terminal-server', 'org.gnome.terminal',
    'kgx', 'org.gnome.console',
    'ptyxis', 'org.gnome.ptyxis',
    'kitty', 'alacritty', 'foot', 'footclient',
    'wezterm', 'org.wezfurlong.wezterm',
    'ghostty', 'com.mitchellh.ghostty',
    'blackbox', 'com.raggesilver.blackbox',
    'tilix', 'com.gexperts.tilix',
    'konsole', 'org.kde.konsole',
    'xterm', 'uxterm', 'urxvt', 'rxvt', 'st-256color',
    'terminator', 'xfce4-terminal', 'mate-terminal', 'lxterminal', 'qterminal',
    'io.elementary.terminal', 'deepin-terminal', 'terminology',
    'guake', 'tilda', 'tabby', 'hyper', 'warp', 'dev.warp.warp',
    'cool-retro-term', 'sakura', 'contour', 'rio',
]);

/**
 * @param {object} window
 * @param {string|null} [window.wmClass]  e.g. 'gnome-terminal-server'
 * @param {string|null} [window.appId]    e.g. 'org.gnome.Terminal.desktop'
 */
export function isTerminal({wmClass = null, appId = null} = {}) {
    return [wmClass, appId?.replace(/\.desktop$/, '')]
        .filter(Boolean)
        .some(name => TERMINALS.has(name.toLowerCase()));
}
