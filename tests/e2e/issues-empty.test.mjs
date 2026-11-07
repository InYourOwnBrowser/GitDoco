import test from 'node:test';
import assert from 'node:assert/strict';
import { el, wait } from './helpers/dom-stub.mjs';
import { installFakeGithub } from './helpers/fake-github.mjs';

// A repository with no issues (only pull requests, say): the page says so and offers the fix.
const fake = installFakeGithub({ issueCount: 0 });
await import('../../js/issues-app.js');
const logText = () => String(el('log').textContent || '');

test('an empty result explains itself, skips topic clustering, and offers to include pull requests', async () => {
    el('repoUrl').value = 'o/r';
    el('includePrs').value = 'issues';
    await el('loadIssuesBtn').click();
    await wait(50);
    assert.match(logText(), /No issues found in o\/r\. It may only have pull requests\./);
    assert.doesNotMatch(logText(), /Finding topics|No clear topics/);
    assert.equal(el('logSummary').textContent, 'No issues found in o/r. It may only have pull requests.');
    assert.match(el('issuesEmptyText').textContent, /No issues found/);
    const action = el('issuesEmptyText').children.find(c => c.textContent === 'Load pull requests too');
    assert.ok(action, 'the empty state offers a button');

    const before = fake.calls.length;
    await el('buildContextBtn').click();
    await wait(20);
    assert.equal(fake.calls.length, before, 'building with nothing loaded makes no requests');
});
