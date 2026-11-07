import './helpers/discussions-mode.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { el, fire, wait } from './helpers/dom-stub.mjs';
import { installFakeDiscussions } from './helpers/fake-discussions.mjs';

// The app is a module singleton, so these tests run in order against one loaded instance.
const fake = installFakeDiscussions();
const app = await import('../../js/issues-app.js');
const out = () => el('previewArea').value || '';
const logText = () => String(el('log').textContent || '');

test('runs in discussions mode', () => {
    assert.equal(app.KIND, 'discussions');
});

test('with a token: loads through GraphQL and fills the category filter', async () => {
    el('pat').value = 'ghp_testtoken';
    el('repoUrl').value = 'o/r';
    await el('loadIssuesBtn').click();
    await wait(50);
    assert.match(logText(), /Using GitHub GraphQL API/);
    assert.deepEqual(fake.calls.filter(c => c !== '/rate_limit'), ['graphql:manifest']);
    assert.match(el('categoryFilter').innerHTML, /Q&amp;A \(20\)/);
    assert.match(el('categoryFilter').innerHTML, /Ideas \(20\)/);
});

test('"Answer" scope packs only accepted answers, marked as such', async () => {
    el('commentScope').value = 'answer';
    await el('buildContextBtn').click();
    await wait(200);
    assert.ok(fake.calls.includes('graphql:comments'), 'comments come from GraphQL');
    const text = out();
    assert.match(text, /<discussion_count>\d+<\/discussion_count>/);
    assert.match(text, /<source>Discussion #\d+: /);
    assert.match(text, /<category>Q&amp;A<\/category>/);
    const comments = text.match(/<comment index=[^>]*>/g) || [];
    assert.ok(comments.length > 0, 'expected some accepted answers');
    assert.ok(comments.every(c => c.includes('accepted_answer="true"')), 'only accepted answers');
});

test('"Full thread" includes replies marked with who they reply to, and drops hidden comments', async () => {
    el('commentScope').value = 'all';
    await fire('commentScope', 'change');
    await wait(200);
    const text = out();
    assert.match(text, /reply_to="ann"/);
    assert.match(text, /Reply to comment 0 on discussion \d+\./);
    assert.doesNotMatch(text, /Comment 2 on discussion 7:/, 'minimized comment must be dropped');
});

test('answered / unanswered filters use the accepted-answer state', async () => {
    el('stateFilter').value = 'answered';
    await fire('stateFilter', 'input');
    const answered = Number(el('searchMatchCount').textContent.split(' / ')[0]);
    el('stateFilter').value = 'unanswered';
    await fire('stateFilter', 'input');
    const unanswered = Number(el('searchMatchCount').textContent.split(' / ')[0]);
    const expectedAnswered = fake.discussions.filter(d => d.answered).length;
    assert.equal(answered, expectedAnswered);
    assert.equal(unanswered, fake.discussions.filter(d => d.answerable && !d.answered).length);
    el('stateFilter').value = 'all';
    await fire('stateFilter', 'input');
});

test('without a token: falls back to the REST endpoints and still marks the accepted answer', async () => {
    el('pat').value = '';
    fake.calls.length = 0;
    await el('loadIssuesBtn').click();
    await wait(50);
    assert.match(logText(), /No token: using GitHub's undocumented token-free discussions endpoint/);
    assert.ok(fake.calls.some(c => c.startsWith('/repos/o/r/discussions?')));
    el('commentScope').value = 'answer';
    await fire('commentScope', 'change');
    await el('buildContextBtn').click();
    await wait(300);
    assert.ok(fake.calls.some(c => /\/discussions\/\d+\/comments/.test(c)), 'per-discussion REST comment requests');
    const comments = out().match(/<comment index=[^>]*>/g) || [];
    assert.ok(comments.length > 0);
    assert.ok(comments.every(c => c.includes('accepted_answer="true"')));
});

test('downloads and summary use discussion wording', async () => {
    assert.match(el('summaryCard').children.map(c => c.textContent).join('\n'), /\d+ discussions included/);
});
