import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchIssuesManifest, fetchCommentsForIssues, nextPageUrl, fetchAllPages } from '../js/github-issues-api.js';
import { fetchDiscussionsManifest } from '../js/github-discussions-api.js';

/*
 * A fake GitHub that behaves like the real one on a large repository: list endpoints answer with
 * a Link header whose rel="next" URL carries a cursor (after=...), and any request that asks for
 * page 2 or later by number gets the real 422 "use cursor based pagination" error.
 */
const API = 'https://api.github.com';
function cursorGithub(lists) {
    const calls = [];
    globalThis.fetch = async (url) => {
        calls.push(String(url));
        const u = new URL(url);
        const page = u.searchParams.get('page');
        if (page && Number(page) > 1) {
            return new Response(JSON.stringify({ message: 'Pagination with the page parameter is not supported for large datasets, please use cursor based pagination (after/before)' }), { status: 422, headers: { 'content-type': 'application/json' } });
        }
        const list = lists(u);
        if (!list) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
        const per = Number(u.searchParams.get('per_page') || 30);
        const start = u.searchParams.get('after') ? Number(atob(u.searchParams.get('after'))) : 0;
        const body = list.slice(start, start + per);
        const headers = { 'content-type': 'application/json' };
        if (start + per < list.length) {
            const next = new URL(u.href);
            next.searchParams.set('after', btoa(String(start + per)));
            headers.link = `<${next.href}>; rel="next"`;
        }
        return new Response(JSON.stringify(body), { status: 200, headers });
    };
    return calls;
}

const N = 450;
const issues = Array.from({ length: N }, (_, k) => ({
    number: N - k, title: `T${N - k}`, body: '', state: 'open', user: { login: 'u' },
    created_at: new Date(Date.UTC(2026, 0, 1) + k * 3600e3).toISOString(), comments: (N - k) === 7 ? 250 : 1,
    ...((N - k) % 2 === 0 ? { pull_request: { merged_at: null } } : {})
}));
const comments = issues.flatMap(i => Array.from({ length: i.comments }, (_, j) => ({
    id: i.number * 1000 + j, issue_url: `${API}/repos/o/r/issues/${i.number}`, user: { login: 'c' },
    created_at: i.created_at, updated_at: i.created_at, body: `c${j}`
})));
const routes = u => {
    let m;
    if (u.pathname === '/repos/o/r/issues') return issues;
    if (u.pathname === '/repos/o/r/issues/comments') return comments;
    if ((m = /^\/repos\/o\/r\/issues\/(\d+)\/comments$/.exec(u.pathname))) return comments.filter(c => c.issue_url.endsWith('/' + m[1]));
    if (u.pathname === '/repos/o/r/discussions') return Array.from({ length: 230 }, (_, i) => ({ number: 230 - i, title: `D${i}`, body: '', user: { login: 'u' }, category: { name: 'Q&A' } }));
    return null;
};

test('the issue list follows cursor links past page 1 (no 422 on large repositories)', async () => {
    const calls = cursorGithub(routes);
    const all = await fetchIssuesManifest('o', 'r', { maxItems: 450, itemType: 'both' });
    assert.equal(all.length, 450);
    assert.equal(new Set(all.map(i => i.number)).size, 450, 'no page is read twice');
    assert.equal(all.stoppedEarly, false);
    assert.ok(calls.slice(1).every(c => /[?&]after=/.test(c) && !/[?&]page=/.test(c)), 'later pages use the cursor');

    cursorGithub(routes);
    const onlyIssues = await fetchIssuesManifest('o', 'r', { maxItems: 300, itemType: 'issues' });
    assert.equal(onlyIssues.length, 225, 'every issue across all pages, with pull requests skipped');
    assert.ok(onlyIssues.every(i => !i.isPullRequest));
});

test('the bulk comment call and long single threads follow cursor links too', async () => {
    cursorGithub(routes);
    const selected = issues.slice(0, 200).map(i => ({ number: i.number, commentsCount: i.comments, createdAt: i.created_at.slice(0, 10) }));
    const universe = issues.map(i => ({ number: i.number, commentsCount: i.comments, createdAt: i.created_at.slice(0, 10) }));
    const { commentsByIssue, failures, stats } = await fetchCommentsForIssues('o', 'r', selected, { throttleMs: 0, universe, strategy: 'bulk' });
    assert.deepEqual(failures, []);
    assert.equal(commentsByIssue.size, 200);
    assert.ok(selected.every(i => commentsByIssue.get(i.number).length === i.commentsCount), 'every thread complete');
    assert.match(stats.strategy, /bulk/);

    cursorGithub(routes);
    const long = await fetchCommentsForIssues('o', 'r', [{ number: 7, commentsCount: 250 }], { throttleMs: 0, strategy: 'per-issue' });
    assert.equal(long.commentsByIssue.get(7).length, 250, 'a 250-comment thread is read in full across three pages');
});

test('the token-free discussions list follows cursor links', async () => {
    cursorGithub(routes);
    const list = await fetchDiscussionsManifest('o', 'r', { maxItems: 300 });
    assert.equal(list.length, 230);
});

test('a next link is only followed on the GitHub API (the token goes with it)', async () => {
    assert.equal(nextPageUrl('<https://api.github.com/repositories/1/issues?after=X&per_page=100>; rel="next", <https://api.github.com/x>; rel="last"'),
        'https://api.github.com/repositories/1/issues?after=X&per_page=100');
    assert.equal(nextPageUrl('<https://evil.example/steal>; rel="next"'), null);
    assert.equal(nextPageUrl('<https://api.github.com/x>; rel="prev"'), null);
    assert.equal(nextPageUrl(''), null);

    const calls = [];
    globalThis.fetch = async (url) => {
        calls.push(String(url));
        return new Response(JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ id: i }))), { status: 200, headers: { link: '<https://evil.example/next>; rel="next"' } });
    };
    const { items, truncated } = await fetchAllPages(`${API}/repos/o/r/issues/1/comments?per_page=100`, 'ghp_secret', undefined, undefined, 5);
    assert.equal(calls.length, 1, 'the off-site link is not followed');
    assert.equal(items.length, 100);
    assert.equal(truncated, false);
});
