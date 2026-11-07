import test from 'node:test';
import assert from 'node:assert/strict';
import { copyHintText, AI_APPS, initShortcuts } from '../js/ui-actions.js';

test('copy hint says where to paste, and what to do with multi-part output', () => {
    assert.equal(copyHintText('claude'), 'Copied. Now paste it into Claude.');
    assert.equal(copyHintText('custom'), 'Copied. Now paste it into your AI.');
    assert.equal(copyHintText('chatgpt', 1, 3), 'Copied part 1 of 3. Paste it into ChatGPT, then copy the next part.');
    assert.equal(copyHintText('gemini', 3, 3), 'Copied the last part (3 of 3). Paste it into Gemini.');
    for (const app of Object.values(AI_APPS)) assert.match(app.url, /^https:\/\//);
});

test('Ctrl/Cmd+Enter runs the current step and Ctrl/Cmd+Shift+Enter copies', () => {
    const listeners = [];
    globalThis.document = { addEventListener: (type, fn) => listeners.push(fn) };
    const btn = name => ({ name, title: '', disabled: false, clicks: 0, click() { this.clicks++; } });
    const load = btn('load'), build = btn('build'), copy = btn('copy');
    let state = 'empty';
    initShortcuts({ main: () => (state === 'empty' ? load : build), copy, mainButtons: [load, build] });
    const press = (o) => { let prevented = false; listeners.forEach(fn => fn({ key: 'Enter', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, preventDefault() { prevented = true; }, ...o })); return prevented; };
    assert.equal(press({ ctrlKey: true }), true);
    assert.equal(load.clicks, 1);
    state = 'loaded';
    press({ metaKey: true });
    assert.equal(build.clicks, 1, 'Build once loaded (decided by state, so a hidden Build button on phones still works)');
    copy.disabled = true;
    assert.equal(press({ ctrlKey: true, shiftKey: true }), false, 'nothing to copy yet');
    copy.disabled = false;
    press({ ctrlKey: true, shiftKey: true });
    assert.equal(copy.clicks, 1);
    assert.equal(press({}), false, 'plain Enter is left alone');
    assert.match(load.title, /\((Ctrl|⌘)\+Enter\)/);
    assert.match(copy.title, /\((Ctrl|⌘)\+Shift\+Enter\)/);
    delete globalThis.document;
});
