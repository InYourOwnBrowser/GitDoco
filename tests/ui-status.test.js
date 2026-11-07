import test from 'node:test';
import assert from 'node:assert/strict';

// A minimal DOM: the status bar's elements and body classes.
function el() {
    const classes = new Set();
    const attrs = {};
    return {
        textContent: '', style: {},
        classList: {
            add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c),
            toggle: (c, on) => { const v = on === undefined ? !classes.has(c) : on; if (v) classes.add(c); else classes.delete(c); return v; }
        },
        setAttribute: (k, v) => { attrs[k] = String(v); }, removeAttribute: k => { delete attrs[k]; }, getAttribute: k => attrs[k],
        attrs
    };
}
const nodes = { logSummary: el(), progressTrack: el(), progressFill: el(), logCard: el() };
globalThis.document = { body: el(), getElementById: id => nodes[id] || null, querySelectorAll: () => [] };

const status = await import('../js/ui-status.js');

test('status: begin shows the message, a spinner on the button, and a sliding bar for an unknown total', () => {
    const button = el();
    const t = status.begin('[FETCH] Loading issues…', { button });
    assert.equal(nodes.logSummary.textContent, 'Loading issues…', 'the [TAG] prefix is dropped');
    assert.ok(document.body.classList.contains('is-busy'));
    assert.ok(button.classList.contains('is-loading'));
    assert.equal(button.getAttribute('aria-busy'), 'true');
    assert.equal(nodes.progressTrack.style.display, 'block');
    assert.ok(nodes.progressTrack.classList.contains('indeterminate'));
    status.progress(t, { message: 'Loading issues… 120 found' });
    assert.equal(nodes.logSummary.textContent, 'Loading issues… 120 found');
    status.progress(t, { percent: 40 });
    assert.ok(!nodes.progressTrack.classList.contains('indeterminate'));
    assert.equal(nodes.progressFill.style.width, '40%');
    assert.equal(status.end(t, 'Loaded 120 issues.'), true);
    assert.equal(nodes.logSummary.textContent, 'Loaded 120 issues.');
    assert.ok(!document.body.classList.contains('is-busy'));
    assert.ok(!button.classList.contains('is-loading'));
    assert.equal(nodes.progressFill.style.width, '100%', 'the bar fills before it hides');
});

test('status: older work cannot overwrite newer work (background topics vs a build)', () => {
    const topics = status.begin('Finding topics…');
    const build = status.begin('Fetching comments…', { percent: 0 });
    assert.equal(status.isCurrent(topics), false);
    assert.equal(status.end(topics, 'Found 5 topics.'), false, 'ignored: a build is running');
    status.progress(topics, { message: 'should not show' });
    assert.equal(nodes.logSummary.textContent, 'Fetching comments…');
    assert.ok(document.body.classList.contains('is-busy'));
    assert.equal(status.end(build, 'Packed 25 issues.'), true);
    assert.equal(nodes.logSummary.textContent, 'Packed 25 issues.');
});
