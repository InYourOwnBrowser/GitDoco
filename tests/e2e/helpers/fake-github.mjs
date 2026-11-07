/**
 * In-memory fake of the GitHub REST endpoints the tools use.
 * Mode 'normal' | 'primary-limit' (403, remaining 0) | 'secondary-limit' (403 + retry-after 1).
 */
export function installFakeGithub({ issueCount = 120, mode = 'normal' } = {}) {
    const calls = [];
    const issues = [];
    const comments = [];
    let cid = 1000;
    const authors = ['alice', 'bob', 'carol', 'dave'];
    for (let n = issueCount; n >= 1; n--) {
        const created = new Date(Date.UTC(2026, 0, 1) + n * 86400000 * 0.9).toISOString();
        const k = n % 5 === 0 ? 0 : (n % 7) + 1;
        issues.push({
            number: n, title: `Issue ${n}: thing ${n % 9} breaks`, body: `Body of issue ${n}. See #${Math.max(1, n - 1)}.`,
            state: n % 3 === 0 ? 'closed' : 'open', state_reason: n % 3 === 0 ? 'completed' : null,
            user: { login: authors[n % 4], type: 'User' }, author_association: 'CONTRIBUTOR', created_at: created, closed_at: null,
            labels: [{ name: n % 2 ? 'bug' : 'docs' }], comments: k, reactions: { total_count: 0, '+1': 0 },
            ...(n % 11 === 0 ? { pull_request: { url: 'x' } } : {})
        });
        for (let j = 0; j < k; j++) {
            const t = new Date(Date.parse(created) + (j + 1) * 3600000).toISOString();
            comments.push({
                id: cid++, issue_url: `https://api.github.com/repos/o/r/issues/${n}`,
                user: { login: j === 1 ? 'dependabot[bot]' : authors[(n + j) % 4], type: j === 1 ? 'Bot' : 'User' },
                author_association: j === 0 ? 'OWNER' : 'NONE', created_at: t, updated_at: t,
                body: j === 2 ? '+1' : `Real comment ${j} on issue ${n}: here is some useful analysis text.`, reactions: { '+1': 0 }
            });
        }
    }
    comments.sort((a, b) => a.id - b.id);
    const hdr = () => ({ 'content-type': 'application/json', 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '50', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600) });
    globalThis.fetch = async (url) => {
        const u = new URL(url);
        calls.push(u.pathname + u.search);
        // Like GitHub on a large repository: later pages come from the Link header's cursor URL,
        // and asking for page 2+ by number is refused with 422.
        if (Number(u.searchParams.get('page') || 1) > 1) {
            return new Response(JSON.stringify({ message: 'Pagination with the page parameter is not supported for large datasets, please use cursor based pagination (after/before)' }), { status: 422, headers: hdr() });
        }
        const start = u.searchParams.get('after') ? Number(u.searchParams.get('after')) : 0;
        const per = Number(u.searchParams.get('per_page') || 30);
        const send = (list) => {
            const headers = hdr();
            if (start + per < list.length) {
                const next = new URL(u.href);
                next.searchParams.set('after', String(start + per));
                headers.link = `<${next.href}>; rel="next"`;
            }
            return new Response(JSON.stringify(list.slice(start, start + per)), { status: 200, headers });
        };
        const isComments = /\/issues\/comments$|\/issues\/\d+\/comments$/.test(u.pathname);
        if (isComments && mode === 'primary-limit') {
            return new Response('{"message":"API rate limit exceeded"}', { status: 403, headers: { 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3000) } });
        }
        if (isComments && mode === 'secondary-limit') {
            return new Response('{"message":"You have exceeded a secondary rate limit"}', { status: 403, headers: { 'retry-after': '1' } });
        }
        if (u.pathname === '/rate_limit') return new Response(JSON.stringify({ resources: { core: { limit: 60, remaining: 50, reset: 0 } } }), { status: 200, headers: hdr() });
        let m;
        if ((m = /\/issues\/(\d+)\/comments$/.exec(u.pathname))) return send(comments.filter(c => c.issue_url.endsWith('/' + m[1])));
        if (u.pathname.endsWith('/issues/comments')) { const since = u.searchParams.get('since'); return send(comments.filter(c => !since || c.updated_at >= since)); }
        if (u.pathname.endsWith('/issues')) { const st = u.searchParams.get('state'); return send(issues.filter(i => st === 'all' || i.state === st)); }
        return new Response('{"message":"Not Found"}', { status: 404, headers: hdr() });
    };
    return { calls, issues, comments };
}
