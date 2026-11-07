import test from 'node:test';
import assert from 'node:assert/strict';
import {
    parsePackageLock, parseYarnLock, parsePnpmLock, parsePoetryLock, parseUvLock, parseCargoLock,
    parsePipfileLock, parseLockfile, compareVersions
} from '../js/lockfiles.js';
import { findManifestPaths, parsePipfile } from '../js/manifest-parsers.js';
import { collectDirectDependencies, resolveLicenses, clearDepsDevCache, severityOf, graphPaths, DEPS_DEV_BASE } from '../js/deps-api.js';
import { buildDepsOutput, collectAdvisories } from '../js/deps-formatters.js';
import { classifyLicense } from '../js/license-classify.js';

const deps = (g, id) => [...g.nodes.get(id).deps].sort();
const registryKeys = g => [...g.nodes].filter(([, n]) => !n.local).map(([k]) => k).sort();
const localKeys = g => [...g.nodes].filter(([, n]) => n.local).map(([k]) => k).sort();

test('compareVersions orders numerically, releases after pre-releases', () => {
    assert.ok(compareVersions('1.10.0', '1.9.3') > 0);
    assert.ok(compareVersions('v2.0.0', '1.99.9') > 0);
    assert.ok(compareVersions('1.0.0-beta.1', '1.0.0') < 0);
    assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
});

test('package-lock v3: nested node_modules, dev flags, workspace links skipped', () => {
    const g = parsePackageLock(JSON.stringify({
        lockfileVersion: 3,
        packages: {
            '': { name: 'app', dependencies: { a: '^1.0.0' } },
            'node_modules/a': { version: '1.2.0', dependencies: { b: '^2.0.0', c: '*' } },
            'node_modules/b': { version: '1.0.0' },
            'node_modules/a/node_modules/b': { version: '2.1.0' },
            'node_modules/c': { version: '3.0.0', dev: true },
            'node_modules/my-ws': { resolved: 'packages/my-ws', link: true },
            'packages/my-ws': { name: 'my-ws', version: '0.0.1', dependencies: { b: '^1.0.0' } }
        }
    }));
    assert.deepEqual(registryKeys(g), ['a@1.2.0', 'b@1.0.0', 'b@2.1.0', 'c@3.0.0']);
    assert.deepEqual(deps(g, 'a@1.2.0'), ['b@2.1.0', 'c@3.0.0'], 'nested b wins for a');
    assert.equal(g.resolveDirect('b', '^1.0.0', ''), 'b@1.0.0', 'top-level b for the root');
    assert.equal(g.nodes.get('c@3.0.0').dev, true);
    assert.deepEqual(localKeys(g), ['local:my-ws@0.0.1'], 'workspace folder kept as a local node');
    assert.deepEqual(deps(g, 'local:my-ws@0.0.1'), ['b@1.0.0'], 'its dependencies are followed');
    assert.equal(g.resolveDirect('my-ws', '', ''), 'local:my-ws@0.0.1', 'the link resolves to the workspace');
});

test('package-lock v1 (nested dependencies/requires)', () => {
    const g = parsePackageLock(JSON.stringify({
        lockfileVersion: 1,
        dependencies: { a: { version: '1.0.0', requires: { b: '^1' }, dependencies: { b: { version: '1.5.0' } } }, b: { version: '9.0.0', dev: true } }
    }));
    assert.deepEqual(deps(g, 'a@1.0.0'), ['b@1.5.0']);
    assert.equal(g.resolveDirect('b', '', ''), 'b@9.0.0');
});

test('yarn.lock classic and Berry', () => {
    const classic = parseYarnLock(`# yarn lockfile v1


"@scope/x@^1.0.0", "@scope/x@^1.1.0":
  version "1.2.0"
  dependencies:
    lru-cache "^10.0.0"

lru-cache@^10.0.0:
  version "10.4.3"
`);
    assert.deepEqual(registryKeys(classic), ['@scope/x@1.2.0', 'lru-cache@10.4.3']);
    assert.deepEqual(deps(classic, '@scope/x@1.2.0'), ['lru-cache@10.4.3']);
    assert.equal(classic.resolveDirect('@scope/x', '^1.1.0'), '@scope/x@1.2.0');

    const berry = parseYarnLock(`__metadata:
  version: 10

"@scope/x@npm:^1.0.0, @scope/x@npm:^1.1.0":
  version: 1.2.0
  resolution: "@scope/x@npm:1.2.0"
  dependencies:
    lru-cache: "npm:^10.0.0"
  peerDependencies:
    react: ">= 18"
  languageName: node

"lru-cache@npm:^10.0.0":
  version: 10.4.3
  resolution: "lru-cache@npm:10.4.3"

"my-ws@workspace:packages/my-ws":
  version: 0.0.0-use.local
  resolution: "my-ws@workspace:packages/my-ws"
`);
    assert.deepEqual(registryKeys(berry), ['@scope/x@1.2.0', 'lru-cache@10.4.3'], 'workspace skipped');
    assert.deepEqual(deps(berry, '@scope/x@1.2.0'), ['lru-cache@10.4.3'], 'peer dependencies are not edges');
    assert.equal(berry.resolveDirect('@scope/x', '^1.0.0'), '@scope/x@1.2.0');
});

test('pnpm-lock v9: snapshots, peer suffixes, aliases, importers, multiple documents', () => {
    const g = parsePnpmLock(`---
lockfileVersion: '9.0'

importers:

  .:
    configDependencies: {}
---
lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      '@babel/core':
        specifier: ^7.0.0
        version: 7.29.7(ms@2.1.3)
  packages/web:
    dependencies:
      debug:
        specifier: npm:obug@^1
        version: obug@1.0.2(ms@2.1.3)
      local:
        specifier: workspace:*
        version: link:../local

packages:

  '@babel/core@7.29.7':
    resolution: {integrity: sha512-x}

  obug@1.0.2:
    resolution: {integrity: sha512-y}

  ms@2.1.3:
    resolution: {integrity: sha512-z}

snapshots:

  '@babel/core@7.29.7(ms@2.1.3)':
    dependencies:
      debug: obug@1.0.2(ms@2.1.3)
    transitivePeerDependencies:
      - ms

  obug@1.0.2(ms@2.1.3):
    dependencies:
      ms: 2.1.3

  ms@2.1.3: {}
`);
    assert.deepEqual(registryKeys(g), ['@babel/core@7.29.7', 'ms@2.1.3', 'obug@1.0.2']);
    assert.deepEqual(deps(g, '@babel/core@7.29.7'), ['obug@1.0.2'], 'alias debug -> obug');
    assert.deepEqual(deps(g, 'obug@1.0.2'), ['ms@2.1.3']);
    assert.equal(g.resolveDirect('@babel/core', '^7.0.0', ''), '@babel/core@7.29.7');
    assert.equal(g.resolveDirect('debug', 'npm:obug@^1', 'packages/web'), 'obug@1.0.2');
    assert.equal(g.resolveDirect('local', 'workspace:*', 'packages/web'), null);
});

test('pnpm-lock v6 and v5 keys', () => {
    const v6 = parsePnpmLock(`lockfileVersion: '6.0'

dependencies:
  a:
    specifier: ^1.0.0
    version: 1.0.0

packages:

  /a@1.0.0:
    resolution: {integrity: x}
    dependencies:
      b: 2.0.0
    dev: false

  /b@2.0.0:
    resolution: {integrity: y}
    dev: true
`);
    assert.deepEqual(deps(v6, 'a@1.0.0'), ['b@2.0.0']);
    assert.equal(v6.resolveDirect('a', '^1.0.0', ''), 'a@1.0.0');
    assert.equal(v6.nodes.get('b@2.0.0').dev, true);
    const v5 = parsePnpmLock(`lockfileVersion: 5.4

packages:

  /@scope/a/1.0.0_react@18.0.0:
    dependencies:
      b: 2.0.0

  /b/2.0.0:
    dev: false
`);
    assert.deepEqual(deps(v5, '@scope/a@1.0.0'), ['b@2.0.0']);
});

test('poetry.lock (groups and legacy category), uv.lock, Cargo.lock, Pipfile.lock', () => {
    const poetry = parsePoetryLock(`[[package]]
name = "Requests"
version = "2.31.0"
groups = ["main"]

[package.dependencies]
charset_normalizer = ">=2,<4"

[[package]]
name = "charset-normalizer"
version = "3.3.2"
category = "main"

[[package]]
name = "pytest"
version = "8.0.0"
groups = ["dev"]

[[package]]
name = "local-lib"
version = "0.1.0"
groups = ["main"]

[package.source]
type = "directory"
url = "../local-lib"

[metadata]
lock-version = "2.1"
`);
    assert.deepEqual(registryKeys(poetry), ['charset-normalizer@3.3.2', 'pytest@8.0.0', 'requests@2.31.0']);
    assert.deepEqual(deps(poetry, 'requests@2.31.0'), ['charset-normalizer@3.3.2'], 'names are normalised');
    assert.equal(poetry.nodes.get('pytest@8.0.0').dev, true);

    const uv = parseUvLock(`version = 1

[[package]]
name = "aiohttp"
version = "3.14.5"
source = { registry = "https://pypi.org/simple" }
dependencies = [
    { name = "yarl" },
    { name = "async-timeout", marker = "python_full_version < '3.11'" },
]

[[package]]
name = "yarl"
version = "1.9.0"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "myproject"
version = "0.1.0"
source = { editable = "." }
dependencies = [{ name = "aiohttp" }]
`);
    assert.deepEqual(registryKeys(uv), ['aiohttp@3.14.5', 'yarl@1.9.0'], 'editable project skipped');
    assert.deepEqual(deps(uv, 'aiohttp@3.14.5'), ['yarl@1.9.0'], 'missing marker-only deps ignored');

    const cargo = parseCargoLock(`version = 4

[[package]]
name = "app"
version = "0.1.0"
dependencies = [
 "regex",
 "syn 2.0.1",
]

[[package]]
name = "regex"
version = "1.13.1"
source = "registry+https://github.com/rust-lang/crates.io-index"
dependencies = [
 "syn 1.0.109",
]

[[package]]
name = "syn"
version = "1.0.109"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "syn"
version = "2.0.1"
source = "registry+https://github.com/rust-lang/crates.io-index"
`);
    assert.deepEqual(registryKeys(cargo), ['regex@1.13.1', 'syn@1.0.109', 'syn@2.0.1'], 'workspace crate skipped');
    assert.deepEqual(deps(cargo, 'regex@1.13.1'), ['syn@1.0.109'], 'version-qualified edges');
    assert.equal(cargo.resolveDirect('syn', '2.0'), 'syn@2.0.1', 'highest when ambiguous');
    assert.deepEqual(deps(cargo, 'local:app@0.1.0'), ['regex@1.13.1', 'syn@2.0.1'], 'workspace crate passes its dependencies through');

    const pip = parsePipfileLock(JSON.stringify({ default: { Flask: { version: '==3.0.0' }, werkzeug: { version: '==3.0.1' } }, develop: { pytest: { version: '==8.0.0' } } }));
    assert.equal(pip.flat, true);
    assert.deepEqual(registryKeys(pip), ['flask@3.0.0', 'pytest@8.0.0', 'werkzeug@3.0.1']);
    assert.equal(pip.nodes.get('pytest@8.0.0').dev, true);
    assert.equal(parseLockfile('x/unknown.lock', ''), null);
});

test('lockfiles and Pipfile are discovered; Pipfile parsed', () => {
    const { manifests } = findManifestPaths(['package.json', 'package-lock.json', 'web/pnpm-lock.yaml', 'Pipfile', 'Pipfile.lock', 'Cargo.lock', 'uv.lock', 'node_modules/x/package-lock.json']);
    assert.deepEqual(manifests.map(m => `${m.path}:${m.kind}`).sort(), ['Cargo.lock:lock', 'Pipfile.lock:lock', 'Pipfile:manifest', 'package-lock.json:lock', 'package.json:manifest', 'uv.lock:lock', 'web/pnpm-lock.yaml:lock']);
    const p = parsePipfile('[packages]\nflask = "*"\nrequests = "==2.31.0"\nlocal = {path = "."}\n\n[dev-packages]\npytest = "*"\n');
    assert.deepEqual(p.deps.map(d => `${d.name}:${d.version || '-'}:${d.dev}`), ['flask:-:false', 'requests:2.31.0:false', 'pytest:-:true']);
});

// ------------------------------------------------------------------ end to end with a fake deps.dev

function fakeDepsDev() {
    const calls = [];
    const versions = {
        'npm/express/4.21.2': { licenses: ['MIT'], advisoryKeys: [{ id: 'GHSA-high' }, { id: 'GHSA-low' }], relatedProjects: [{ relationType: 'SOURCE_REPO', projectKey: { id: 'github.com/expressjs/express' } }] },
        'npm/express/5.1.0': { licenses: ['MIT'], advisoryKeys: [{ id: 'GHSA-low' }] },
        'npm/qs/6.13.0': { licenses: ['BSD-3-Clause'], advisoryKeys: [{ id: 'GHSA-crit' }] },
        'npm/old-lib/1.0.0': { licenses: ['GPL-3.0-only'], isDeprecated: true, relatedProjects: [{ relationType: 'SOURCE_REPO', projectKey: { id: 'github.com/someone/old-lib' } }] }
    };
    const packages = { 'npm/express': '5.1.0', 'npm/old-lib': '1.0.0', 'npm/qs': '6.14.0' };
    const advisories = { 'GHSA-high': { title: 'Open redirect', cvss3Score: 7.5, aliases: ['CVE-2024-1'] }, 'GHSA-low': { title: 'Minor issue', cvss3Score: 2.1 }, 'GHSA-crit': { title: 'Prototype pollution', cvss3Score: 9.8 } };
    const projects = {
        'github.com/expressjs/express': { license: 'MIT', starsCount: 60000, openIssuesCount: 100, scorecard: { overallScore: 8.5, checks: [{ name: 'Maintained', score: 10 }] } },
        'github.com/someone/old-lib': { license: 'MIT', scorecard: { overallScore: 2.4, checks: [{ name: 'Maintained', score: 0 }] } }
    };
    globalThis.fetch = async (url) => {
        calls.push(url);
        const path = decodeURIComponent(url.slice(DEPS_DEV_BASE.length + 1));
        const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });
        let m;
        if ((m = /^advisories\/(.+)$/.exec(path))) return advisories[m[1]] ? json({ advisoryKey: { id: m[1] }, ...advisories[m[1]] }) : json({}, 404);
        if ((m = /^projects\/(.+)$/.exec(path))) return projects[m[1]] ? json(projects[m[1]]) : json({}, 404);
        if (/:dependencies$/.test(path)) return json({}, 404);
        if ((m = /^systems\/(\w+)\/packages\/(.+)\/versions\/(.+)$/.exec(path))) { const v = versions[`${m[1]}/${m[2]}/${m[3]}`]; return v ? json({ versionKey: { name: m[2], version: m[3] }, ...v }) : json({}, 404); }
        if ((m = /^systems\/(\w+)\/packages\/(.+)$/.exec(path))) { const d = packages[`${m[1]}/${m[2]}`]; return d ? json({ versions: [{ versionKey: { version: d }, isDefault: true }] }) : json({}, 404); }
        return json({}, 404);
    };
    return calls;
}

test('lockfile versions and tree, advisory severity, outdated and health, end to end', async () => {
    clearDepsDevCache();
    const calls = fakeDepsDev();
    const files = [
        { path: 'package.json', text: JSON.stringify({ name: 'app', dependencies: { express: '^4.0.0', 'old-lib': '^1.0.0' } }) },
        { path: 'package-lock.json', text: JSON.stringify({ lockfileVersion: 3, packages: {
            '': { name: 'app' },
            'node_modules/express': { version: '4.21.2', dependencies: { qs: '^6' } },
            'node_modules/qs': { version: '6.13.0' },
            'node_modules/old-lib': { version: '1.0.0' }
        } }) }
    ];
    const { deps: direct, locks, lockfilesUsed } = collectDirectDependencies(files);
    assert.deepEqual(lockfilesUsed, ['package-lock.json']);
    assert.deepEqual(direct.map(d => `${d.name}@${d.version}:${d.versionKind}`).sort(), ['express@4.21.2:locked', 'old-lib@1.0.0:locked']);

    const { packages, edges } = await resolveLicenses(direct, { locks });
    assert.deepEqual(edges.map(([f, t]) => `${f} -> ${t}`).sort(), [
        '(project) -> npm|express|4.21.2', '(project) -> npm|old-lib|1.0.0', 'npm|express|4.21.2 -> npm|qs|6.13.0'
    ], 'edges from the lockfile');
    const by = Object.fromEntries(packages.map(p => [p.name, p]));
    assert.deepEqual([by.qs.relation, by.qs.version, by.qs.versionKind, by.qs.via], ['transitive', '6.13.0', 'locked', ['express']], 'transitive from the lockfile');
    assert.ok(!calls.some(u => u.includes(':dependencies')), 'no deps.dev graph requests when a lockfile covers the tree');

    assert.deepEqual(by.express.advisoryDetails.map(a => `${a.id}:${a.severity}`), ['GHSA-high:high', 'GHSA-low:low'], 'worst first');
    assert.equal(by.express.maxSeverity, 'high');
    assert.equal(by.qs.maxSeverity, 'critical');
    assert.deepEqual([by.express.latest, by.express.outdated, by.express.upgradeClears], ['5.1.0', true, 1], 'upgrading to 5.1.0 clears GHSA-high');
    assert.equal(by.qs.latest, undefined, 'outdated/health only for direct dependencies');
    assert.equal(by.express.health.scorecard, 8.5);
    assert.deepEqual(by.express.healthFlags, []);
    assert.deepEqual(by['old-lib'].healthFlags, ['deprecated or yanked', 'low OpenSSF Scorecard (2.4/10)', 'little recent activity (Scorecard "Maintained" check)', 'source repo license is MIT']);

    assert.deepEqual(collectAdvisories(packages).map(r => r.a.id), ['GHSA-crit', 'GHSA-high', 'GHSA-low']);
    const ctx = { repoName: 'o/r', repoLicense: classifyLicense('MIT'), packages, lockfiles: lockfilesUsed, includeTransitive: true, compactPermissive: true };
    const xml = buildDepsOutput('claude-xml', ctx).text;
    assert.match(xml, /<versions>Exact versions from lockfiles: package-lock\.json<\/versions>/);
    assert.match(xml, /<advisory id="GHSA-crit" severity="critical" cvss="9\.8" package="qs@6\.13\.0" relation="transitive" path="express → qs">Prototype pollution<\/advisory>/);
    assert.deepEqual(by.qs.path, ['express', 'qs'], 'the chain that pulls qs in');
    assert.equal(by.express.path, null, 'direct dependencies have no chain');
    assert.match(xml, /<advisory id="GHSA-high" severity="high" cvss="7\.5" package="express@4\.21\.2" relation="direct" aliases="CVE-2024-1" fix="latest 5\.1\.0 clears 1 of 2">Open redirect<\/advisory>/);
    assert.match(xml, /npm:express@4\.21\.2 \(MIT\) \[advisories: GHSA-high \(high 7\.5\), GHSA-low \(low 2\.1\)\]/, 'brief permissive lines keep advisories');
    assert.match(xml, /name="old-lib"[^>]*notes="[^"]*low OpenSSF Scorecard/);
    const md = buildDepsOutput('markdown', ctx).text;
    assert.match(md, /^## Security advisories \(3\)$/m);
    assert.match(md, /^\| Critical \(9\.8\) \| GHSA-crit \| qs@6\.13\.0 \| transitive \| Prototype pollution \|  \|$/m);
    const json = JSON.parse(buildDepsOutput('json', ctx).text);
    const ex = json.packages.find(p => p.name === 'express');
    assert.deepEqual([ex.latest, ex.outdated, ex.upgrade_clears_advisories, ex.advisories[0].severity], ['5.1.0', true, 1, 'high']);
});

test('without a lockfile, ranges still fall back to deps.dev; severity bands', async () => {
    clearDepsDevCache();
    fakeDepsDev();
    const { deps: direct, lockfilesUsed } = collectDirectDependencies([{ path: 'package.json', text: JSON.stringify({ dependencies: { express: '4.21.2' } }) }]);
    assert.deepEqual(lockfilesUsed, []);
    assert.equal(direct[0].versionKind, 'exact');
    assert.deepEqual([9.8, 7, 6.9, 4, 0.1, 0, null].map(severityOf), ['critical', 'high', 'medium', 'medium', 'low', 'unknown', 'unknown']);
});

test('workspaces: dependencies of local members are found; dev-only ones only with includeDev', async () => {
    clearDepsDevCache();
    fakeDepsDev();
    // Rust workspace: the root crate depends on a member by path; the member pulls in regex.
    const rust = collectDirectDependencies([
        { path: 'Cargo.toml', text: '[package]\nname = "app"\n[dependencies]\nmember = { path = "crates/member" }\nanyhow = "1"\n' },
        { path: 'Cargo.lock', text: 'version = 4\n\n[[package]]\nname = "app"\nversion = "0.1.0"\ndependencies = [\n "anyhow",\n "member",\n]\n\n[[package]]\nname = "member"\nversion = "0.1.0"\ndependencies = [\n "regex",\n]\n\n[[package]]\nname = "anyhow"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n\n[[package]]\nname = "regex"\nversion = "1.13.1"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n' }
    ]);
    const r = await resolveLicenses(rust.deps, { locks: rust.locks, details: false });
    assert.deepEqual(r.packages.map(p => `${p.name}:${p.relation}`).sort(), ['anyhow:direct', 'regex:transitive']);
    assert.deepEqual(r.packages.find(p => p.name === 'regex').via, ['member (workspace)']);
    assert.deepEqual(r.packages.find(p => p.name === 'regex').path, ['member (workspace)', 'regex'], 'shortest chain, from the nearest workspace member');

    // pnpm workspace with a dev-only tool.
    const lock = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      a:
        specifier: ^1.0.0
        version: 1.0.0
    devDependencies:
      tool:
        specifier: ^2.0.0
        version: 2.0.0

packages:

  a@1.0.0:
    resolution: {integrity: x}

  tool@2.0.0:
    resolution: {integrity: y}

  tool-dep@3.0.0:
    resolution: {integrity: z}

snapshots:

  a@1.0.0: {}

  tool@2.0.0:
    dependencies:
      tool-dep: 3.0.0

  tool-dep@3.0.0: {}
`;
    const js = collectDirectDependencies([
        { path: 'package.json', text: JSON.stringify({ name: 'web', dependencies: { a: '^1.0.0' }, devDependencies: { tool: '^2.0.0' } }) },
        { path: 'pnpm-lock.yaml', text: lock }
    ]);
    const runtime = await resolveLicenses(js.deps, { locks: js.locks, details: false });
    assert.deepEqual(runtime.packages.map(p => p.name).sort(), ['a'], 'dev tools left out by default');
    const withDev = await resolveLicenses(js.deps, { locks: js.locks, includeDev: true, details: false });
    assert.deepEqual(withDev.packages.map(p => `${p.name}:${p.dev}`).sort(), ['a:false', 'tool-dep:true', 'tool:true']);
});

test('graphPaths: shortest chain from SELF in a deps.dev graph', () => {
    const nodes = ['app', 'a', 'b', 'c'].map((name, i) => ({ versionKey: { name }, relation: i === 0 ? 'SELF' : 'INDIRECT' }));
    const edges = [{ fromNode: 0, toNode: 1 }, { fromNode: 1, toNode: 2 }, { fromNode: 2, toNode: 3 }, { fromNode: 0, toNode: 3 }];
    assert.deepEqual(graphPaths(nodes, edges), [['app'], ['app', 'a'], ['app', 'a', 'b'], ['app', 'c']]);
    assert.deepEqual(graphPaths([], []), []);
});
