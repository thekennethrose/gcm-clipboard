// Run with: node --test extension/tests/
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {escapeMarkup, highlightMarkup} from '../lib/highlight.js';

test('bolds runs of matched characters', () => {
    assert.equal(highlightMarkup('git checkout', [0, 4, 5]), '<b>g</b>it <b>ch</b>eckout');
});

test('escapes markup characters', () => {
    assert.equal(highlightMarkup('a<b>&', [1]), 'a<b>&lt;</b>b&gt;&amp;');
    assert.equal(escapeMarkup(`"'`), '&quot;&#39;');
});

test('counts code points like Python, so emoji do not shift highlights', () => {
    assert.equal(highlightMarkup('😀ab', [1]), '😀<b>a</b>b');
});

test('closes a trailing bold run', () => {
    assert.equal(highlightMarkup('ab', [1]), 'a<b>b</b>');
});
