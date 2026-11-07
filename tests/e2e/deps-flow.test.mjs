process.env.DOM_STUB_PAGE = 'deps.html';
const { el, wait, fire } = await import('./helpers/dom-stub.mjs');
const test = (await import('node:test')).default;
const assert = (await import('node:assert/strict')).default;

// Fake GitHub repo with two manifests (one in an examples folder) and a fake deps.dev.
const files = {
    'package.json': JSON.stringify({ name: 'demo', dependencies: { express: '4.18.2' }, devDependencies: { jest: '29.7.0' } }),
    'requirements.txt': 'PyQt5==5.15.10\n',
    'examples/x/package.json': JSON.stringify({ dependencies: { leftpad: '1.0.0' } })
};
// The head of pull request #7 adds newlib and drops PyQt5.
const HEAD_SHA = 'abcdef1234567890abcdef1234567890abcdef12';
const headFiles = { ...files, 'package.json': JSON.stringify({ name: 'demo', dependencies: { express: '4.18.2', newlib: '1.0.0' }, devDependencies: { jest: '29.7.0' } }), 'requirements.txt': '' };
const filesFor = ref => (ref === HEAD_SHA ? headFiles : files);
const licenses = { 'npm/newlib/1.0.0': ['MIT'], 'npm/express/4.18.2': ['MIT'], 'npm/gpl-lib/2.0.0': ['GPL-3.0-only'], 'pypi/pyqt5/5.15.10': ['GPL-3.0'], 'npm/jest/29.7.0': ['MIT'] };
const calls = [];
globalThis.fetch = async (url) => {
    calls.push(String(url));
    const u = new URL(url);
    const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });
    if (u.hostname === 'raw.githubusercontent.com') {
        const parts = u.pathname.split('/');
        const f = filesFor(decodeURIComponent(parts[3]));
        const path = decodeURIComponent(parts.slice(4).join('/'));
        return f[path] !== undefined ? new Response(f[path], { status: 200 }) : new Response('404', { status: 404 });
    }
    if (u.hostname === 'api.deps.dev') {
        const p = decodeURIComponent(u.pathname.replace('/v3/systems/', ''));
        let m = /^(\w+)\/packages\/(.+)\/versions\/([^:]+):dependencies$/.exec(p);
        if (m) return m[2] === 'express' ? json({ nodes: [{ versionKey: { name: 'express', version: '4.18.2' }, relation: 'SELF' }, { versionKey: { name: 'gpl-lib', version: '2.0.0' }, relation: 'DIRECT' }] }) : json({}, 404);
        m = /^(\w+)\/packages\/(.+)\/versions\/(.+)$/.exec(p);
        if (m) { const l = licenses[`${m[1]}/${m[2]}/${m[3]}`]; return l ? json({ licenses: l, advisoryKeys: m[2] === 'express' ? [{ id: 'GHSA-x' }] : m[2] === 'newlib' ? [{ id: 'GHSA-n' }] : [] }) : json({}, 404); }
        return json({}, 404);
    }
    if (u.pathname === '/repos/o/r') return json({ default_branch: 'main', private: false, license: { spdx_id: 'Apache-2.0', name: 'Apache' } });
    if (u.pathname === '/repos/o/r/pulls/7') return json({ number: 7, title: 'Add newlib', base: { ref: 'main' }, head: { sha: HEAD_SHA, ref: 'feat', label: 'o:feat', repo: { name: 'r', full_name: 'o/r', owner: { login: 'o' } } } });
    if (u.pathname.startsWith('/repos/o/r/git/trees/')) {
        const ref = decodeURIComponent(u.pathname.split('/').pop());
        return json({ tree: Object.keys(filesFor(ref)).map(path => ({ path, type: 'blob' })) });
    }
    return json({ message: 'Not Found' }, 404);
};

const app = await import('../../js/deps-app.js');
const out = () => el('previewArea').value || '';
// Summary lines hold text and buttons; the stub DOM doesn't join child text like a browser does.
const nodeText = n => (n.children && n.children.length ? n.children.map(nodeText).join('') : n.textContent || '');
const summaryText = () => el('summaryCard').children.map(nodeText).join('\n');

test('loads a GitHub repo, reads manifests (skipping examples) and checks licenses', async () => {
    el('repoUrl').value = 'o/r';
    await el('loadDepsBtn').click();
    await wait(150);
    assert.equal(el('statPackages').textContent, '3', 'express, gpl-lib (transitive) and pyqt5; jest is dev');
    assert.equal(el('repoLicenseText').textContent, 'Apache-2.0');
    assert.ok(!calls.some(c => c.includes('examples/')), 'example folders are skipped');
    assert.match(out(), /<repository_license>Apache-2\.0 \(Permissive\)<\/repository_license>/);
    assert.match(out(), /name="gpl-lib"[^>]*relation="transitive"[^>]*via="express"/);
    assert.match(out(), /name="pyqt5"[^>]*license="GPL-3\.0"/);
    assert.equal(el('copyBtn').disabled, false);
    assert.equal(el('copyBtn').textContent, 'Copy for Claude');
});

test('filters narrow the packed output', async () => {
    el('ecosystemFilter').value = 'pypi';
    await fire('ecosystemFilter', 'change');
    await wait(50);
    assert.match(out(), /<package_count>1<\/package_count>/);
    assert.match(el('outputScopeNote').textContent, /the 1 package shown \(filters are on\)/);
    el('ecosystemFilter').value = '';
    await fire('ecosystemFilter', 'change');
    await wait(50);
});

test('including dev dependencies re-runs the lookup', async () => {
    el('includeDev').checked = true;
    await fire('includeDev', 'change');
    await wait(150);
    assert.equal(el('statPackages').textContent, '4');
    assert.match(out(), /^npm:jest@29\.7\.0 \(MIT\) \[dev\]$/m, 'permissive packages are listed briefly, dev marked');
});

test('target bar switches the format', async () => {
    await fire('targetBar', 'click', { target: { closest: () => ({ dataset: { target: 'chatgpt' } }) } });
    await wait(50);
    assert.match(out(), /^# Dependency License Report: o\/r$/m);
    assert.equal(el('copyBtn').textContent, 'Copy for ChatGPT');
    assert.ok(typeof app.applyTarget === 'function');
});

test('a repository policy file is used and blocks a package', async () => {
    files['.gitdoco-policy.json'] = JSON.stringify({ groups: { 'strong-copyleft': 'block' } });
    await el('loadDepsBtn').click();
    await wait(150);
    // The earlier target-bar test switched the format to Markdown.
    assert.match(out(), /^- \*\*Policy:\*\* Policy from the repository's \.gitdoco-policy\.json\. block: restricted, strong copyleft;/m);
    assert.match(out(), /^\| Blocked \| pyqt5@5\.15\.10 \|/m);
    assert.doesNotMatch(out(), /\*\*Manifests:\*\*[^\n]*gitdoco-policy/, 'the policy file is not listed as a manifest');
    assert.match(summaryText(), /Policy: 2 blocked · 0 to review \(\.gitdoco-policy\.json\)/);
    delete files['.gitdoco-policy.json'];
});

test('manifests the tool cannot read are reported as not checked', async () => {
    files['backend/pom.xml'] = '<project/>';
    await el('loadDepsBtn').click();
    await wait(150);
    // The format is Markdown here (set by the target-bar test).
    assert.match(out(), /^> \*\*Warning:\*\* Not checked: Maven \(backend\/pom\.xml\)\. These package managers are not supported yet/m);
    assert.match(out(), /a package without advisories is not proven safe/);
    assert.ok(!calls.some(c => c.includes('backend/pom.xml')), 'the unsupported file is not downloaded');
    delete files['backend/pom.xml'];
});

test('comparing with a pull request shows what it adds and removes', async () => {
    await fire('targetBar', 'click', { target: { closest: () => ({ dataset: { target: 'claude' } }) } });
    el('compareInput').value = '#7';
    await el('loadDepsBtn').click();
    await wait(200);
    assert.ok(calls.some(c => c.includes('/repos/o/r/pulls/7')));
    assert.ok(calls.some(c => c.includes(`/o/r/${HEAD_SHA}/package.json`)), 'the head is read at the PR commit');
    assert.ok(calls.some(c => c.includes('/o/r/main/package.json')), 'the base branch is read too');
    const o = out();
    assert.match(o, /<comparison base="main \(base of #7\)" head="pull request #7 &quot;Add newlib&quot; \(o:feat, abcdef1\)" added="1" updated="0" removed="1" new_advisories="1"/);
    assert.match(o, /<added package="npm:newlib@1\.0\.0"/);
    assert.match(o, /<removed package="pypi:pyqt5@5\.15\.10"/);
    assert.match(o, /<new_advisory id="GHSA-n"[^>]*package="npm:newlib@1\.0\.0"/);
    assert.match(summaryText(), /Compared with main \(base of #7\): 1 added, 0 updated, 1 removed; 1 new advisory/);
    // Summary counts filter the list: "1 added, ..." shows only the changed packages.
    const changedBtn = el('summaryCard').children.flatMap(c => c.children || []).find(b => b.className === 'summary-filter' && /added/.test(b.textContent));
    assert.ok(changedBtn, 'the comparison count is a filter button');
    await changedBtn.click();
    await wait(50);
    assert.equal(el('attentionFilter').value, 'changed');
    el('attentionFilter').value = '';
    await fire('attentionFilter', 'change');
    await wait(50);
    el('compareInput').value = '';
});

test('a bad compare value is reported, not fetched', async () => {
    el('compareInput').value = 'https://github.com/someone/else/pull/3';
    const before = calls.length;
    await el('loadDepsBtn').click();
    await wait(100);
    assert.ok(!calls.slice(before).some(c => c.includes('/pulls/')));
    assert.match(el('repoInputError').textContent, /belongs to someone\/else/);
    el('compareInput').value = '';
});
