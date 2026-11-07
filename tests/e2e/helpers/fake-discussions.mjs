/**
 * In-memory fake of GitHub's Discussions APIs: GraphQL (POST /graphql) and the undocumented REST
 * endpoints (/repos/{o}/{r}/discussions[/{n}/comments]). Response shapes follow GitHub's GraphQL
 * schema and the `discussion` schema GitHub publishes for webhooks.
 *
 * Every discussion n: category "Q&A" (answerable) when n is odd, "Ideas" otherwise.
 * Odd n divisible by 3 is answered; its answer is the second top-level comment.
 * Top-level comment 0 has one reply. Discussion 7 has a minimized (hidden) comment.
 */
export function installFakeDiscussions({ count = 40, disabled = false } = {}) {
    const calls = [];
    const discussions = [];
    let cid = 5000;
    for (let n = count; n >= 1; n--) {
        const answerable = n % 2 === 1;
        const created = new Date(Date.UTC(2026, 2, 1) + n * 86400000).toISOString();
        const top = [];
        const nTop = n % 4; // 0..3 top-level comments
        for (let j = 0; j < nTop; j++) {
            const c = {
                id: cid++, author: ['ann', 'ben', 'cat'][j % 3], assoc: j === 1 ? 'MEMBER' : 'NONE',
                body: `Comment ${j} on discussion ${n}: some helpful detail.`, created,
                minimized: n === 7 && j === 2, replies: []
            };
            if (j === 0) {
                c.replies.push({ id: cid++, author: 'dan', assoc: 'NONE', body: `Reply to comment 0 on discussion ${n}.`, created, minimized: false, replies: [] });
            }
            top.push(c);
        }
        const answered = answerable && n % 3 === 0 && top.length >= 2;
        if (answered) top[1].isAnswer = true;
        discussions.push({
            number: n, title: `Discussion ${n}: how do I ${n % 2 ? 'configure' : 'extend'} it?`,
            body: `Question body for discussion ${n}.`, created, answerable, answered,
            category: answerable ? 'Q&A' : 'Ideas', author: 'asker', upvotes: n % 5, top,
            closed: n % 10 === 0
        });
    }

    const actor = login => ({ login, __typename: 'User' });
    const gqlComment = (c, withReplies) => ({
        databaseId: c.id, body: c.body, createdAt: c.created, isAnswer: Boolean(c.isAnswer), isMinimized: c.minimized,
        authorAssociation: c.assoc, upvoteCount: 0, author: actor(c.author),
        ...(withReplies ? { replies: { totalCount: c.replies.length, nodes: c.replies.map(r => gqlComment(r, false)) } } : {})
    });
    const gqlDiscussion = d => ({
        number: d.number, title: d.title, body: d.body, url: `https://github.com/o/r/discussions/${d.number}`,
        createdAt: d.created, updatedAt: d.created, closed: d.closed, closedAt: d.closed ? d.created : null,
        stateReason: d.closed ? 'RESOLVED' : null, locked: false, isAnswered: d.answerable ? d.answered : null,
        upvoteCount: d.upvotes, authorAssociation: 'NONE', author: actor(d.author),
        category: { name: d.category, emoji: ':speech_balloon:', isAnswerable: d.answerable },
        labels: { nodes: [{ name: 'help' }] }, comments: { totalCount: d.top.length },
        answer: d.answered ? { databaseId: d.top.find(c => c.isAnswer).id } : null
    });
    const restUser = login => ({ login, type: 'User' });
    const restComment = (c, parentId = null) => ({
        id: c.id, body: c.body, user: restUser(c.author), author_association: c.assoc, created_at: c.created,
        parent_id: parentId, html_url: `https://github.com/o/r/discussions/x#discussioncomment-${c.id}`, reactions: { '+1': 0 }
    });

    const hdr = () => ({ 'content-type': 'application/json', 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4990', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600) });
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: hdr() });

    globalThis.fetch = async (url, init = {}) => {
        const u = new URL(url);
        if (u.pathname === '/graphql') {
            const { query, variables } = JSON.parse(init.body);
            calls.push('graphql:' + (query.includes('discussions(first') ? 'manifest' : 'comments'));
            const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
            if (!/^bearer /i.test(headers.authorization || '')) return json({ message: 'Requires authentication' }, 401);
            if (query.includes('discussions(first')) {
                const start = variables.after ? Number(variables.after) : 0;
                const slice = discussions.slice(start, start + variables.first);
                const end = start + slice.length;
                return json({ data: { repository: {
                    hasDiscussionsEnabled: !disabled,
                    discussions: { totalCount: discussions.length, pageInfo: { hasNextPage: end < discussions.length, endCursor: String(end) }, nodes: slice.map(gqlDiscussion) }
                } } });
            }
            const repository = {};
            for (const m of query.matchAll(/(d\d+): discussion\(number: (\d+)\)/g)) {
                const d = discussions.find(x => x.number === Number(m[2]));
                repository[m[1]] = d ? { comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: d.top.map(c => gqlComment(c, true)) } } : null;
            }
            return json({ data: { repository } });
        }
        calls.push(u.pathname + u.search);
        if (u.pathname === '/rate_limit') return json({ resources: { core: { limit: 60, remaining: 50, reset: 0 } } });
        if (disabled && u.pathname.includes('/discussions')) return json({ message: 'Discussions are disabled for this repo', status: '410' }, 410);
        let m;
        if ((m = /\/repos\/o\/r\/discussions\/(\d+)\/comments$/.exec(u.pathname))) {
            const d = discussions.find(x => x.number === Number(m[1]));
            const flat = [];
            for (const c of d.top) {
                flat.push(restComment(c));
                for (const r of c.replies) flat.push(restComment(r, c.id));
            }
            return json(flat.filter((_, i) => !(d.number === 7 && i === 3)));
        }
        if (u.pathname === '/repos/o/r/discussions') {
            const page = Number(u.searchParams.get('page') || 1);
            const per = Number(u.searchParams.get('per_page') || 30);
            return json(discussions.slice((page - 1) * per, page * per).map(d => ({
                number: d.number, title: d.title, body: d.body, user: restUser(d.author), state: d.closed ? 'closed' : 'open',
                state_reason: d.closed ? 'resolved' : null, locked: false, author_association: 'NONE',
                category: { name: d.category, is_answerable: d.answerable, emoji: ':speech_balloon:' },
                answer_html_url: d.answered ? `https://github.com/o/r/discussions/${d.number}#discussioncomment-${d.top.find(c => c.isAnswer).id}` : null,
                answer_chosen_at: d.answered ? d.created : null,
                comments: d.top.length + d.top.reduce((s, c) => s + c.replies.length, 0),
                reactions: { total_count: d.upvotes, '+1': d.upvotes },
                created_at: d.created, updated_at: d.created, html_url: `https://github.com/o/r/discussions/${d.number}`, labels: []
            })));
        }
        return json({ message: 'Not Found' }, 404);
    };
    return { calls, discussions };
}
