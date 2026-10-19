// Run with: node --test extension/tests/
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {accelFromKey, formatAccel} from '../lib/shortcut.js';

test('builds an accelerator in GSettings form', () => {
    assert.equal(accelFromKey('v', {super: true, shift: true}), '<Super><Shift>v');
    assert.equal(accelFromKey('h', {ctrl: true, alt: true}), '<Control><Alt>h');
});

test('names the unshifted key when Shift is held', () => {
    assert.equal(accelFromKey('V', {super: true, shift: true}), '<Super><Shift>v');
});

test('keeps listening while only modifiers are held', () => {
    assert.equal(accelFromKey('Super_L', {super: true}), null);
    assert.equal(accelFromKey('Shift_R', {shift: true}), null);
});

test('refuses a plain key, which would steal ordinary typing', () => {
    assert.equal(accelFromKey('v', {}), null);
    assert.equal(accelFromKey('v', {shift: true}), null);
});

test('allows a bare function key', () => {
    assert.equal(accelFromKey('F9', {}), 'F9');
});

test('formats accelerators for display', () => {
    assert.equal(formatAccel('<Super><Shift>v'), 'Super+Shift+V');
    assert.equal(formatAccel('<Primary><Alt>space'), 'Ctrl+Alt+Space');
    assert.equal(formatAccel(''), 'Disabled');
});
