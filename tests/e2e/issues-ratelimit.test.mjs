import test from 'node:test';
import assert from 'node:assert/strict';
import { el, wait } from './helpers/dom-stub.mjs';
import { installFakeGithub } from './helpers/fake-github.mjs';

const fake = installFakeGithub({ mode: 'primary-limit' });
await import('../../js/issues-app.js');

test('primary rate limit: one denied request, clear warning, build still completes', async () => {
    el('repoUrl').value = 'o/r';
    await el('loadIssuesBtn').click();
    await wait(50);
    const before = fake.calls.length;
    await el('buildContextBtn').click();
    await wait(300);
    const denied = fake.calls.slice(before).filter(c => c.includes('comments'));
    assert.equal(denied.length, 1, 'must stop after the first rate-limited request');
    const out = el('previewArea').value || '';
    assert.ok(out.includes('<comments_warning>') || out.includes('Comment thread fetch failed'));
    const bannerTexts = el('warningBanner').children.map(c => c.textContent);
    assert.ok(bannerTexts.some(t => /request limit/i.test(t)), 'warning banner must display request limit error');
});
