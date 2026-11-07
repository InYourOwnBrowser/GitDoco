import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDiscussions } from './e2e/helpers/fake-discussions.mjs';
import {
    fetchDiscussionsManifest, fetchCommentsForDiscussions, arrangeRestComments,
    estimateDiscussionCommentCost, githubGraphql, DiscussionsError
} from '../js/github-discussions-api.js';
import { processIssueThread, filterIncludedComments } from '../js/issue-cleaner.js';
import { buildIssuesOutput } from '../js/issue-formatters.js';
import { buildTabHref } from '../js/nav.js';
import { buildSummaryLines } from '../js/ui-summary.js';

test('GraphQL manifest maps discussions to issue-shaped records', async () => {
    const fake = installFakeDiscussions({ count: 130 });
    const list = await fetchDiscussionsManifest('o', 'r', { pat: 'ghp_x', maxItems: 120 });
    assert.equal(list.source, 'graphql');
    assert.equal(list.length, 120);
    assert.equal(fake.calls.filter(c => c === 'graphql:manifest').length, 2, 'pages of 100');
    const d9 = list.find(d => d.number === 129);
    assert.equal(d9.category, 'Q&A');
    assert.equal(d9.isAnswerable, true);
    assert.equal(d9.isDiscussion, true);
    assert.equal(d9.htmlUrl, 'https://github.com/o/r/discussions/129');
    const closed = list.find(d => d.number === 120);
    assert.equal(closed.state, 'closed');
    assert.equal(closed.stateReason, 'resolved');
    assert.equal(list.stoppedEarly, false, 'stoppedEarly means the 30-page scan cap, not maxItems');
});

test('GraphQL comments: batched 10 per request, replies follow parents, answer marked, hidden dropped', async () => {
    const fake = installFakeDiscussions({ count: 40 });
    const list = await fetchDiscussionsManifest('o', 'r', { pat: 'ghp_x', maxItems: 40 });
    fake.calls.length = 0;
    const withComments = list.filter(d => d.commentsCount > 0);
    const { commentsByIssue, failures, stats } = await fetchCommentsForDiscussions('o', 'r', list, { pat: 'ghp_x' });
    assert.equal(failures.length, 0);
    assert.equal(stats.strategy, 'graphql');
    assert.equal(fake.calls.length, Math.ceil(withComments.length / 10));
    assert.equal(estimateDiscussionCommentCost(list, true), Math.ceil(withComments.length / 10));

    const d3 = commentsByIssue.get(3); // 3 top-level comments, comment 1 is the answer, comment 0 has a reply
    assert.deepEqual(d3.map(c => [c.author, Boolean(c.isAnswer), c.replyToAuthor]), [
        ['ann', false, null], ['dan', false, 'ann'], ['ben', true, null], ['cat', false, null]
    ]);
    const d7 = commentsByIssue.get(7);
    assert.ok(!d7.some(c => c.body.startsWith('Comment 2')), 'minimized comment dropped');
});

test('REST fallback: manifest and comments without a token', async () => {
    const fake = installFakeDiscussions({ count: 12 });
    const list = await fetchDiscussionsManifest('o', 'r', { maxItems: 50 });
    assert.equal(list.source, 'rest');
    assert.equal(list.length, 12);
    assert.ok(!fake.calls.some(c => c.startsWith('graphql')));
    const d3 = list.find(d => d.number === 3);
    assert.equal(d3.isAnswered, true);
    assert.ok(d3.answerCommentId > 0);
    const { commentsByIssue } = await fetchCommentsForDiscussions('o', 'r', [d3], {});
    assert.deepEqual(commentsByIssue.get(3).map(c => [c.author, c.isAnswer, c.replyToAuthor]), [
        ['ann', false, null], ['dan', false, 'ann'], ['ben', true, null], ['cat', false, null]
    ]);
    assert.equal(estimateDiscussionCommentCost([d3], false), 1);
});

test('Discussions turned off: clear error from both GraphQL and REST', async () => {
    installFakeDiscussions({ disabled: true });
    await assert.rejects(fetchDiscussionsManifest('o', 'r', { pat: 'ghp_x' }), e => e instanceof DiscussionsError && e.disabled && /turned off/.test(e.message));
    await assert.rejects(fetchDiscussionsManifest('o', 'r', {}), e => e.disabled && e.status === 410);
});

test('GraphQL errors: rate limit, not found, and no token', async () => {
    const respond = body => { globalThis.fetch = async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }); };
    respond({ errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] });
    await assert.rejects(githubGraphql('{x}', {}, { pat: 't' }), e => e.isRateLimit);
    respond({ data: { repository: null }, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve' }] });
    await assert.rejects(githubGraphql('{x}', {}, { pat: 't' }), e => e.status === 404);
    await assert.rejects(githubGraphql('{x}', {}, {}), e => e.status === 401);
});

test('arrangeRestComments keeps orphan replies and matches the answer by URL', () => {
    const raw = [
        { id: 1, body: 'a', user: { login: 'x' }, parent_id: null, html_url: 'u#discussioncomment-1' },
        { id: 2, body: 'b', user: { login: 'y' }, parent_id: 99, html_url: 'u#discussioncomment-2' }
    ];
    const out = arrangeRestComments(raw, { answerCommentId: null, answerHtmlUrl: 'u#discussioncomment-1' });
    assert.deepEqual(out.map(c => [c.id, c.isAnswer]), [[1, true], [2, false]]);
});

const comments = [
    { id: 1, author: 'asker', authorAssociation: 'NONE', body: 'Follow-up details from the asker.' },
    { id: 2, author: 'helper', authorAssociation: 'NONE', body: 'Here is the fix that worked.', isAnswer: true },
    { id: 3, author: 'maint', authorAssociation: 'MEMBER', body: 'Confirmed, thanks!', replyToId: 2, replyToAuthor: 'helper' },
    { id: 4, author: 'rando', authorAssociation: 'NONE', body: 'Same question here, any update?' },
    { id: 5, author: 'bot', authorType: 'Bot', authorAssociation: 'NONE', body: 'Automated notice.' }
];
const discussion = { number: 1, author: 'asker', title: 'How?', body: 'Question', labels: [] };

test('comment scopes for discussions', () => {
    const ids = scope => filterIncludedComments(discussion, comments, { commentScope: scope }).kept.map(c => c.id);
    assert.deepEqual(ids('answer'), [2]);
    assert.deepEqual(ids('answer-maintainers'), [1, 2, 3]);
    assert.deepEqual(ids('all'), [1, 2, 3, 4]);
    assert.deepEqual(ids('none'), []);
});

test('processIssueThread carries answer and reply markers only when set', () => {
    const t = processIssueThread(discussion, comments, { commentScope: 'answer-maintainers' });
    assert.deepEqual(t.cleanedComments.map(c => [c.author, c.isAnswer, c.replyTo]), [
        ['asker', undefined, undefined], ['helper', true, undefined], ['maint', undefined, 'helper']
    ]);
});

test('formatters: discussion wording and markers in all four formats; issues unchanged', () => {
    const thread = {
        ...processIssueThread(discussion, comments, { commentScope: 'answer-maintainers' }),
        state: 'open', authorAssociation: 'NONE', createdAt: '2026-03-01', category: 'Q&A',
        isAnswerable: true, isAnswered: true, reactionsTotal: 4
    };
    const repo = { owner: 'o', repo: 'r' };
    const opts = { kind: 'discussions' };

    const xml = buildIssuesOutput('claude-xml', repo, [thread], opts).text;
    assert.match(xml, /Global Repository Discussions Context/);
    assert.match(xml, /<discussion_count>1<\/discussion_count>/);
    assert.match(xml, /discussion_number="1"/);
    assert.match(xml, /<category>Q&amp;A<\/category>/);
    assert.match(xml, /<answered>yes<\/answered>/);
    assert.match(xml, /<upvotes>4<\/upvotes>/);
    assert.match(xml, /<discussion_body>/);
    assert.match(xml, /author="helper"[^>]*accepted_answer="true"/);
    assert.match(xml, /author="maint"[^>]*reply_to="helper"/);

    const md = buildIssuesOutput('markdown', repo, [thread], opts).text;
    assert.match(md, /^# GitHub Discussions: o\/r$/m);
    assert.match(md, /\*\*Category:\*\* Q&A \| \*\*Answered:\*\* yes \| \*\*Upvotes:\*\* 4/);
    assert.match(md, /@helper \(NONE\) on [^\n]*\[Accepted answer\]:/);
    assert.match(md, /@maint \(MEMBER\) on [^\n]*\(reply to @helper\):/);

    const gx = buildIssuesOutput('generic-xml', repo, [thread], opts).text;
    assert.match(gx, /^<discussions_repository name="o\/r" count="1">/);
    assert.match(gx, /<discussion number="1" [^>]*category="Q&amp;A" answered="yes" upvotes="4">/);
    assert.match(gx, /<\/discussions>\n<\/discussions_repository>$/);

    const json = JSON.parse(buildIssuesOutput('json', repo, [thread], opts).text);
    assert.equal(json.discussions[0].category, 'Q&A');
    assert.equal(json.discussions[0].answered, true);
    assert.equal(json.discussions[0].upvotes, 4);
    assert.equal(json.discussions[0].comments[1].isAnswer, true);
    assert.equal(json.issues, undefined);

    const issueXml = buildIssuesOutput('claude-xml', repo, [{ ...thread, category: undefined }], {}).text;
    assert.match(issueXml, /<issue_count>1<\/issue_count>/);
    assert.doesNotMatch(issueXml, /<category>|<answered>|<upvotes>/);
});

test('nav and summary know about discussions', () => {
    assert.equal(buildTabHref('discussions', 'o/r'), 'discussions.html?repo=o%2Fr');
    assert.equal(buildTabHref('discussions', ''), 'discussions.html');
    assert.equal(buildSummaryLines({ kind: 'discussions', items: 3, comments: 7, tokens: 10 })[0], '3 discussions included · 7 comments');
});
