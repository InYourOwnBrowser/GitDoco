import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCompareInput, diffPackages, summarizeDiff } from '../js/deps-compare.js';
import { buildDepsOutput } from '../js/deps-formatters.js';
import { classifyLicense } from '../js/license-classify.js';

const repo = { owner: 'acme', repo: 'app' };

test('compare input: pull requests, refs, URLs and errors', () => {
    assert.equal(parseCompareInput(''), null);
    assert.equal(parseCompareInput('   '), null);
    for (const t of ['#42', '42', 'pr 42', 'PR #42', 'pull/42']) assert.deepEqual(parseCompareInput(t, repo), { kind: 'pr', number: 42 }, t);
    assert.deepEqual(parseCompareInput('https://github.com/acme/app/pull/7/files', repo), { kind: 'pr', number: 7 });
    assert.deepEqual(parseCompareInput('https://github.com/ACME/App/pull/7', repo), { kind: 'pr', number: 7 }, 'owner match ignores case');
    assert.match(parseCompareInput('https://github.com/other/app/pull/7', repo).error, /belongs to other\/app/);
    assert.deepEqual(parseCompareInput('feature/login', repo), { kind: 'ref', ref: 'feature/login' });
    assert.deepEqual(parseCompareInput('v1.2.0', repo), { kind: 'ref', ref: 'v1.2.0' });
    assert.deepEqual(parseCompareInput('abc1234', repo), { kind: 'ref', ref: 'abc1234' });
    assert.deepEqual(parseCompareInput('https://github.com/acme/app/tree/release%2F2.0/', repo), { kind: 'ref', ref: 'release/2.0' });
    assert.deepEqual(parseCompareInput('https://github.com/acme/app/commit/0123456789abcdef0123456789abcdef01234567', repo), { kind: 'ref', ref: '0123456789abcdef0123456789abcdef01234567' });
    assert.ok(parseCompareInput('../../etc', repo).error);
    assert.ok(parseCompareInput('a b', repo).error);
});

const P = (name, version, over = {}) => ({
    ecosystem: 'npm', name, version, relation: 'direct', dev: false, license: classifyLicense('MIT'),
    advisories: [], policy: { verdict: 'allow', reason: 'Permissive license (MIT)' }, ...over
});

function sample() {
    const base = [P('express', '4.18.2', { advisories: ['GHSA-old'] }), P('lodash', '4.17.20'), P('left-pad', '1.0.0'), P('same', '1.0.0')];
    const head = [
        P('express', '4.21.0', { advisories: ['GHSA-old', 'GHSA-new'], advisoryDetails: [{ id: 'GHSA-new', severity: 'high', score: 7.5, title: 'Bad thing' }] }),
        P('lodash', '4.17.20'),
        P('gpl-lib', '2.0.0', { relation: 'transitive', path: ['express', 'gpl-lib'], license: classifyLicense('GPL-3.0-only'), policy: { verdict: 'block', reason: 'Strong copyleft license (GPL-3.0-only)' } }),
        P('same', '1.0.0', { license: classifyLicense('LGPL-2.1'), policy: { verdict: 'review', reason: 'Weak copyleft license (LGPL-2.1)' } })
    ];
    return { base, head };
}

test('diff: added, updated, removed, new advisories and new policy findings', () => {
    const { base, head } = sample();
    const d = diffPackages(base, head);
    assert.deepEqual(d.added.map(p => p.name), ['gpl-lib']);
    assert.deepEqual(d.updated.map(u => [u.pkg.name, u.from, u.to]), [['express', ['4.18.2'], ['4.21.0']]]);
    assert.deepEqual(d.removed.map(p => p.name), ['left-pad']);
    assert.deepEqual(d.newAdvisories.map(a => `${a.pkg.name}:${a.id}`), ['express:GHSA-new'], 'an advisory already on the base is not new');
    assert.deepEqual(d.newPolicyFindings.map(p => `${p.name}:${p.policy.verdict}`), ['gpl-lib:block', 'same:review'], 'a verdict that got worse counts, even with no version change');
    assert.equal(head[0].change, 'updated');
    assert.deepEqual(head[0].changedFrom, ['4.18.2']);
    assert.equal(head[1].change, null);
    assert.equal(head[2].change, 'added');
    assert.equal(summarizeDiff(d), '1 added, 1 updated, 1 removed; 1 new advisory; 2 new policy findings');
    assert.equal(summarizeDiff(diffPackages([], [])), '0 added, 0 updated, 0 removed; 0 new advisories; 0 new policy findings');
});

test('diff: several versions of one package, and ecosystems kept apart', () => {
    const d = diffPackages(
        [P('debug', '2.6.9'), P('debug', '4.3.4'), P('six', '1.16.0', { ecosystem: 'pypi' })],
        [P('debug', '4.3.4'), P('debug', '2.6.9'), P('six', '1.16.0')]
    );
    assert.equal(d.updated.length, 0, 'the same set of versions in a different order is unchanged');
    assert.deepEqual(d.added.map(p => `${p.ecosystem}:${p.name}`), ['npm:six']);
    assert.deepEqual(d.removed.map(p => `${p.ecosystem}:${p.name}`), ['pypi:six']);
    const d2 = diffPackages([P('debug', '2.6.9'), P('debug', '4.3.4')], [P('debug', '4.3.4')]);
    assert.deepEqual(d2.updated.map(u => [u.from, u.to]), [[['2.6.9', '4.3.4'], ['4.3.4']]]);
    const both = [P('encodeurl', '1.0.2'), P('encodeurl', '2.0.1')];
    const d3 = diffPackages([P('encodeurl', '1.0.2')], both);
    assert.equal(d3.updated.length, 1);
    assert.deepEqual(both.map(p => p.change), [null, 'updated'], 'a version already on the base is not marked');
    const worse = diffPackages([P('x', '1', { policy: { verdict: 'block', reason: 'r' } })], [P('x', '1', { policy: { verdict: 'review', reason: 'r' } })]);
    assert.equal(worse.newPolicyFindings.length, 0, 'an improved verdict is not a new finding');
});

test('every output format includes the comparison', () => {
    const { base, head } = sample();
    const diff = diffPackages(base, head);
    const ctx = {
        repoName: 'acme/app', source: 'GitHub', packages: head, manifests: ['package.json'],
        includeTransitive: true, comparison: { base: 'main', head: 'pull request #7 "<b>x</b>"', diff }
    };
    const xml = buildDepsOutput('claude-xml', ctx).text;
    assert.match(xml, /<document index="1">\s*<source>Dependency changes: pull request #7 &quot;&lt;b&gt;x&lt;\/b&gt;&quot; compared with main<\/source>/, 'comparison is the first document, escaped');
    assert.match(xml, /<comparison base="main" head="[^"]*" added="1" updated="1" removed="1" new_advisories="1" new_policy_findings="2">/);
    assert.match(xml, /<added package="npm:gpl-lib@2\.0\.0"[^>]*path="express → gpl-lib"[^>]*policy="block/);
    assert.match(xml, /<updated package="npm:express" from="4\.18\.2" to="4\.21\.0"/);
    assert.match(xml, /<removed package="npm:left-pad@1\.0\.0"/);
    assert.match(xml, /<new_advisory id="GHSA-new" severity="high" package="npm:express@4\.21\.0">Bad thing<\/new_advisory>/);
    assert.match(xml, /<new_policy_finding verdict="review" package="npm:same@1\.0\.0">/);

    const md = buildDepsOutput('markdown', ctx).text;
    assert.match(md, /^## Changes: pull request #7 .* compared with main$/m);
    assert.match(md, /^### New policy findings$/m);
    assert.match(md, /^\| Blocked \| npm:gpl-lib@2\.0\.0 \|/m);
    assert.match(md, /^\| High \(7\.5\) \| GHSA-new \| npm:express@4\.21\.0 \| Bad thing \|$/m);
    assert.match(md, /^### Removed$/m);

    const gx = buildDepsOutput('generic-xml', ctx).text;
    assert.match(gx, /<comparison base="main" head="pull request #7 &quot;&lt;b&gt;x&lt;\/b&gt;&quot;">/);

    const json = JSON.parse(buildDepsOutput('json', ctx).text);
    assert.equal(json.comparison.base, 'main');
    assert.deepEqual(json.comparison.updated, [{ package: 'npm:express', from: ['4.18.2'], to: ['4.21.0'] }]);
    assert.deepEqual(json.comparison.new_advisories, [{ id: 'GHSA-new', package: 'npm:express@4.21.0' }]);
    assert.equal(json.comparison.new_policy_findings[0].verdict, 'block');

    const noCmp = buildDepsOutput('json', { ...ctx, comparison: null }).text;
    assert.ok(!('comparison' in JSON.parse(noCmp)));
});
