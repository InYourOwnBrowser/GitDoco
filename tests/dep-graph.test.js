import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { toGraphData, indexGraph, layoutGraph, pathTo, defaultExpanded, isProblem, staticSvg, ROOT_ID, AUTO_EXPAND_LIMIT } from '../js/dep-graph.js';
import { toStandaloneGraphHtml, readmeSnippets, scriptSafeJson, inlineEngine } from '../js/dep-graph-export.js';
import { routeFor } from '../js/repo-route.js';

const ROOT = '(project)';
const pkg = (name, extra = {}) => ({ key: `npm|${name}|1.0.0`, ecosystem: 'npm', name, version: '1.0.0', relation: 'transitive', dev: false, license: { expression: 'MIT', group: 'permissive' }, advisories: [], status: 'ok', ...extra });
const k = name => `npm|${name}|1.0.0`;

// project -> a, b ; a -> c ; b -> c (diamond) ; c -> d ; e has no known parent
function sample() {
    const packages = [
        pkg('a', { relation: 'direct' }), pkg('b', { relation: 'direct' }),
        pkg('c', { license: { expression: 'GPL-3.0', group: 'strong-copyleft' } }),
        pkg('d', { advisories: ['GHSA-x'], advisoryDetails: [{ id: 'GHSA-x', severity: 'high', title: 'Bad', score: 8 }], maxSeverity: 'high' }),
        pkg('e')
    ];
    const edges = [[ROOT, k('a')], [ROOT, k('b')], [k('a'), k('c')], [k('b'), k('c')], [k('c'), k('d')], [k('a'), k('c')], [k('x'), k('a')]];
    return toGraphData({ packages, edges, rootKey: ROOT, label: 'o/r', groupLabels: { permissive: 'Permissive', 'strong-copyleft': 'Strong copyleft' },
        links: p => ({ url: `https://www.npmjs.com/package/${p.name}`, advisoryUrl: id => `https://github.com/advisories/${id}` }) });
}

test('toGraphData: root, deduplicated edges, unknown parents, problems', () => {
    const data = sample();
    const byName = Object.fromEntries(data.nodes.map(n => [n.name, n]));
    assert.equal(data.nodes[ROOT_ID].name, 'o/r');
    assert.equal(data.edges.length, 6, 'duplicate a->c and the edge from an unknown package dropped; e attached to the project');
    assert.equal(byName.e.unlinked, true);
    assert.equal(byName.a.unlinked, undefined);
    assert.deepEqual(data.nodes.filter(isProblem).map(n => n.name), ['c', 'd']);
    assert.equal(byName.d.advisories[0].url, 'https://github.com/advisories/GHSA-x');
    assert.equal(byName.c.groupLabel, 'Strong copyleft');
});

test('toGraphData keeps only https links', () => {
    const data = toGraphData({ packages: [pkg('a', { relation: 'direct' })], edges: [[ROOT, k('a')]], rootKey: ROOT, label: 'x',
        links: () => ({ url: 'javascript:alert(1)', advisoryUrl: () => 'http://x' }) });
    assert.equal(data.nodes[1].url, '');
});

test('indexGraph and pathTo: shortest chain through the diamond', () => {
    const data = sample();
    const index = indexGraph(data);
    const id = name => data.nodes.find(n => n.name === name).id;
    assert.equal(index.depth[id('d')], 3);
    assert.deepEqual(pathTo(index, id('d')).map(i => data.nodes[i].name), ['o/r', 'a', 'c', 'd']);
});

test('layoutGraph: collapsed nodes count their hidden children; problems-only keeps paths', () => {
    const data = sample();
    const index = indexGraph(data);
    const id = name => data.nodes.find(n => n.name === name).id;
    const all = layoutGraph(data, index, { expanded: defaultExpanded(data, index) });
    assert.equal(all.nodes.size, data.nodes.length, 'a small graph opens fully expanded');
    assert.ok(all.nodes.get(id('a')).x < all.nodes.get(id('c')).x, 'deeper packages further right');

    const top = layoutGraph(data, index, { expanded: new Set([ROOT_ID]) });
    assert.deepEqual([...top.nodes.keys()].map(i => data.nodes[i].name).sort(), ['a', 'b', 'e', 'o/r']);
    assert.equal(top.nodes.get(id('a')).hidden, 1, 'a hides c');

    const prob = layoutGraph(data, index, { problemsOnly: true });
    assert.deepEqual([...prob.nodes.keys()].map(i => data.nodes[i].name).sort(), ['a', 'b', 'c', 'd', 'o/r'], 'e is not on a path to a problem');
});

test('large graphs open with the project and its direct dependencies expanded', () => {
    const packages = [pkg('top', { relation: 'direct' }), pkg('deep')];
    const edges = [[ROOT, k('top')]];
    for (let i = 0; i < AUTO_EXPAND_LIMIT + 5; i++) { packages.push(pkg(`p${i}`)); edges.push([k('top'), k(`p${i}`)]); }
    edges.push([k('p0'), k('deep')]);
    const data = toGraphData({ packages, edges, rootKey: ROOT, label: 'big' });
    const index = indexGraph(data);
    const layout = layoutGraph(data, index, { expanded: defaultExpanded(data, index) });
    const deep = data.nodes.find(n => n.name === 'deep').id;
    const p0 = data.nodes.find(n => n.name === 'p0').id;
    assert.ok(!layout.nodes.has(deep), 'third level stays collapsed');
    assert.equal(layout.nodes.get(p0).hidden, 1);
    assert.equal(layout.nodes.size, AUTO_EXPAND_LIMIT + 7);
});

test('staticSvg escapes names and has no scripts or outside resources', () => {
    const data = toGraphData({ packages: [pkg('<script>alert(1)</script>', { relation: 'direct', key: 'evil' })], edges: [[ROOT, 'evil']], rootKey: ROOT, label: 'a&b' });
    const index = indexGraph(data);
    const out = staticSvg(data, layoutGraph(data, index, { expanded: defaultExpanded(data, index) }));
    assert.doesNotMatch(out, /<script/i);
    assert.match(out, /&lt;script&gt;/);
    assert.match(out, /a&amp;b/);
    assert.doesNotMatch(out, /(href|src)=/);
});

test('standalone page: one hashed script, no network, data cannot break out', async () => {
    const engineSource = fs.readFileSync(new URL('../js/dep-graph.js', import.meta.url), 'utf8');
    const css = fs.readFileSync(new URL('../css/dep-graph.css', import.meta.url), 'utf8');
    const data = toGraphData({ packages: [pkg('</script><script>alert(1)</script>', { relation: 'direct', key: 'evil' })], edges: [[ROOT, 'evil']], rootKey: ROOT, label: 'o/r' });
    const html = await toStandaloneGraphHtml({ data, engineSource, css, generated: '7 November 2026' });
    const scripts = [...html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)];
    assert.equal(scripts.length, 2, 'the data block and the engine');
    const engine = scripts.find(m => !/type="application\/json"/.test(m[0]))[1];
    const hash = crypto.createHash('sha256').update(engine).digest('base64');
    assert.match(html, new RegExp(`script-src 'sha256-${hash.replace(/[+/=]/g, c => `\\${c}`)}'`), 'CSP allows exactly this script');
    assert.match(html, /default-src 'none'/);
    assert.doesNotMatch(html, /connect-src/, 'no connect-src: default-src none forbids all requests');
    assert.equal((html.match(/<\/script>/g) || []).length, 2, 'a package name cannot close the script element');
    assert.doesNotMatch(engine, /\bexport\b\s+(const|function)/);
    assert.deepEqual(JSON.parse(scripts[0][1]).nodes[1].name, '</script><script>alert(1)</script>');
    assert.doesNotMatch(html, /<(script|link|img)[^>]+(src|href)="https?:/i, 'loads nothing from outside');
});

test('engine inlining refuses imports', () => {
    assert.throws(() => inlineEngine("import x from './y.js';\nexport const a = 1;"));
    assert.equal(scriptSafeJson({ a: '</script>&' }), '{"a":"\\u003c/script\\u003e\\u0026"}');
});

test('README snippets link to the live graph and validate the repo name', () => {
    const s = readmeSnippets('facebook/react');
    assert.equal(s.url, 'https://gitdoco.timedoco.com/facebook/react/graph');
    assert.equal(s.link, '[View the interactive dependency graph](https://gitdoco.timedoco.com/facebook/react/graph)');
    assert.equal(s.image, '[![Dependency graph of facebook/react](docs/dependency-graph.svg)](https://gitdoco.timedoco.com/facebook/react/graph)');
    assert.equal(readmeSnippets('bad name/x](javascript:alert(1))'), null);
    assert.equal(readmeSnippets(''), null);
});

test('/owner/repo/graph opens the Dependencies tool with the graph', () => {
    const r = routeFor('/facebook/react/graph');
    assert.equal(r.tool, 'deps');
    assert.match(r.href, /^\/deps\.html\?/);
    const q = new URLSearchParams(r.href.split('?')[1]);
    assert.deepEqual([q.get('repo'), q.get('view'), q.get('go')], ['facebook/react', 'graph', '1']);
});
