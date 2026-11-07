/**
 * GitHub Discussions client.
 *
 * - With a token: GitHub's GraphQL API (the only official, documented API for Discussions).
 *   One request lists up to 100 discussions; comment threads (with replies and the accepted
 *   answer) are fetched for up to 10 discussions per request.
 * - Without a token: GitHub's REST endpoints /repos/{owner}/{repo}/discussions[/{n}/comments].
 *   These are undocumented (they are absent from GitHub's published REST API description), so
 *   they may change without notice. The fields read here follow the `discussion` schema GitHub
 *   publishes for webhooks.
 *
 * Both paths return the same issue-shaped records that the Issues Explorer already handles,
 * plus discussion fields (category, isAnswered, accepted answer, reply links).
 */
import { GITHUB_API_BASE } from './config.js';
import { fetchWithRetry, paginate, fetchAllPages } from './github-issues-api.js';

const GRAPHQL_URL = `${GITHUB_API_BASE}/graphql`;
const COMMENT_PAGE_SIZE = 100;
const REPLY_PAGE_SIZE = 50;
const DISCUSSIONS_PER_COMMENT_QUERY = 10;
const HARD_MAX_PAGES = 30;

export class DiscussionsError extends Error {
    constructor(message, { status = null, isRateLimit = false, disabled = false } = {}) {
        super(message);
        this.name = 'DiscussionsError';
        this.status = status;
        this.isRateLimit = isRateLimit;
        this.disabled = disabled;
    }
}

const day = iso => (iso ? String(iso).slice(0, 10) : '');
const lower = v => (v ? String(v).toLowerCase() : null);

// ---------------------------------------------------------------- GraphQL

/** Runs one GraphQL query. GraphQL always needs a token, so callers only use it when one is set. */
export async function githubGraphql(query, variables, { pat, signal, onHeaders } = {}) {
    if (!pat) throw new DiscussionsError('A GitHub token is needed for the GraphQL API.', { status: 401 });
    const json = await fetchWithRetry(GRAPHQL_URL, '', signal, onHeaders, {
        method: 'POST',
        headers: { 'Authorization': `bearer ${pat.trim()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables })
    });
    if (json && Array.isArray(json.errors) && json.errors.length > 0) {
        const first = json.errors[0];
        if (json.errors.some(e => e.type === 'RATE_LIMITED')) {
            throw new DiscussionsError('GitHub GraphQL rate limit reached. Try again later.', { isRateLimit: true });
        }
        if (first.type === 'NOT_FOUND' || (json.data && json.data.repository === null)) {
            throw new DiscussionsError("Can't find that repository. For a private repo, the token needs access to it.", { status: 404 });
        }
        // Partial data (e.g. one aliased discussion missing) is still usable.
        if (!json.data) throw new DiscussionsError(`GitHub GraphQL error: ${first.message || 'request failed'}`);
    }
    return json ? json.data : null;
}

const ACTOR = 'author { login __typename }';
const COMMENT_FIELDS = `databaseId body createdAt isAnswer isMinimized authorAssociation upvoteCount ${ACTOR}`;

const MANIFEST_QUERY = `
query($owner: String!, $name: String!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    hasDiscussionsEnabled
    discussions(first: $first, after: $after, orderBy: {field: CREATED_AT, direction: DESC}) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        number title body url createdAt updatedAt closed closedAt stateReason locked
        isAnswered upvoteCount authorAssociation ${ACTOR}
        category { name emoji isAnswerable }
        labels(first: 20) { nodes { name } }
        comments { totalCount }
        answer { databaseId }
      }
    }
  }
}`;

function fromGraphqlDiscussion(d) {
    const author = d.author || null;
    return {
        number: d.number,
        title: d.title || '',
        body: d.body || '',
        htmlUrl: d.url || '',
        state: d.closed ? 'closed' : 'open',
        stateReason: lower(d.stateReason),
        isDiscussion: true,
        isPullRequest: false,
        mergedAt: null,
        isAnswered: Boolean(d.isAnswered),
        isAnswerable: Boolean(d.category && d.category.isAnswerable),
        answerCommentId: d.answer ? d.answer.databaseId : null,
        category: d.category ? d.category.name : '',
        locked: Boolean(d.locked),
        author: author ? author.login : 'ghost',
        authorType: author && author.__typename === 'Bot' ? 'Bot' : 'User',
        authorAssociation: d.authorAssociation || 'NONE',
        createdAt: day(d.createdAt),
        createdAtIso: d.createdAt || '',
        updatedAtIso: d.updatedAt || d.createdAt || '',
        closedAt: d.closedAt ? day(d.closedAt) : null,
        commentsCount: (d.comments && d.comments.totalCount) || 0,
        reactionsTotal: d.upvoteCount || 0,
        reactionsPlusOne: d.upvoteCount || 0,
        labels: (d.labels && d.labels.nodes ? d.labels.nodes : []).map(l => l && l.name).filter(Boolean)
    };
}

function fromGraphqlComment(c, parent = null) {
    const author = c.author || null;
    return {
        id: c.databaseId,
        author: author ? author.login : 'ghost',
        authorType: author && author.__typename === 'Bot' ? 'Bot' : 'User',
        authorAssociation: c.authorAssociation || 'NONE',
        createdAt: day(c.createdAt),
        reactionsPlusOne: c.upvoteCount || 0,
        body: c.body || '',
        isAnswer: Boolean(c.isAnswer),
        replyToId: parent ? parent.databaseId : null,
        replyToAuthor: parent ? (parent.author ? parent.author.login : 'ghost') : null
    };
}

/** Flattens top-level comments and their replies (replies follow their parent); drops hidden (minimized) ones. */
function flattenGraphqlComments(nodes) {
    const out = [];
    let truncated = false;
    for (const c of nodes || []) {
        if (!c) continue;
        if (!c.isMinimized) out.push(fromGraphqlComment(c));
        const replies = c.replies || { nodes: [], totalCount: 0 };
        for (const r of replies.nodes || []) {
            if (r && !r.isMinimized) out.push(fromGraphqlComment(r, c));
        }
        if ((replies.totalCount || 0) > (replies.nodes || []).length) truncated = true;
    }
    return { comments: out, truncated };
}

async function graphqlManifest(owner, repo, { maxItems, pat, signal, onHeaders, onProgress }) {
    const collected = [];
    let after = null;
    let hasNext = true;
    let pages = 0;
    while (hasNext && collected.length < maxItems && pages < HARD_MAX_PAGES) {
        const first = Math.min(100, maxItems - collected.length);
        const data = await githubGraphql(MANIFEST_QUERY, { owner, name: repo, first, after }, { pat, signal, onHeaders });
        const repoData = data && data.repository;
        if (!repoData) throw new DiscussionsError("Can't find that repository.", { status: 404 });
        if (repoData.hasDiscussionsEnabled === false) {
            throw new DiscussionsError('Discussions are turned off for this repository.', { status: 410, disabled: true });
        }
        const conn = repoData.discussions;
        for (const d of conn.nodes || []) if (d) collected.push(fromGraphqlDiscussion(d));
        hasNext = Boolean(conn.pageInfo && conn.pageInfo.hasNextPage);
        after = conn.pageInfo ? conn.pageInfo.endCursor : null;
        pages++;
        if (onProgress) onProgress(collected.length, Math.min(maxItems, conn.totalCount || maxItems));
    }
    collected.stoppedEarly = hasNext && collected.length < maxItems;
    return collected;
}

function commentsSelection(afterVar = '') {
    return `comments(first: ${COMMENT_PAGE_SIZE}${afterVar}) {
      pageInfo { hasNextPage endCursor }
      nodes { ${COMMENT_FIELDS} replies(first: ${REPLY_PAGE_SIZE}) { totalCount nodes { ${COMMENT_FIELDS} } } }
    }`;
}

async function graphqlComments(owner, repo, discussions, opts) {
    const { pat, signal, onHeaders, onProgress, onThread, maxCommentPages } = opts;
    const commentsByIssue = new Map();
    const failures = [];
    const stats = { strategy: 'graphql', requests: 0, perIssueRequestsEstimate: 0 };
    const counting = meta => { stats.requests++; if (onHeaders) onHeaders(meta); };
    let done = 0;

    for (let i = 0; i < discussions.length; i += DISCUSSIONS_PER_COMMENT_QUERY) {
        if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const batch = discussions.slice(i, i + DISCUSSIONS_PER_COMMENT_QUERY);
        // Discussion numbers are integers from GitHub, so inlining them in aliases is safe.
        const fields = batch.map(d => `d${Number(d.number)}: discussion(number: ${Number(d.number)}) { ${commentsSelection()} }`).join('\n');
        const query = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`;
        let data;
        try {
            data = await githubGraphql(query, { owner, name: repo }, { pat, signal, onHeaders: counting });
        } catch (err) {
            if (err.name === 'AbortError') throw err;
            for (const d of batch) failures.push({ number: d.number, error: err.message, isRateLimit: Boolean(err.isRateLimit) });
            if (err.isRateLimit) {
                stats.rateLimited = true;
                for (const d of discussions.slice(i + DISCUSSIONS_PER_COMMENT_QUERY)) failures.push({ number: d.number, error: err.message, isRateLimit: true });
                break;
            }
            continue;
        }

        for (const d of batch) {
            const node = data && data.repository ? data.repository[`d${Number(d.number)}`] : null;
            if (!node) {
                failures.push({ number: d.number, error: 'Discussion not returned by GitHub' });
                continue;
            }
            const nodes = [...(node.comments.nodes || [])];
            let pageInfo = node.comments.pageInfo || {};
            let pages = 1;
            let truncated = false;
            try {
                while (pageInfo.hasNextPage && pages < maxCommentPages) {
                    const more = await githubGraphql(
                        `query($owner: String!, $name: String!, $after: String) { repository(owner: $owner, name: $name) { discussion(number: ${Number(d.number)}) { ${commentsSelection(', after: $after')} } } }`,
                        { owner, name: repo, after: pageInfo.endCursor },
                        { pat, signal, onHeaders: counting }
                    );
                    const conn = more.repository.discussion.comments;
                    nodes.push(...(conn.nodes || []));
                    pageInfo = conn.pageInfo || {};
                    pages++;
                }
                if (pageInfo.hasNextPage) truncated = true;
            } catch (err) {
                if (err.name === 'AbortError') throw err;
                truncated = true;
            }
            const flat = flattenGraphqlComments(nodes);
            const list = flat.comments;
            if (truncated || flat.truncated) list.truncated = true;
            commentsByIssue.set(d.number, list);
            if (onThread) { try { onThread(d.number, list); } catch (_) {} }
        }
        done += batch.length;
        if (onProgress) onProgress(done, discussions.length);
    }
    return { commentsByIssue, failures, stats };
}

// ---------------------------------------------------------------- REST (undocumented, no token)

function restError(err) {
    if (err.name === 'AbortError' || err.isRateLimit) return err;
    if (err.status === 410) {
        return new DiscussionsError('Discussions are turned off for this repository.', { status: 410, disabled: true });
    }
    if (err.status === 404) {
        return new DiscussionsError("Can't find that repository or its discussions. For a private repo, or if GitHub's token-free discussions endpoint has changed, add a token.", { status: 404 });
    }
    return err;
}

function fromRestDiscussion(d) {
    const user = d.user || null;
    const answerId = /discussioncomment-(\d+)/.exec(d.answer_html_url || '');
    const closed = d.state === 'closed';
    return {
        number: d.number,
        title: d.title || '',
        body: d.body || '',
        htmlUrl: d.html_url || '',
        state: closed ? 'closed' : 'open',
        stateReason: lower(d.state_reason),
        isDiscussion: true,
        isPullRequest: false,
        mergedAt: null,
        isAnswered: Boolean(d.answer_html_url || d.answer_chosen_at),
        isAnswerable: Boolean(d.category && d.category.is_answerable),
        answerCommentId: answerId ? Number(answerId[1]) : null,
        answerHtmlUrl: d.answer_html_url || null,
        category: d.category ? d.category.name || '' : '',
        locked: Boolean(d.locked),
        author: user ? user.login : 'ghost',
        authorType: user ? (user.type || 'User') : 'User',
        authorAssociation: d.author_association || 'NONE',
        createdAt: day(d.created_at),
        createdAtIso: d.created_at || '',
        updatedAtIso: d.updated_at || d.created_at || '',
        closedAt: null,
        commentsCount: d.comments || 0,
        reactionsTotal: (d.reactions && d.reactions.total_count) || 0,
        reactionsPlusOne: (d.reactions && d.reactions['+1']) || 0,
        labels: Array.isArray(d.labels) ? d.labels.map(l => typeof l === 'string' ? l : l && l.name).filter(Boolean) : []
    };
}

async function restManifest(owner, repo, { maxItems, signal, onHeaders, onProgress }) {
    const collected = [];
    let stoppedEarly = false;
    try {
        // Follows GitHub's rel="next" links (page numbers fail on large repositories; see paginate).
        const firstUrl = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/discussions?per_page=100`;
        const pages = paginate(firstUrl, '', signal, onHeaders, { maxPages: HARD_MAX_PAGES });
        for (let step = await pages.next(); ; ) {
            if (step.done) { stoppedEarly = Boolean(step.value && step.value.more) && collected.length < maxItems; break; }
            for (const d of step.value) {
                collected.push(fromRestDiscussion(d));
                if (collected.length >= maxItems) break;
            }
            if (onProgress) onProgress(collected.length, maxItems);
            step = await pages.next(collected.length >= maxItems);
        }
    } catch (err) {
        throw restError(err);
    }
    collected.stoppedEarly = stoppedEarly;
    return collected;
}

/** Orders REST comments so replies (parent_id) follow their parent, and marks the accepted answer. */
export function arrangeRestComments(raw, discussion) {
    const answerId = discussion.answerCommentId;
    const answerUrl = discussion.answerHtmlUrl || null;
    const byId = new Map();
    const top = [];
    const replies = new Map();
    for (const c of raw) {
        byId.set(c.id, c);
        if (c.parent_id && c.parent_id !== c.id) {
            if (!replies.has(c.parent_id)) replies.set(c.parent_id, []);
            replies.get(c.parent_id).push(c);
        } else {
            top.push(c);
        }
    }
    const fmt = (c, parent = null) => ({
        id: c.id,
        author: c.user ? c.user.login : 'ghost',
        authorType: c.user ? (c.user.type || 'User') : 'User',
        authorAssociation: c.author_association || 'NONE',
        createdAt: day(c.created_at),
        reactionsPlusOne: (c.reactions && c.reactions['+1']) || 0,
        body: c.body || '',
        isAnswer: (answerId != null && c.id === answerId) || (answerUrl != null && c.html_url === answerUrl),
        replyToId: parent ? parent.id : null,
        replyToAuthor: parent ? (parent.user ? parent.user.login : 'ghost') : null
    });
    const out = [];
    for (const c of top) {
        out.push(fmt(c));
        for (const r of replies.get(c.id) || []) out.push(fmt(r, c));
    }
    // Replies whose parent is not in the list are kept at the end rather than dropped.
    for (const [parentId, list] of replies) {
        if (!byId.has(parentId)) for (const r of list) out.push(fmt(r));
    }
    return out;
}

async function restComments(owner, repo, discussions, opts) {
    const { signal, onHeaders, onProgress, onThread, maxCommentPages } = opts;
    const commentsByIssue = new Map();
    const failures = [];
    const stats = { strategy: 'rest', requests: 0, perIssueRequestsEstimate: discussions.length };
    const counting = meta => { stats.requests++; if (onHeaders) onHeaders(meta); };
    let done = 0;
    let idx = 0;
    let rateLimitError = null;

    async function worker() {
        while (idx < discussions.length && !rateLimitError) {
            if (signal && signal.aborted) break;
            const d = discussions[idx++];
            const raw = [];
            let truncated = false;
            try {
                const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/discussions/${Number(d.number)}/comments?per_page=100`;
                const all = await fetchAllPages(url, '', signal, counting, maxCommentPages);
                raw.push(...all.items);
                truncated = all.truncated;
                const list = arrangeRestComments(raw, d);
                if (truncated) list.truncated = true;
                commentsByIssue.set(d.number, list);
                if (onThread) { try { onThread(d.number, list); } catch (_) {} }
            } catch (err) {
                if (err.name === 'AbortError') throw err;
                const e = restError(err);
                failures.push({ number: d.number, error: e.message || String(e), isRateLimit: Boolean(e.isRateLimit) });
                if (e.isRateLimit) rateLimitError = e;
            }
            done++;
            if (onProgress) onProgress(done, discussions.length);
        }
    }
    await Promise.all(Array.from({ length: Math.min(4, discussions.length) }, () => worker()));
    if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (rateLimitError) {
        stats.rateLimited = true;
        const seen = new Set(failures.map(f => f.number));
        for (const d of discussions) {
            if (!commentsByIssue.has(d.number) && !seen.has(d.number)) {
                failures.push({ number: d.number, error: rateLimitError.message, isRateLimit: true });
            }
        }
    }
    return { commentsByIssue, failures, stats };
}

// ---------------------------------------------------------------- public API

/**
 * Lists a repository's discussions, newest first. Uses GraphQL with a token, else REST.
 * The returned array has `.source` ('graphql' | 'rest') and `.stoppedEarly`.
 */
export async function fetchDiscussionsManifest(owner, repo, options = {}) {
    const { maxItems = 300, pat = '', signal, onHeaders, onProgress } = options;
    const opts = { maxItems, pat: (pat || '').trim(), signal, onHeaders, onProgress };
    const list = opts.pat ? await graphqlManifest(owner, repo, opts) : await restManifest(owner, repo, opts);
    list.source = opts.pat ? 'graphql' : 'rest';
    return list;
}

/** Requests needed to fetch comments for these discussions (shown before building). */
export function estimateDiscussionCommentCost(discussions, hasToken) {
    const needs = discussions.filter(d => d.commentsCount > 0);
    if (needs.length === 0) return 0;
    if (hasToken) return Math.ceil(needs.length / DISCUSSIONS_PER_COMMENT_QUERY);
    return needs.reduce((sum, d) => sum + Math.max(1, Math.ceil(d.commentsCount / 100)), 0);
}

/**
 * Fetches comment threads (replies follow their parent; `isAnswer` marks the accepted answer).
 * Returns { commentsByIssue: Map<number, comment[]>, failures, stats } like fetchCommentsForIssues.
 */
export async function fetchCommentsForDiscussions(owner, repo, discussions, options = {}) {
    const { pat = '', maxCommentPages = 10 } = options;
    const needs = discussions.filter(d => d.commentsCount > 0);
    if (needs.length === 0) {
        return { commentsByIssue: new Map(), failures: [], stats: { strategy: pat ? 'graphql' : 'rest', requests: 0, perIssueRequestsEstimate: 0 } };
    }
    const opts = { ...options, pat: (pat || '').trim(), maxCommentPages };
    return opts.pat ? graphqlComments(owner, repo, needs, opts) : restComments(owner, repo, needs, opts);
}
