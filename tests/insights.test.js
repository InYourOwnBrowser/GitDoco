import test from 'node:test';
import assert from 'node:assert/strict';
import { toPhraseData } from '../js/phrase-map.js';
import { toTimelineData, niceScale, periodLabel } from '../js/topic-timeline.js';
import { mergeTopics } from '../js/issue-graph.js';
// The worker module also wires itself up for messages; importing it here is harmless (separate process).
const { extractPhrasesForMap } = await import('../js/nlp.worker.js');

test('mergeTopics: same-named topics become one, colour slots in fixed order', () => {
    const { topics, topicOf } = mergeTopics([{ label: 'a', issueNumbers: [1, 2] }, { label: 'b', issueNumbers: [3] }, { label: 'a', issueNumbers: [4, 1] }]);
    assert.deepEqual(topics.map(t => `${t.label}:${t.slot}:${t.count}`), ['a:0:3', 'b:1:1']);
    assert.deepEqual([...topicOf.entries()], [[1, 0], [2, 0], [3, 1], [4, 0]]);
});

test('extractPhrasesForMap merges a short phrase into a longer one that covers its threads', () => {
    const doc = (number, tokens) => ({ number, tokens });
    const docs = [
        doc(1, ['memory', 'leak', 'large', 'files']), doc(2, ['memory', 'leak', 'large', 'files']),
        doc(3, ['memory', 'leak', 'large', 'files']), doc(4, ['dark', 'mode', 'colours']), doc(5, ['dark', 'mode', 'colours'])
    ];
    const phrases = extractPhrasesForMap(docs, docs.length, 60).map(p => p.phrase);
    assert.ok(phrases.includes('memory leak large'), phrases.join(', '));
    assert.ok(!phrases.includes('memory leak'), 'covered by "memory leak large"');
    assert.ok(phrases.includes('dark mode colours'));
    assert.ok(!phrases.includes('dark mode'));
    assert.ok(!phrases.includes('leak large files'), 'same threads and shares words with "memory leak large": merged');
    assert.equal(phrases.filter(p => p.includes('dark') || p.includes('colours')).length, 1);
});

test('toPhraseData links phrases that share threads, and picks a clear-majority topic', () => {
    const data = toPhraseData({
        phrases: [
            { phrase: 'memory leak', count: 4, issueNumbers: [1, 2, 3, 4] },
            { phrase: 'large files', count: 3, issueNumbers: [2, 3, 4] },
            { phrase: 'dark mode', count: 3, issueNumbers: [7, 8, 9] },
            { phrase: 'one overlap', count: 3, issueNumbers: [1, 8, 10] }
        ],
        clusters: [{ label: 'memory', issueNumbers: [1, 2, 3, 4] }, { label: 'theme', issueNumbers: [7, 8] }]
    });
    assert.deepEqual(data.edges.map(e => `${data.nodes[e.a].phrase}~${data.nodes[e.b].phrase}:${e.shared}`), ['memory leak~large files:3'], 'one shared thread is not enough');
    assert.deepEqual(data.nodes.map(n => n.topic), [0, 0, 1, -1]);
});

test('toTimelineData: weekly for a short span, months otherwise, gaps filled, no-topic last', () => {
    const issues = [
        { number: 1, createdAtIso: '2026-01-05T10:00:00Z' }, { number: 2, createdAtIso: '2026-01-07T10:00:00Z' },
        { number: 3, createdAtIso: '2026-01-28T10:00:00Z' }, { number: 3, createdAtIso: '2026-01-28T10:00:00Z' },
        { number: 4, createdAt: 'not a date' }
    ];
    const weekly = toTimelineData({ issues, clusters: [{ label: 'x', issueNumbers: [1] }] });
    assert.equal(weekly.unit, 'week');
    assert.equal(weekly.undated, 1);
    assert.deepEqual(weekly.periods.map(p => p.total), [2, 0, 0, 1], 'four Monday-based weeks, empty ones kept');
    assert.deepEqual(weekly.periods[0].counts, [1, 1], 'topic x, then no topic');
    assert.deepEqual(weekly.periods[0].numbers[1], [2]);
    assert.equal(weekly.periods[0].label, '5 Jan 2026');

    const monthly = toTimelineData({ issues: [{ number: 1, createdAtIso: '2025-01-15T00:00:00Z' }, { number: 2, createdAtIso: '2025-09-02T00:00:00Z' }] });
    assert.equal(monthly.unit, 'month');
    assert.equal(monthly.periods.length, 9);
    assert.equal(monthly.periods[8].label, 'Sep 2025');

    const long = toTimelineData({ issues: [{ number: 1, createdAtIso: '2015-02-01T00:00:00Z' }, { number: 2, createdAtIso: '2025-11-01T00:00:00Z' }] });
    assert.equal(long.unit, 'quarter');
    assert.equal(periodLabel(Date.UTC(2025, 9, 1), 'quarter'), 'Q4 2025');
});

test('niceScale gives round gridlines', () => {
    assert.deepEqual(niceScale(17), { top: 20, step: 5 });
    assert.deepEqual(niceScale(3), { top: 3, step: 1 });
    assert.deepEqual(niceScale(0), { top: 1, step: 1 });
    assert.deepEqual(niceScale(230), { top: 300, step: 100 });
});
