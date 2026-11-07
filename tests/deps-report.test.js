import test from 'node:test';
import assert from 'node:assert/strict';
import { toHtmlReport, toThirdPartyNotices, spdxIds } from '../js/deps-report.js';
import { classifyLicense } from '../js/license-classify.js';
import { diffPackages } from '../js/deps-compare.js';

const P = (name, license, over = {}) => ({
    ecosystem: 'npm', name, version: '1.0.0', versionKind: 'locked', relation: 'direct', dev: false,
    license: classifyLicense(license ? [license] : []), advisories: [], policy: { verdict: 'allow', reason: 'ok' }, status: 'ok', ...over
});

test('the HTML report summarises, lists findings and advisories, and escapes untrusted text', () => {
    const packages = [
        P('express', 'MIT', { advisories: ['GHSA-xxxx-yyyy-zzzz'], advisoryDetails: [{ id: 'GHSA-xxxx-yyyy-zzzz', severity: 'high', score: 7.5, title: 'Open <redirect>' }], latest: '5.0.0', outdated: true, upgradeClears: 1 }),
        P('gpl-lib', 'GPL-3.0-only', { relation: 'transitive', path: ['express', 'gpl-lib'], policy: { verdict: 'block', reason: 'Strong copyleft license (GPL-3.0-only)' } }),
        P('<img src=x onerror=alert(1)>', 'MIT', { version: '"><script>alert(1)</script>' })
    ];
    const html = toHtmlReport({ repoName: 'o/<r>', source: 'GitHub repository o/r', packages, includeTransitive: true, lockfiles: ['package-lock.json'], policy: { description: 'block strong copyleft' }, warnings: ['Not checked: Maven (pom.xml).'], generatedAt: '2026-11-07T10:00:00Z' });
    assert.match(html, /^<!DOCTYPE html>/);
    assert.match(html, /Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"/, 'no scripts or outside resources can run in the file');
    assert.doesNotMatch(html, /<script/i, 'untrusted names cannot inject a script');
    assert.doesNotMatch(html, /<img/i);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(html, /<title>Dependency report: o\/&lt;r&gt;<\/title>/);
    assert.match(html, /<b>1<\/b><span>blocked by policy<\/span>/);
    assert.match(html, /<b>1<\/b><span>critical or high advisories<\/span>/);
    assert.match(html, /<a href="https:\/\/github\.com\/advisories\/GHSA-xxxx-yyyy-zzzz">GHSA-xxxx-yyyy-zzzz<\/a>/);
    assert.match(html, /Open &lt;redirect&gt;/);
    assert.match(html, /latest 5\.0\.0 clears 1/);
    assert.match(html, /v-block">Blocked/);
    assert.match(html, /via express → gpl-lib/);
    assert.match(html, /Not checked: Maven \(pom\.xml\)\./);
    assert.match(html, /Generated 2026-11-07 10:00 UTC/);
    assert.match(html, /not legal advice/);
});

test('the HTML report includes a comparison, and says when there are no advisories', () => {
    const base = [P('a', 'MIT')];
    const head = [P('a', 'MIT', { version: '2.0.0' }), P('b', 'MIT')];
    const html = toHtmlReport({ repoName: 'o/r', packages: head, comparison: { base: 'main', head: 'pull request #7', diff: diffPackages(base, head) } });
    assert.match(html, /Changes: pull request #7 compared with main/);
    assert.match(html, /<b>Added:<\/b> <span class="mono">b@1\.0\.0<\/span>/);
    assert.match(html, /a 1\.0\.0 &rarr; 2\.0\.0/);
    assert.match(html, /None known to deps\.dev for these versions/);
});

test('notices group runtime packages by license, link license texts, and leave out dev packages', () => {
    const md = toThirdPartyNotices({ repoName: 'o/r', generatedAt: '2026-11-07T00:00:00Z', packages: [
        P('express', 'MIT'), P('qs', 'BSD-3-Clause'), P('debug', 'MIT', { version: '4.3.4' }),
        P('either', 'MIT OR Apache-2.0'), P('jest', 'MIT', { dev: true }), P('mystery', null), P('later', null, { status: 'not-checked' }),
        P('evil](https://x)[', 'MIT'), P('pkg_with_underscores', 'MIT'), P('odd', 'non-standard')
    ] });
    assert.match(md, /## non-standard\n\n- \[odd\]/, 'an unclassified license gets no license-text link');
    assert.match(md, /^# Third-party notices\n/);
    assert.match(md, /o\/r uses the following third-party packages \(9, runtime dependencies only\)/);
    assert.doesNotMatch(md, /jest/, 'dev-only packages are not distributed');
    assert.match(md, /## MIT\n\nLicense text: \[MIT\]\(https:\/\/spdx\.org\/licenses\/MIT\.html\)/);
    assert.match(md, /- \[express\]\(https:\/\/www\.npmjs\.com\/package\/express\/v\/1\.0\.0\) 1\.0\.0 \(npm\)/);
    assert.match(md, /## MIT OR Apache-2\.0\n\nLicense text: \[MIT\]\(.*\), \[Apache-2\.0\]\(https:\/\/spdx\.org\/licenses\/Apache-2\.0\.html\)/);
    assert.ok(md.indexOf('## MIT\n') < md.indexOf('## BSD-3-Clause'), 'largest group first');
    assert.ok(md.indexOf('## License not found') > md.indexOf('## BSD-3-Clause'), 'unknown licenses last');
    assert.match(md, /## Not checked yet\n\n- \[later\]/);
    assert.match(md, /copyright notice and full license text/);
    assert.match(md, /\[evil\\\]\\\(https:\/\/x\\\)\\\[\]\(https:\/\/www\.npmjs\.com/, 'a hostile name cannot add its own link');
    assert.match(md, /\[pkg\\_with\\_underscores\]/);
});

test('SPDX IDs are read from license expressions', () => {
    assert.deepEqual(spdxIds('MIT OR Apache-2.0'), ['MIT', 'Apache-2.0']);
    assert.deepEqual(spdxIds('(MIT AND BSD-3-Clause) OR GPL-2.0+'), ['MIT', 'BSD-3-Clause', 'GPL-2.0']);
    assert.deepEqual(spdxIds('Apache-2.0 WITH LLVM-exception'), ['Apache-2.0', 'LLVM-exception']);
    assert.deepEqual(spdxIds('LicenseRef-Proprietary'), []);
    assert.deepEqual(spdxIds(''), []);
});
