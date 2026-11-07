import test from 'node:test';
import assert from 'node:assert/strict';
import { toIssueGraphData, adjacency, components, forceLayout } from '../js/issue-graph.js';
import { extractIssueReferences } from '../js/issue-cleaner.js';

const issues = [
    { number: 1, title: 'Crash on start', body: 'Same as #2, see also #99 (not loaded)', state: 'open', commentsCount: 4, labels: [{ name: 'bug' }], htmlUrl: 'https://github.com/o/r/issues/1' },
    { number: 2, title: 'App crashes when starting', body: '', state: 'closed', commentsCount: 0, labels: ['bug'], htmlUrl: 'javascript:alert(1)' },
    { number: 3, title: 'Docs typo', body: 'Fixes it', state: 'open', isPullRequest: true, mergedAt: '2026-01-01', commentsCount: 1 },
    { number: 4, title: 'Unrelated', body: 'code: `#1` is not a reference', state: 'open' },
    { number: 5, title: 'Docs: another typo', body: '', state: 'open' }
];

function sample() {
    return toIssueGraphData({
        issues,
        clusters: [{ label: 'crash / start', issueNumbers: [1] }, { label: 'docs / typo', issueNumbers: [3, 5] }, { label: 'crash / start', issueNumbers: [2] }],
        similarMap: { 3: [5], 5: [3], 1: [2] },
        extraTexts: n => (n === 3 ? ['Closes #5'] : []),
        extractRefs: extractIssueReferences
    });
}

test('toIssueGraphData: references (body and comments), similar wording, topics, states', () => {
    const data = sample();
    const num = id => data.nodes[id].number;
    const edges = data.edges.map(e => `${num(e.a)}-${num(e.b)}:${e.ref ? 'ref' : ''}${e.similar ? 'sim' : ''}`).sort();
    assert.deepEqual(edges, ['1-2:refsim', '3-5:refsim'], 'merged per pair; #99 is not loaded; a #1 in code is not a reference');
    const by = Object.fromEntries(data.nodes.map(n => [n.number, n]));
    assert.deepEqual([by[1].topic, by[3].topic, by[4].topic], [0, 1, -1]);
    assert.deepEqual([by[1].state, by[2].state, by[3].state], ['open', 'closed', 'merged']);
    assert.equal(by[1].url, 'https://github.com/o/r/issues/1');
    assert.equal(by[2].url, '', 'only github.com links');
    assert.deepEqual(by[2].labels, ['bug']);
    assert.equal(data.topics[1].label, 'docs / typo');
    assert.deepEqual(data.topics.map(t => `${t.label}:${t.count}`), ['crash / start:2', 'docs / typo:2'], 'same-named topics merged');
    assert.equal(by[2].topic, 0);
    const twice = toIssueGraphData({ issues: [...issues, ...issues], extractRefs: extractIssueReferences });
    assert.equal(twice.nodes.length, issues.length, 'an issue loaded twice appears once');
});

test('adjacency and components honour the edge kinds shown', () => {
    const data = sample();
    const all = components(adjacency(data));
    assert.deepEqual(all.groups.map(g => g.length).sort(), [1, 2, 2]);
    const refsOnly = toIssueGraphData({ issues, similarMap: { 4: [5] }, extractRefs: extractIssueReferences });
    assert.equal(components(adjacency(refsOnly, { refs: true, similar: false })).groups.length, 4, '1-2 by reference; 4-5 only similar, hidden');
    assert.equal(components(adjacency(refsOnly, { refs: true, similar: true })).groups.length, 3);
});

test('forceLayout is deterministic and keeps linked issues closer than unlinked ones', () => {
    const many = [];
    for (let i = 1; i <= 60; i++) many.push({ number: i, title: `t${i}`, body: i % 2 === 0 ? `see #${i - 1}` : '', state: 'open' });
    const data = toIssueGraphData({ issues: many, extractRefs: extractIssueReferences });
    const adj = adjacency(data);
    const ids = data.nodes.map(n => n.id);
    const a = forceLayout(data, ids, adj), b = forceLayout(data, ids, adj);
    assert.deepEqual([...a.values()], [...b.values()], 'same input, same picture');
    const dist = (x, y) => Math.hypot(a.get(x).x - a.get(y).x, a.get(x).y - a.get(y).y);
    let linked = 0, other = 0;
    for (let i = 1; i < 60; i += 2) { linked += dist(i, i - 1 + 0); other += dist(i, (i + 20) % 60); }
    assert.ok(linked < other / 2, `linked pairs sit together (${(linked / 30).toFixed(0)} vs ${(other / 30).toFixed(0)})`);
    for (const p of a.values()) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
});
