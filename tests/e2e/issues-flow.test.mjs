import test from 'node:test';
import assert from 'node:assert/strict';
import { el, fire, wait } from './helpers/dom-stub.mjs';
import { installFakeGithub } from './helpers/fake-github.mjs';

// The app is a module singleton, so these tests run in order against one loaded instance.
const fake = installFakeGithub();
const app = await import('../../js/issues-app.js');

const commentsIn = () => ((el('previewArea').value || '').match(/Real comment/g) || []).length;
const logText = () => String(el('log').textContent || '');

test('load: manifest loads and the first 25 open issues are selected', async () => {
    el('repoUrl').value = 'o/r';
    await el('loadIssuesBtn').click();
    await wait(50);
    assert.match(logText(), /Loaded \d+ issues\./);
});

test('build with comment scope "none" fetches no comments', async () => {
    const before = fake.calls.length;
    el('commentScope').value = 'none';
    await el('buildContextBtn').click();
    await wait(100);
    assert.equal(fake.calls.length, before);
    assert.equal(commentsIn(), 0);
    assert.ok((el('previewArea').value || '').length > 1000);
});

test('switching scope to "all" fetches comments through the bulk endpoint', async () => {
    const before = fake.calls.length;
    el('commentScope').value = 'all';
    await fire('commentScope', 'change');
    await wait(300);
    const made = fake.calls.slice(before);
    assert.ok(commentsIn() > 0, 'comments must appear in the output');
    assert.ok(made.length <= 4, `expected the bulk path (<=4 requests), got ${made.length}`);
    assert.ok(made.every(c => c.includes('/issues/comments')), 'should use repo-wide endpoint');
    assert.match(logText(), /Comments: \d+ kept of \d+ fetched/);
});

test('rebuilding after an unrelated option change reuses the comment cache', async () => {
    const before = fake.calls.length;
    const kept = commentsIn();
    el('stripImages').checked = !el('stripImages').checked;
    await fire('stripImages', 'change');
    await wait(200);
    assert.equal(fake.calls.length, before);
    assert.equal(commentsIn(), kept);
});

test('maintainers scope keeps fewer comments than all', async () => {
    const all = commentsIn();
    el('commentScope').value = 'maintainers';
    await fire('commentScope', 'change');
    await wait(200);
    const m = commentsIn();
    assert.ok(m > 0 && m < all, `maintainers=${m} all=${all}`);
});

test('commentScopeBar click sets commentScope and triggers change', async () => {
    await fire('commentScopeBar', 'click', {
        target: {
            closest: () => ({ dataset: { scope: 'maintainers' } })
        }
    });
    assert.equal(el('commentScope').value, 'maintainers');
});

test('selection telemetry displays selectionSummary and hiddenSelectedNote', async () => {
    // 25 issues selected
    assert.match(el('selectionSummary').textContent, /25 selected · ~\d+ tokens \(estimated\)/);

    // Apply a search filter that matches none of the selected issues
    el('issueSearchInput').value = 'nonexistent_search_query_xyz';
    await fire('issueSearchInput', 'input');
    await wait(50);

    assert.equal(el('hiddenSelectedNote').textContent, '25 selected issue(s) are hidden by the current filters.');

    // Reset search
    el('issueSearchInput').value = '';
    await fire('issueSearchInput', 'input');
    await wait(50);
    assert.equal(el('hiddenSelectedNote').textContent, '');
});

test('targetBar sets format and chunkLimit preset values', async () => {
    await fire('targetBar', 'click', {
        target: {
            closest: () => ({ dataset: { target: 'chatgpt' } })
        }
    });
    assert.equal(el('format').value, 'markdown');
    assert.equal(el('chunkLimit').value, '128000');
});

test('exampleRepos chip click sets repoUrl and triggers issues load', async () => {
    const beforeCalls = fake.calls.length;
    await fire('exampleRepos', 'click', {
        target: {
            closest: () => ({ dataset: { repo: 'o/r' } })
        }
    });
    await wait(100);
    assert.equal(el('repoUrl').value, 'o/r');
    const madeCalls = fake.calls.slice(beforeCalls);
    assert.ok(madeCalls.some(c => c.includes('/issues')), 'fake GitHub received an /issues request');
});

test('after a build the copy button keeps its target-specific label', async () => {
    await el('buildContextBtn').click();
    await wait(300);
    assert.equal(el('statChunks').textContent, 1);
    assert.equal(el('copyBtn').textContent, 'Copy for ChatGPT');
});

test('budget meter judges a multi-part build by its largest part, not the total', async () => {
    // Custom target with a tiny split size: the build splits into several parts that each fit.
    el('chunkLimit').value = '1500';
    await fire('chunkLimit', 'change');
    await wait(300);
    assert.ok(Number(el('statChunks').textContent) > 1, 'expected a split build');
    assert.match(el('budgetStatusText').textContent, /^Split into \d+ parts .* fits target window$/);
    assert.match(el('copyBtn').textContent, /^Copy part 1 of \d+$/);
    el('chunkLimit').value = '128000';
    await fire('chunkLimit', 'change');
    await wait(300);
});

test('editing instructions after "Export NLP overview" stays in summary-only mode', async () => {
    const before = fake.calls.length;
    await el('exportNlpOnlyBtn').click();
    await wait(200);
    assert.doesNotMatch(el('previewArea').value, /Body of issue/);
    el('aiInstructions').value = 'Summarise the main themes.';
    await fire('aiInstructions', 'input');
    await wait(500);
    assert.doesNotMatch(el('previewArea').value, /Body of issue/, 'should not switch to full issue export');
    assert.match(el('previewArea').value, /Summarise the main themes\./);
    assert.equal(fake.calls.length, before, 'summary-only rebuild must not fetch comments');
    el('aiInstructions').value = '';
    await fire('aiInstructions', 'input');
    await wait(400);
});

test('loading a repo again clears the previous output', async () => {
    await el('buildContextBtn').click();
    await wait(200);
    assert.ok(el('previewArea').value.length > 0);
    await el('loadIssuesBtn').click();
    await wait(50);
    assert.equal(el('previewArea').value, '');
    assert.equal(el('copyBtn').disabled, true);
    assert.equal(el('downloadBtn').disabled, true);
});

test('localDateString converts ISO timestamps to the local calendar date', async () => {
    const { localDateString } = await import('../../js/issues-app.js');
    const d = new Date(2026, 9, 5, 0, 30); // 5 Oct 2026, 00:30 local time
    assert.equal(localDateString(d.toISOString()), '2026-10-05');
    assert.equal(localDateString(''), '');
    assert.equal(localDateString('not a date'), '');
});

test('your own topic filters the list to matching and related issues', async () => {
    const r = app.applyCustomTopic('"thing 3 breaks"');
    // The fake repo titles issue n "Issue n: thing (n % 9) breaks".
    const expected = [...Array(121).keys()].filter(n => n > 0 && n % 9 === 3);
    assert.ok(r.matches.length > 0 && r.matches.every(n => expected.includes(n)), `matches: ${r.matches}`);
    const shown = Number(el('searchMatchCount').textContent.split(' / ')[0]);
    assert.equal(shown, r.matches.length + r.related.length);
    assert.match(el('customTopicHint').textContent, /^\d+ mentions? "thing 3 breaks"/);
    assert.equal(app.applyCustomTopic('   '), null);
    await fire('clearNlpFilterBtn', 'click');
});
