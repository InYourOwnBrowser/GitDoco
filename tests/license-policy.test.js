import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePolicy, normalizePolicy, parsePolicyFile, policyToFile, describePolicy, DEFAULT_POLICY, POLICY_FILE } from '../js/license-policy.js';
import { classifyLicense } from '../js/license-classify.js';
import { buildDepsOutput, policyFindings } from '../js/deps-formatters.js';
import { findManifestPaths } from '../js/manifest-parsers.js';
import { collectDirectDependencies } from '../js/deps-api.js';

const pkg = (name, license, extra = {}) => ({ ecosystem: 'npm', name, version: '1.0.0', relation: 'direct', license: classifyLicense(license), ...extra });
const v = (p, policy) => evaluatePolicy(p, policy).verdict;

test('default policy: permissive allowed, copyleft and unknown reviewed, restricted blocked', () => {
    assert.equal(v(pkg('a', 'MIT'), DEFAULT_POLICY), 'allow');
    assert.equal(v(pkg('b', 'LGPL-2.1'), DEFAULT_POLICY), 'review');
    assert.equal(v(pkg('c', 'GPL-3.0-only'), DEFAULT_POLICY), 'review');
    assert.equal(v(pkg('d', 'SSPL-1.0'), DEFAULT_POLICY), 'block');
    assert.equal(v(pkg('e', ''), DEFAULT_POLICY), 'review');
    assert.equal(evaluatePolicy(pkg('e', ''), DEFAULT_POLICY).reason, 'no license data');
});

test('lists, approved packages and SPDX expressions', () => {
    const policy = normalizePolicy({
        groups: { 'strong-copyleft': 'block' },
        blockLicenses: 'AGPL-3.0, BUSL-1.1',
        allowLicenses: ['MPL-2.0'],
        allowPackages: ['npm:legacy-gpl', 'shared-tool']
    });
    assert.equal(v(pkg('a', 'GPL-2.0-or-later'), policy), 'block', 'group action');
    assert.deepEqual(evaluatePolicy(pkg('b', 'AGPL-3.0-or-later'), policy), { verdict: 'block', reason: 'AGPL-3.0-or-later is on the blocked list' }, '"AGPL-3.0" matches -only/-or-later');
    assert.equal(v(pkg('c', 'MPL-2.0'), policy), 'allow', 'allowed list beats the group');
    assert.equal(v(pkg('d', 'MIT OR GPL-3.0'), policy), 'allow', 'OR: the easier option');
    assert.equal(v(pkg('e', 'MIT AND GPL-3.0'), policy), 'block', 'AND: the stricter part');
    assert.equal(v(pkg('legacy-gpl', 'GPL-2.0'), policy), 'allow', 'approved by ecosystem:name');
    assert.equal(v({ ...pkg('shared-tool', 'GPL-2.0'), ecosystem: 'pypi' }, policy), 'allow', 'approved by name');
    assert.equal(v(pkg('legacy-gpl', 'GPL-2.0', { ecosystem: 'cargo' }), policy), 'block', 'ecosystem must match when given');
    const exactOnly = normalizePolicy({ blockLicenses: ['GPL-3.0-only'] });
    assert.equal(v(pkg('f', 'GPL-3.0-or-later'), exactOnly), 'review', 'an entry with -only matches only -only');
});

test('policy files: validation, errors and round trip', () => {
    const p = normalizePolicy({ groups: { permissive: 'BLOCK', unknown: 'nonsense' }, blockLicenses: 42, extra: true });
    assert.equal(p.groups.permissive, 'block');
    assert.equal(p.groups.unknown, 'review', 'invalid action falls back to the default');
    assert.deepEqual(p.blockLicenses, []);
    assert.equal('extra' in p, false);
    assert.throws(() => parsePolicyFile('{ nope'), /\.gitdoco-policy\.json is not valid JSON/);
    const text = policyToFile({ groups: { 'weak-copyleft': 'allow' }, allowPackages: ['x'] });
    assert.match(text, /"\$comment": "GitDoco license policy/);
    assert.deepEqual(parsePolicyFile(text), normalizePolicy({ groups: { 'weak-copyleft': 'allow' }, allowPackages: ['x'] }));
    assert.equal(describePolicy(DEFAULT_POLICY, 'Policy from GitDoco settings'),
        'Policy from GitDoco settings. block: restricted; review: strong copyleft, weak copyleft, unknown; allow: permissive');
});

test('the policy file is found at the repository root and is not treated as a manifest', () => {
    const { manifests } = findManifestPaths([POLICY_FILE, 'sub/.gitdoco-policy.json', 'package.json']);
    assert.deepEqual(manifests.map(m => `${m.path}:${m.kind}`).sort(), ['.gitdoco-policy.json:policy', 'package.json:manifest']);
    const { deps, parseErrors } = collectDirectDependencies([{ path: POLICY_FILE, text: '{"groups":{}}' }, { path: 'package.json', text: '{"dependencies":{"a":"1.0.0"}}' }]);
    assert.deepEqual(deps.map(d => d.name), ['a']);
    assert.deepEqual(parseErrors, []);
});

test('reports: policy line, per-package policy and a policy results section', () => {
    const policy = normalizePolicy({ blockLicenses: ['GPL-3.0'] });
    const packages = [pkg('ok', 'MIT'), pkg('gpl', 'GPL-3.0-only', { relation: 'transitive', path: ['web', 'gpl'] }), pkg('lgpl', 'LGPL-2.1')];
    for (const p of packages) p.policy = evaluatePolicy(p, policy);
    assert.deepEqual(policyFindings(packages).map(p => `${p.name}:${p.policy.verdict}`), ['gpl:block', 'lgpl:review']);
    const ctx = { repoName: 'o/r', packages, compactPermissive: true, policy: { description: describePolicy(policy, 'Policy from GitDoco settings') } };
    const xml = buildDepsOutput('claude-xml', ctx).text;
    assert.match(xml, /<policy>Policy from GitDoco settings\. block: restricted;/);
    assert.match(xml, /<policy_result verdict="block" package="npm:gpl@1\.0\.0" license="GPL-3\.0-only" relation="transitive" path="web → gpl">GPL-3\.0-only is on the blocked list<\/policy_result>/);
    assert.match(xml, /name="lgpl"[^>]*policy="review: Weak copyleft license \(LGPL-2\.1\)"/);
    const md = buildDepsOutput('markdown', ctx).text;
    assert.match(md, /^## Policy results \(2\)$/m);
    assert.match(md, /^\| Blocked \| gpl@1\.0\.0 \| GPL-3\.0-only \| transitive \(web → gpl\) \| GPL-3\.0-only is on the blocked list \|$/m);
    const json = JSON.parse(buildDepsOutput('json', ctx).text);
    assert.match(json.policy, /^Policy from GitDoco settings/);
    assert.deepEqual(json.packages.find(p => p.name === 'gpl').policy, { verdict: 'block', reason: 'GPL-3.0-only is on the blocked list' });
});
