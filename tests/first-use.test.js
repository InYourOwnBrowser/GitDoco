import test from 'node:test';
import assert from 'node:assert/strict';

// Minimal DOM with <dialog> support, enough to drive js/first-use.js.
const store = new Map();
globalThis.localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
class Node {
    constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.attrs = {}; this.open = false; this.removed = false; }
    append(...c) { this.children.push(...c); } appendChild(c) { this.children.push(c); return c; }
    setAttribute(k, v) { this.attrs[k] = v; } addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
    fire(t, ev = {}) { for (const fn of this.listeners[t] || []) fn({ preventDefault() {}, ...ev }); }
    focus() {} remove() { this.removed = true; }
    get text() { return this.children.map(c => typeof c === 'string' ? c : (c.textContent || c.text || '')).join(''); }
}
class Dialog extends Node { showModal() { this.open = true; } close() { this.open = false; } }
let lastDialog = null;
globalThis.document = {
    body: new Node('body'),
    createElement: tag => { const n = tag === 'dialog' ? new Dialog(tag) : new Node(tag); if (tag === 'dialog') lastDialog = n; return n; }
};
const { confirmFirstUse, hasAcceptedNotice, NOTICE_KEY, NOTICE_VERSION } = await import('../js/first-use.js');

const find = (node, pred) => {
    if (typeof node !== 'object' || !node) return null;
    if (pred(node)) return node;
    for (const c of node.children || []) { const f = find(c, pred); if (f) return f; }
    return null;
};
const parts = d => ({
    checkbox: find(d, n => n.tag === 'input'),
    cont: find(d, n => n.tag === 'button' && n.textContent === 'Continue'),
    cancel: find(d, n => n.tag === 'button' && n.textContent === 'Cancel')
});

test('first use: notice names the services, needs the box ticked, and is remembered', async () => {
    store.clear();
    assert.equal(hasAcceptedNotice(), false);
    const pending = confirmFirstUse('deps');
    const d = lastDialog;
    assert.ok(d.open, 'dialog shown');
    const text = JSON.stringify(d, (k, v) => (k === 'listeners' ? undefined : v));
    assert.match(text, /GitHub and deps\.dev \(run by Google\)/);
    assert.match(text, /terms\.html/);
    assert.match(text, /privacy\.html/);
    const { checkbox, cont } = parts(d);
    assert.equal(cont.disabled, true, 'Continue disabled until the box is ticked');
    checkbox.checked = true; checkbox.fire('change');
    assert.equal(cont.disabled, false);
    cont.fire('click');
    assert.equal(await pending, true);
    assert.equal(d.open, false);
    assert.ok(d.removed);
    assert.equal(store.get(NOTICE_KEY), String(NOTICE_VERSION));
    assert.equal(hasAcceptedNotice(), true);

    lastDialog = null;
    assert.equal(await confirmFirstUse('github'), true);
    assert.equal(lastDialog, null, 'not shown again once accepted');
});

test('first use: Cancel or Escape stops the request and nothing is remembered', async () => {
    store.clear();
    let pending = confirmFirstUse('github');
    parts(lastDialog).cancel.fire('click');
    assert.equal(await pending, false);
    pending = confirmFirstUse('github');
    lastDialog.fire('cancel');
    assert.equal(await pending, false);
    assert.equal(store.has(NOTICE_KEY), false);
});

test('first use: an older accepted version asks again', async () => {
    store.set(NOTICE_KEY, String(NOTICE_VERSION - 1));
    assert.equal(hasAcceptedNotice(), false);
    lastDialog = null;
    const pending = confirmFirstUse('github');
    assert.ok(lastDialog && lastDialog.open);
    parts(lastDialog).cancel.fire('click');
    await pending;
});
