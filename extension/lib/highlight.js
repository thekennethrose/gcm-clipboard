// Pango markup for a preview with matched characters in bold.
//
// No GNOME imports, so this runs under plain Node for tests.

const ENTITIES = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'};

export function escapeMarkup(text) {
    return text.replace(/[&<>"']/g, ch => ENTITIES[ch]);
}

/**
 * @param {string} text
 * @param {number[]} positions  code-point indices, as the daemon (Python) counts them
 */
export function highlightMarkup(text, positions) {
    const marked = new Set(positions);
    // Array.from splits by code point, not UTF-16 unit, so an emoji before
    // the match doesn't shift every highlight by one.
    const chars = Array.from(text);

    let markup = '';
    let bold = false;
    chars.forEach((ch, i) => {
        const hit = marked.has(i);
        if (hit !== bold) {
            markup += hit ? '<b>' : '</b>';
            bold = hit;
        }
        markup += escapeMarkup(ch);
    });
    return bold ? `${markup}</b>` : markup;
}
