// Run with: node --test extension/tests/
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {isTerminal} from '../lib/terminals.js';

test('recognises a terminal by WM_CLASS', () => {
    assert.equal(isTerminal({wmClass: 'gnome-terminal-server'}), true);
    assert.equal(isTerminal({wmClass: 'Alacritty'}), true);
});

test('recognises a terminal by .desktop app id', () => {
    assert.equal(isTerminal({appId: 'org.gnome.Ptyxis.desktop'}), true);
    assert.equal(isTerminal({wmClass: 'unknown', appId: 'org.gnome.Console.desktop'}), true);
});

test('leaves other apps alone', () => {
    assert.equal(isTerminal({wmClass: 'firefox', appId: 'firefox_firefox.desktop'}), false);
    assert.equal(isTerminal({wmClass: 'Code'}), false);
});

test('copes with a window that has no class or app', () => {
    assert.equal(isTerminal({wmClass: null, appId: null}), false);
    assert.equal(isTerminal(), false);
});
