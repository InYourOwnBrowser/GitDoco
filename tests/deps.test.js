import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyLicense, parseSpdx, guessLicenseFromText } from '../js/license-classify.js';
import {
    findManifestPaths, parsePackageJson, parseRequirementsTxt, parsePyprojectToml, parseGoMod, parseCargoToml, parseRequirement
} from '../js/manifest-parsers.js';
import { collectDirectDependencies, resolveLicenses, clearDepsDevCache, DEPS_DEV_BASE } from '../js/deps-api.js';
import { buildDepsOutput, groupCounts, sortPackages } from '../js/deps-formatters.js';
import { buildTabHref } from '../js/nav.js';

const key = d => `${d.ecosystem}:${d.name}@${d.version ?? '-'}:${d.versionKind}${d.dev ? ':dev' : ''}${d.indirect ? ':indirect' : ''}`;

// ------------------------------------------------------------------ license groups

test('license groups: single IDs, aliases and unknowns', () => {
    const g = x => classifyLicense(x).group;
    assert.equal(g('MIT'), 'permissive');
    assert.equal(g('Apache-2.0'), 'permissive');
    assert.equal(g('mit'), 'permissive');
    assert.equal(g('Apache 2.0'), 'permissive');
    assert.equal(g('BSL-1.0'), 'permissive', 'Boost is permissive');
    assert.equal(g('BUSL-1.1'), 'restricted', 'Business Source is restricted');
    assert.equal(g('MPL-2.0'), 'weak-copyleft');
    assert.equal(g('LGPL-2.1+'), 'weak-copyleft');
    assert.equal(g('GPL-3.0-only'), 'strong-copyleft');
    assert.equal(g('AGPL-3.0-or-later'), 'strong-copyleft');
    assert.equal(g('EUPL-1.2'), 'strong-copyleft');
    assert.equal(g('SSPL-1.0'), 'restricted');
    assert.equal(g('CC-BY-NC-SA-4.0'), 'restricted');
    assert.equal(g('PolyForm-Noncommercial-1.0.0'), 'restricted');
    for (const x of ['', 'NOASSERTION', 'NONE', 'LicenseRef-Custom', 'Some-Made-Up-1.0', []]) assert.equal(g(x), 'unknown', JSON.stringify(x));
});

test('license groups: AND takes the strictest, OR the easiest known option, WITH linking exceptions', () => {
    const c = classifyLicense;
    assert.equal(c('MIT OR GPL-3.0-only').group, 'permissive');
    assert.equal(c('MIT AND GPL-3.0-only').group, 'strong-copyleft');
    assert.equal(c('(MIT OR GPL-3.0) AND BSD-3-Clause').group, 'permissive');
    assert.equal(c('GPL-3.0 OR NOASSERTION').group, 'strong-copyleft', 'a known option beats unknown');
    assert.equal(c(['MIT', 'ISC']).expression, 'MIT AND ISC');
    assert.equal(c(['Apache-2.0 OR MIT', 'Unicode-3.0']).expression, '(Apache-2.0 OR MIT) AND Unicode-3.0');
    const cp = c('GPL-2.0-only WITH Classpath-exception-2.0');
    assert.equal(cp.group, 'weak-copyleft');
    assert.match(cp.notes.join(' '), /Classpath-exception-2.0/);
    assert.equal(c('GPL-2.0-only WITH Some-Other-exception').group, 'strong-copyleft');
    assert.match(c('AGPL-3.0-only').notes.join(' '), /network/);
    assert.deepEqual(c('SSPL-1.0 OR MIT').notes, [], 'notes only from the chosen OR option');
    assert.equal(c('MIT OR').group, 'unknown', 'malformed expressions are unknown');
    assert.deepEqual(parseSpdx('A AND (B OR C)'), { op: 'AND', left: { id: 'A' }, right: { op: 'OR', left: { id: 'B' }, right: { id: 'C' } } });
});

test('repository license from LICENSE file text', () => {
    assert.equal(guessLicenseFromText('MIT License\n\nPermission is hereby granted, free of charge, to any person').expression, 'MIT');
    assert.equal(guessLicenseFromText('                    GNU GENERAL PUBLIC LICENSE\n                       Version 3, 29 June 2007').expression, 'GPL-3.0');
    assert.equal(guessLicenseFromText('Apache License\n                           Version 2.0, January 2004').expression, 'Apache-2.0');
    assert.equal(guessLicenseFromText('Redistribution and use in source and binary forms ... Neither the name of').expression, 'BSD-3-Clause');
    assert.equal(guessLicenseFromText('All rights reserved.'), null);
});

// ------------------------------------------------------------------ manifests

test('manifest discovery skips vendored, hidden and example folders', () => {
    const { manifests } = findManifestPaths([
        'package.json', 'packages/a/package.json', 'node_modules/x/package.json', 'examples/demo/package.json',
        '.github/x/package.json', 'server/go.mod', 'py/requirements.txt', 'py/requirements-dev.txt', 'crates/c/Cargo.toml',
        'docs/requirements.txt', 'vendor/y/go.mod', 'pyproject.toml', 'README.md'
    ]);
    assert.deepEqual(manifests.map(m => m.path), [
        'package.json', 'pyproject.toml', 'py/requirements-dev.txt', 'py/requirements.txt', 'server/go.mod', 'crates/c/Cargo.toml', 'packages/a/package.json'
    ]);
    assert.ok(findManifestPaths(['examples/demo/package.json'], { skipExamples: false }).manifests.length === 1);
    assert.equal(findManifestPaths(Array.from({ length: 70 }, (_, i) => `p${i}/package.json`), { max: 60 }).skipped, 10);
});

test('package.json: ranges, aliases, dev, and local/VCS specs skipped', () => {
    const r = parsePackageJson(JSON.stringify({
        name: 'app',
        dependencies: { express: '^4.18.2', lodash: '4.17.21', react: '>=18 <19', ws: 'workspace:*', loc: 'file:../x', gh: 'github:a/b', short: 'user/repo', alias: 'npm:left-pad@^1.3.0' },
        devDependencies: { jest: '~29.7.0' }
    }));
    assert.equal(r.name, 'app');
    assert.deepEqual(r.deps.map(key), [
        'npm:express@4.18.2:range-min', 'npm:lodash@4.17.21:exact', 'npm:react@-:latest', 'npm:left-pad@1.3.0:range-min', 'npm:jest@29.7.0:range-min:dev'
    ]);
    assert.equal(parsePackageJson('{not json').error, 'Invalid JSON');
});

test('requirements.txt and pyproject.toml (PEP 621 and Poetry)', () => {
    assert.deepEqual(parseRequirement('PyYAML[extra]==6.0.1 ; python_version>"3"'), { name: 'pyyaml', spec: '==6.0.1' });
    assert.equal(parseRequirement('-r base.txt'), null);
    assert.equal(parseRequirement('foo @ https://x/foo.whl'), null);
    const req = parseRequirementsTxt('requests==2.31.0\nDjango>=4.2,<5 # web\nzope.interface===5.4\nflask==2.*\ngit+https://x/y.git\n');
    assert.deepEqual(req.deps.map(key), ['pypi:requests@2.31.0:exact', 'pypi:django@-:latest', 'pypi:zope-interface@5.4:exact', 'pypi:flask@-:latest']);
    assert.ok(parseRequirementsTxt('pytest==8.0.0', 'requirements-dev.txt').deps[0].dev);

    const py = parsePyprojectToml([
        '[project]', 'name = "x"', 'dependencies = [', '  "httpx>=0.27",  # comment', '  "pydantic==2.7.1",', "  'rich',", ']',
        '[project.optional-dependencies]', 'test = ["pytest"]',
        '[tool.poetry.dependencies]', 'python = "^3.10"', 'fastapi = "^0.110.0"', 'sqlalchemy = { version = "2.0.29", extras = ["asyncio"] }', 'local = { path = "../local" }',
        '[tool.poetry.group.dev.dependencies]', 'black = "24.3.0"'
    ].join('\n'));
    assert.deepEqual(py.deps.map(key), [
        'pypi:httpx@-:latest', 'pypi:pydantic@2.7.1:exact', 'pypi:rich@-:latest',
        'pypi:fastapi@0.110.0:range-min', 'pypi:sqlalchemy@2.0.29:exact', 'pypi:black@24.3.0:exact:dev'
    ]);
});

test('go.mod and Cargo.toml', () => {
    const go = parseGoMod('module github.com/me/app\n\nrequire (\n\tgithub.com/spf13/cobra v1.8.0\n\tgolang.org/x/sys v0.18.0 // indirect\n)\nrequire github.com/pkg/errors v0.9.1\n');
    assert.equal(go.name, 'github.com/me/app');
    assert.deepEqual(go.deps.map(key), ['go:github.com/spf13/cobra@v1.8.0:exact', 'go:golang.org/x/sys@v0.18.0:exact:indirect', 'go:github.com/pkg/errors@v0.9.1:exact']);

    const cargo = parseCargoToml([
        '[package]', 'name = "app"',
        '[dependencies]', 'serde = { version = "1.0.200", features = ["derive"] }', 'tokio = "1"', 'pinned = "=0.3.1"',
        'local = { path = "../local" }', 'shared.workspace = true', 'renamed = { package = "rand", version = "0.8.5" }',
        '[dev-dependencies]', 'criterion = "0.5.1"',
        "[target.'cfg(unix)'.dependencies]", 'libc = "0.2.153"',
        '[dependencies.regex]', 'version = "1.10.4"', 'features = ["std"]'
    ].join('\n'));
    assert.equal(cargo.name, 'app');
    assert.deepEqual(cargo.deps.map(key), [
        'cargo:serde@1.0.200:range-min', 'cargo:tokio@-:latest', 'cargo:pinned@0.3.1:exact', 'cargo:rand@0.8.5:range-min',
        'cargo:criterion@0.5.1:range-min:dev', 'cargo:libc@0.2.153:range-min', 'cargo:regex@1.10.4:range-min'
    ]);
});

test('collectDirectDependencies merges duplicates and skips the repo\'s own packages', () => {
    const { deps } = collectDirectDependencies([
        { path: 'package.json', text: JSON.stringify({ name: 'root', dependencies: { lib: '^1.0.0', express: '4.18.2' } }) },
        { path: 'packages/lib/package.json', text: JSON.stringify({ name: 'lib', dependencies: { express: '4.18.2' }, devDependencies: { chalk: '5.3.0' } }) },
        { path: 'tools/package.json', text: JSON.stringify({ name: 'tools', dependencies: { chalk: '5.3.0' } }) }
    ]);
    assert.deepEqual(deps.map(d => [d.name, [...d.manifests].sort(), d.dev]), [
        ['express', ['package.json', 'packages/lib/package.json'], false],
        ['chalk', ['packages/lib/package.json', 'tools/package.json'], false]
    ]);
});

// ------------------------------------------------------------------ deps.dev resolution (fake)

function installFakeDepsDev() {
    const calls = [];
    const versions = {
        'npm/express/4.18.2': { licenses: ['MIT'], advisoryKeys: [{ id: 'GHSA-1' }] },
        'npm/accepts/1.3.8': { licenses: ['MIT'] },
        'npm/gpl-lib/2.0.0': { licenses: ['GPL-3.0-only'] },
        'npm/new-only/3.1.0': { licenses: ['Apache-2.0'] },
        'pypi/pyqt5/5.15.10': { licenses: ['GPL-3.0'] },
        'pypi/pyqt5-qt5/5.15.2': { licenses: ['LGPL-3.0'] },
        'go/github.com/spf13/cobra/v1.8.0': { licenses: ['Apache-2.0'] },
        'go/golang.org/x/sys/v0.18.0': { licenses: ['BSD-3-Clause'] }
    };
    const graphs = {
        'npm/express/4.18.2': ['accepts@1.3.8', 'gpl-lib@2.0.0'],
        'pypi/pyqt5/5.15.10': ['pyqt5-qt5@5.15.2']
    };
    const defaults = { 'npm/new-only': '3.1.0', 'npm/express': '4.18.2' };
    globalThis.fetch = async (url) => {
        calls.push(url);
        const path = decodeURIComponent(url.slice(DEPS_DEV_BASE.length + 1));
        const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
        let m = /^systems\/(\w+)\/packages\/(.+)\/versions\/([^/:]+):dependencies$/.exec(path);
        if (m) {
            const g = graphs[`${m[1]}/${m[2]}/${m[3]}`];
            if (!g) return json({ error: 'dependencies not found' }, 404);
            return json({ nodes: [{ versionKey: { name: m[2], version: m[3] }, relation: 'SELF' },
                ...g.map(s => { const [n, v] = s.split('@'); return { versionKey: { name: n, version: v }, relation: 'DIRECT' }; })] });
        }
        m = /^systems\/(\w+)\/packages\/(.+)\/versions\/([^/]+)$/.exec(path);
        if (m) {
            const v = versions[`${m[1]}/${m[2]}/${m[3]}`];
            return v ? json({ versionKey: { name: m[2], version: m[3] }, ...v }) : json({ error: 'version not found' }, 404);
        }
        m = /^systems\/(\w+)\/packages\/(.+)$/.exec(path);
        if (m) {
            const def = defaults[`${m[1]}/${m[2]}`];
            return def ? json({ versions: [{ versionKey: { version: '0.0.1' } }, { versionKey: { version: def }, isDefault: true }] }) : json({ error: 'not found' }, 404);
        }
        return json({ error: 'bad path' }, 404);
    };
    return calls;
}

test('resolveLicenses: direct + transitive, version fallbacks, dev excluded, Go indirect', async () => {
    clearDepsDevCache();
    const calls = installFakeDepsDev();
    const { deps } = collectDirectDependencies([
        { path: 'package.json', text: JSON.stringify({ dependencies: { express: '^4.18.2', 'new-only': '^3.0.0', ghost: '1.0.0' }, devDependencies: { jest: '29.7.0' } }) },
        { path: 'requirements.txt', text: 'PyQt5==5.15.10\n' },
        { path: 'go.mod', text: 'module m\nrequire (\n github.com/spf13/cobra v1.8.0\n golang.org/x/sys v0.18.0 // indirect\n)\n' }
    ]);
    let lastProgress = null;
    const { packages, capped } = await resolveLicenses(deps, { onProgress: (d, t) => { lastProgress = [d, t]; } });
    assert.equal(capped, false);
    assert.equal(lastProgress[0], lastProgress[1], 'progress reaches 100%');
    const by = Object.fromEntries(packages.map(p => [p.name, p]));
    assert.ok(!by.jest, 'dev dependency excluded by default');
    assert.deepEqual([by.express.relation, by.express.license.group, by.express.advisories], ['direct', 'permissive', ['GHSA-1']]);
    assert.deepEqual([by['gpl-lib'].relation, by['gpl-lib'].license.group, by['gpl-lib'].via], ['transitive', 'strong-copyleft', ['express']]);
    assert.deepEqual([by['new-only'].version, by['new-only'].versionKind], ['3.1.0', 'latest'], 'range minimum missing -> latest');
    assert.equal(by.ghost.status, 'not-found');
    assert.equal(by.ghost.license.group, 'unknown');
    assert.deepEqual([by['pyqt5-qt5'].license.group, by['pyqt5-qt5'].via], ['weak-copyleft', ['pyqt5']]);
    assert.equal(by['golang.org/x/sys'].relation, 'transitive', 'go.mod // indirect counts as transitive');
    assert.ok(!calls.some(u => u.includes('cobra') && u.includes(':dependencies')), 'no graph requests for Go');

    const before = calls.length;
    const again = await resolveLicenses(deps, { includeTransitive: false });
    assert.equal(calls.length, before, 'results are cached');
    assert.ok(!again.packages.some(p => p.name === 'accepts'));
});

test('resolveLicenses: includeDev and the package cap', async () => {
    clearDepsDevCache();
    installFakeDepsDev();
    const { deps } = collectDirectDependencies([{ path: 'package.json', text: JSON.stringify({ dependencies: { express: '4.18.2' }, devDependencies: { 'gpl-lib': '2.0.0' } }) }]);
    const withDev = await resolveLicenses(deps, { includeDev: true, includeTransitive: false });
    assert.equal(withDev.packages.find(p => p.name === 'gpl-lib').dev, true);
    const capped = await resolveLicenses(deps, { maxPackages: 2 });
    assert.equal(capped.capped, true);
    assert.equal(capped.packages.length, 2);
});

// ------------------------------------------------------------------ formatters

const pkg = (name, license, extra = {}) => ({
    ecosystem: 'npm', name, version: '1.0.0', versionKind: 'exact', relation: 'direct', dev: false, via: [], manifests: ['package.json'],
    license: classifyLicense(license), advisories: [], status: 'ok', ...extra
});
const ctx = {
    repoName: 'o/r', source: 'GitHub repository o/r', repoLicense: classifyLicense('MIT'),
    manifests: ['package.json'], includeTransitive: true, includeDev: false, compactPermissive: true,
    instructions: 'Review these.',
    packages: [
        pkg('a-mit', 'MIT'), pkg('z-gpl', 'GPL-3.0-only', { advisories: ['GHSA-9'] }),
        pkg('m-mpl', 'MPL-2.0', { relation: 'transitive', via: ['a-mit'], versionKind: 'range-min' }),
        pkg('busl', 'BUSL-1.1'), pkg('nolic', '', { status: 'not-found' })
    ]
};

test('deps report: sorted by group and the four formats', () => {
    assert.deepEqual(sortPackages(ctx.packages).map(p => p.name), ['busl', 'z-gpl', 'm-mpl', 'nolic', 'a-mit']);
    assert.deepEqual(groupCounts(ctx.packages), { 'restricted': 1, 'strong-copyleft': 1, 'weak-copyleft': 1, 'unknown': 1, 'permissive': 1 });

    const xml = buildDepsOutput('claude-xml', ctx).text;
    assert.match(xml, /<repository_license>MIT \(Permissive\)<\/repository_license>/);
    assert.match(xml, /<summary>Restricted: 1, Strong copyleft: 1, Weak copyleft: 1, Unknown: 1, Permissive: 1<\/summary>/);
    assert.match(xml, /not legal advice/);
    assert.ok(xml.indexOf('name="busl"') < xml.indexOf('name="z-gpl"'), 'restricted listed first');
    assert.match(xml, /name="z-gpl"[^>]*advisories="GHSA-9 \(unrated\)"/);
    assert.match(xml, /name="m-mpl"[^>]*relation="transitive" license="MPL-2.0" via="a-mit"[^>]*notes="version: lowest version in range"/);
    assert.match(xml, /name="nolic"[^>]*license="none found"[^>]*notes="not found on deps.dev"/);
    assert.match(xml, /npm:a-mit@1\.0\.0 \(MIT\)/, 'permissive listed briefly');
    assert.match(xml, /<instructions>\n<!\[CDATA\[\nReview these\.\n\]\]>/);

    const md = buildDepsOutput('markdown', { ...ctx, compactPermissive: false }).text;
    assert.match(md, /^# Dependency License Report: o\/r$/m);
    assert.match(md, /^## Strong copyleft \(1\)$/m);
    assert.match(md, /^\| z-gpl \| 1\.0\.0 \| npm \| direct \| GPL-3\.0-only \|  \| GHSA-9 \(unrated\) \|/m);
    assert.match(md, /^\| a-mit \| 1\.0\.0 \| npm \| direct \| MIT \|/m, 'permissive in a full table when not compact');

    const gx = buildDepsOutput('generic-xml', ctx).text;
    assert.match(gx, /^<dependency_report repository="o\/r" repository_license="MIT \(Permissive\)" count="5">/);
    assert.match(gx, /<group name="restricted" count="1">/);

    const json = JSON.parse(buildDepsOutput('json', ctx).text);
    assert.equal(json.repository_license.expression, 'MIT');
    assert.equal(json.summary['strong-copyleft'], 1);
    assert.deepEqual(json.packages.map(p => p.name), ['busl', 'z-gpl', 'm-mpl', 'nolic', 'a-mit']);
    assert.equal(json.packages[1].license_group, 'strong-copyleft');
    assert.equal(json.instructions, 'Review these.');
});

test('nav knows the Dependencies tab', () => {
    assert.equal(buildTabHref('deps', 'o/r'), 'deps.html?repo=o%2Fr');
    assert.equal(buildTabHref('deps', ''), 'deps.html');
});

test('manifests of unsupported ecosystems are found so the report can say it is incomplete', async () => {
    const { findManifestPaths, unsupportedText } = await import('../js/manifest-parsers.js');
    const r = findManifestPaths([
        'package.json', 'pom.xml', 'api/Gemfile', 'web/Gemfile', 'src/App.csproj', 'composer.json',
        'node_modules/x/pom.xml', 'examples/demo/pom.xml',
        'setup.py', 'tools/setup.py', 'tools/x.py', 'lib/setup.cfg', 'lib/pyproject.toml'
    ]);
    assert.deepEqual(r.manifests.map(m => m.path), ['package.json', 'lib/pyproject.toml']);
    assert.deepEqual(r.unsupported.map(u => `${u.ecosystem}:${u.path}`), [
        'Composer (PHP):composer.json', 'Maven:pom.xml', 'Python setup.py / setup.cfg:setup.py',
        'RubyGems:api/Gemfile', 'NuGet (.NET):src/App.csproj', 'Python setup.py / setup.cfg:tools/setup.py', 'RubyGems:web/Gemfile'
    ], 'skipped folders are ignored, and setup.cfg next to a pyproject.toml is not reported');
    const text = unsupportedText(r.unsupported);
    assert.match(text, /^Not checked: Composer \(PHP\) \(composer\.json\), Maven \(pom\.xml\), .* and NuGet \(\.NET\) \(src\/App\.csproj\)\./);
    assert.match(text, /RubyGems \(api\/Gemfile, web\/Gemfile\)/);
    assert.match(text, /not supported yet, so this report does not cover their dependencies\.$/);
    assert.equal(unsupportedText([]), '');
    const many = unsupportedText(['a', 'b', 'c', 'd', 'e'].map(d => ({ path: `${d}/pom.xml`, ecosystem: 'Maven' })));
    assert.match(many, /Maven \(a\/pom\.xml, b\/pom\.xml, c\/pom\.xml, \+2 more\)/);
});

test('the versions line says when only some packages come from a lockfile', async () => {
    const { lockText } = await import('../js/deps-formatters.js');
    assert.equal(lockText({ lockfiles: [] }), 'No lockfile found: versions estimated from manifest ranges');
    assert.equal(lockText({ lockfiles: ['Cargo.lock'], packages: [{ versionKind: 'locked' }] }), 'Exact versions from lockfiles: Cargo.lock');
    assert.equal(lockText({ lockfiles: ['Cargo.lock'], packages: [{ versionKind: 'locked' }, { versionKind: 'range-min' }] }),
        'Exact versions from lockfiles: Cargo.lock; packages not in a lockfile have estimated versions');
});

test('packages past the lookup limit are listed as not checked, most important first, and can be checked later', async () => {
    clearDepsDevCache();
    installFakeDepsDev();
    const { deps } = collectDirectDependencies([{ path: 'package.json', text: JSON.stringify({ dependencies: { express: '4.18.2' }, devDependencies: { 'gpl-lib': '2.0.0' } }) }]);
    const first = await resolveLicenses(deps, { includeDev: true, maxLookups: 1 });
    assert.ok(first.packages.length >= 2, 'nothing is dropped from the list');
    assert.equal(first.unchecked, first.packages.length - 1);
    assert.equal(first.capped, true);
    const checked = first.packages.filter(p => p.status !== 'not-checked');
    assert.deepEqual(checked.map(p => p.name), ['express'], 'a direct runtime dependency is checked first');
    const rest = first.packages.find(p => p.status === 'not-checked');
    assert.equal(rest.license.group, 'unknown');
    const { evaluatePolicy } = await import('../js/license-policy.js');
    assert.deepEqual(evaluatePolicy(rest, {}), { verdict: 'review', reason: 'license not checked yet (deps.dev lookup limit)' });
    const all = await resolveLicenses(deps, { includeDev: true, maxLookups: Infinity });
    assert.equal(all.unchecked, 0);
    assert.ok(all.packages.every(p => p.status !== 'not-checked'));
});
