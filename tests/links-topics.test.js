import test from 'node:test';
import assert from 'node:assert/strict';
import { githubFileUrl, isGithubUrl, registryUrl, depsDevUrl, advisoryUrl } from '../js/links.js';
import { searchTopic, parseTopicQuery, stem } from '../js/topic-search.js';

// ------------------------------------------------------------------ links

test('GitHub file links are encoded and refuse unsafe parts', () => {
    assert.equal(githubFileUrl('o', 'r', 'main', 'src/a b.js'), 'https://github.com/o/r/blob/main/src/a%20b.js');
    assert.equal(githubFileUrl('o', 'r', 'release/1.2', 'docs/#x?.md'), 'https://github.com/o/r/blob/release/1.2/docs/%23x%3F.md');
    assert.equal(githubFileUrl('o', 'r', '../../evil/repo', 'a.js'), null);
    assert.equal(githubFileUrl('o', 'r', 'main', '../a.js'), null);
    assert.equal(githubFileUrl('o/x', 'r', 'main', 'a.js'), null);
    assert.equal(githubFileUrl('o', 'r', 'main', ''), null);
});

test('only github.com URLs are used for thread links', () => {
    assert.ok(isGithubUrl('https://github.com/o/r/issues/1'));
    assert.ok(isGithubUrl('https://github.com/o/r/discussions/7'));
    for (const bad of ['javascript:alert(1)', 'http://github.com/o/r', 'https://github.com.evil.io/x', 'https://evil.io/github.com/', '', null, 'https://github.com/o r']) {
        assert.ok(!isGithubUrl(bad), String(bad));
    }
});

test('registry, deps.dev and advisory links', () => {
    assert.equal(registryUrl('npm', '@babel/core', '7.24.0'), 'https://www.npmjs.com/package/@babel/core/v/7.24.0');
    assert.equal(registryUrl('npm', 'express', null), 'https://www.npmjs.com/package/express');
    assert.equal(registryUrl('pypi', 'requests', '2.31.0'), 'https://pypi.org/project/requests/2.31.0/');
    assert.equal(registryUrl('go', 'github.com/spf13/cobra', 'v1.8.0'), 'https://pkg.go.dev/github.com/spf13/cobra@v1.8.0');
    assert.equal(registryUrl('cargo', 'serde', '1.0.200'), 'https://crates.io/crates/serde/1.0.200');
    assert.equal(registryUrl('npm', 'x"><script>', '1'), 'https://www.npmjs.com/package/x%22%3E%3Cscript%3E/v/1');
    assert.equal(registryUrl('maven', 'x', '1'), null);
    assert.equal(depsDevUrl('npm', '@babel/core', '7.24.0'), 'https://deps.dev/npm/%40babel%2Fcore/7.24.0');
    assert.equal(advisoryUrl('GHSA-qw6h-vgh9-j6wx'), 'https://github.com/advisories/GHSA-qw6h-vgh9-j6wx');
    assert.equal(advisoryUrl('PYSEC-2023-74'), 'https://osv.dev/vulnerability/PYSEC-2023-74');
    assert.equal(advisoryUrl('../x'), null);
    assert.equal(advisoryUrl('javascript:alert(1)'), null, 'no spaces or parentheses allowed');
});

// ------------------------------------------------------------------ topic search

const docs = [
    { number: 1, title: 'Memory leak when streaming large files', body: 'Heap grows until OOM after a few hours of streaming.' },
    { number: 2, title: 'Leaking memory in worker pool', body: 'Workers are never released, heap usage keeps growing, OOM crash.' },
    { number: 3, title: 'Process killed with OOM', body: 'Heap keeps growing while streaming responses, then the process crashes.' },
    { number: 4, title: 'Dark mode colors wrong', body: 'The sidebar ignores the theme in dark mode.' },
    { number: 5, title: 'Add dark mode toggle', body: 'Please add a toggle for the dark theme in settings.' },
    { number: 6, title: 'Typo in README', body: 'Small typo in install section.' },
    { number: 7, title: 'Heap usage grows with streaming', body: 'Streaming large responses makes heap grow, workers OOM.' },
    { number: 8, title: 'Bleak outlook on CI speed', body: 'CI is slow.' }
];

test('topic query parsing and stemming', () => {
    assert.deepEqual(parseTopicQuery('Memory leaks "dark mode"'), { phrases: ['dark mode'], words: ['memory', 'leak'] });
    assert.deepEqual(['leaking', 'leaks', 'crashes', 'fixed', 'libraries', 'class'].map(stem), ['leak', 'leak', 'crash', 'fix', 'library', 'class']);
    assert.equal(searchTopic(docs, '   '), null);
});

test('topic search: every word must match, word variants count, title hits rank first', () => {
    const r = searchTopic(docs, 'memory leak');
    assert.deepEqual(r.matches.sort(), [1, 2]);
    assert.ok(!r.matches.includes(8), '"leak" does not match inside "Bleak"');
    assert.deepEqual(searchTopic(docs, '"dark mode"').matches.sort(), [4, 5]);
    assert.deepEqual(searchTopic(docs, 'dark mode toggle').matches, [5]);
    assert.deepEqual(searchTopic(docs, 'nothing-like-this').matches, []);
});

test('topic search: related threads discuss the same thing in other words', () => {
    const r = searchTopic(docs, 'memory leak');
    assert.ok(r.related.includes(7) && r.related.includes(3), `related: ${r.related}`);
    assert.ok(!r.related.includes(4) && !r.related.includes(6), 'unrelated threads stay out');
    assert.equal(searchTopic(docs, 'typo').related.length, 0);
});
