/**
 * Dependency + license resolution for the Dependencies tab.
 *
 * Sources:
 *  - The repository's manifest files (package.json, requirements*.txt, pyproject.toml, go.mod,
 *    Cargo.toml), read from GitHub or a local .zip.
 *  - deps.dev (https://docs.deps.dev/api/v3/), a free public API by Google with no key, that
 *    allows browser requests. It gives each package version's licenses and known security
 *    advisories, and dependency graphs for npm, PyPI and Cargo (not Go; go.mod already lists
 *    indirect modules). Package names and versions are sent to deps.dev; nothing else is.
 *
 * GitHub's own SBOM export is not used: its synchronous endpoint closes on 13 November 2026 and
 * the replacement is an asynchronous job that redirects to a temporary download URL.
 */
import { GITHUB_API_BASE } from './config.js';
import { fetchRepoTree, fetchFileContent, extractRateLimitHeaders, sleep } from './github-api.js';
import { findManifestPaths, parseManifest } from './manifest-parsers.js';
import { parseLockfile, LOCKFILE_NAMES, compareVersions } from './lockfiles.js';
import { classifyLicense } from './license-classify.js';

/** The project itself, as the source of edges to its direct dependencies. */
export const ROOT_KEY = '(project)';

export const DEPS_DEV_BASE = 'https://api.deps.dev/v3';
const SYSTEMS = { npm: 'npm', pypi: 'pypi', go: 'go', cargo: 'cargo' };
const GRAPH_SYSTEMS = new Set(['npm', 'pypi', 'cargo']);

export class DepsError extends Error {
    constructor(message, status = null) {
        super(message);
        this.name = 'DepsError';
        this.status = status;
    }
}

// ------------------------------------------------------------------ GitHub side

function authHeaders(pat) {
    if (!pat) return {};
    const token = pat.trim();
    return { 'Authorization': /^(github_pat_|gho_|ghu_|ghs_)/.test(token) ? `Bearer ${token}` : `token ${token}` };
}

/**
 * A pull request's base branch and head commit (the head may live in a fork).
 * @returns {{ number, title, baseRef, headSha, headOwner, headRepo, headLabel }}
 */
export async function fetchPullRequest(owner, repo, number, { pat = '', signal, onHeaders } = {}) {
    const res = await fetch(`${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${Number(number)}`, {
        headers: { 'Accept': 'application/vnd.github.v3+json', ...authHeaders(pat) }, signal
    });
    if (onHeaders) onHeaders(extractRateLimitHeaders(res));
    if (!res.ok) {
        throw new DepsError(res.status === 404
            ? `Can't find pull request #${Number(number)} in ${owner}/${repo}.`
            : `Pull request lookup failed (${res.status}).`, res.status);
    }
    const pr = await res.json();
    if (!pr.head || !pr.head.repo || !pr.head.sha || !pr.base || !pr.base.ref) {
        throw new DepsError(`Pull request #${Number(number)} has no readable head (its fork may have been deleted).`);
    }
    return {
        number: pr.number,
        title: pr.title || '',
        baseRef: pr.base.ref,
        headSha: pr.head.sha,
        headOwner: pr.head.repo.owner ? pr.head.repo.owner.login : owner,
        headRepo: pr.head.repo.name,
        headLabel: pr.head.label || `${pr.head.repo.full_name}:${pr.head.ref}`
    };
}

/** Repository metadata: default branch, privacy and the repo's own license (SPDX ID). */
export async function fetchRepoInfo(owner, repo, { pat = '', signal, onHeaders } = {}) {
    const res = await fetch(`${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
        headers: { 'Accept': 'application/vnd.github.v3+json', ...authHeaders(pat) }, signal
    });
    if (onHeaders) onHeaders(extractRateLimitHeaders(res));
    if (!res.ok) {
        const msg = res.status === 404
            ? "Can't find that repository. For a private repo, add a token with read access."
            : res.status === 403 || res.status === 429
                ? 'GitHub rate limit reached or access forbidden. Add a token to raise the limit.'
                : `Repository lookup failed (${res.status}).`;
        throw new DepsError(msg, res.status);
    }
    const data = await res.json();
    const spdx = data.license && data.license.spdx_id && data.license.spdx_id !== 'NOASSERTION' ? data.license.spdx_id : null;
    return {
        branch: data.default_branch || 'main',
        isPrivate: Boolean(data.private),
        license: spdx,
        licenseName: data.license ? data.license.name : null
    };
}

async function readManifests(list, readText) {
    const manifests = [];
    const failed = [];
    for (const m of list) {
        try {
            manifests.push({ ...m, text: await readText(m.path) });
        } catch (err) {
            if (err && err.name === 'AbortError') throw err;
            failed.push({ path: m.path, error: (err && err.message) || String(err) });
        }
    }
    return { manifests, failed };
}

/** Finds and downloads the manifest files of a GitHub repository. */
export async function fetchRepoManifests(owner, repo, { pat = '', branch, isPrivate = false, skipExamples = true, signal, onHeaders } = {}) {
    const tree = await fetchRepoTree(owner, repo, branch, pat, signal, onHeaders);
    const paths = tree.filter(n => n.type === 'blob').map(n => n.path);
    const { manifests: found, skipped, unsupported } = findManifestPaths(paths, { skipExamples });
    const { manifests, failed } = await readManifests(found, async (path) => {
        const r = await fetchFileContent(owner, repo, branch, path, pat, signal, onHeaders, isPrivate);
        if (!r || !r.success) throw new Error(r && r.error ? r.error : `HTTP ${r ? r.status : '?'}`);
        return r.content;
    });
    return { manifests, failed, skipped, unsupported, treeTruncated: Boolean(tree.truncated) };
}

/** Finds and reads the manifest files inside a parsed .zip archive (js/zip-loader.js). */
export async function readZipManifests(archive, { skipExamples = true } = {}) {
    const { manifests: found, skipped, unsupported } = findManifestPaths(archive.treeNodes.map(n => n.path), { skipExamples });
    const { manifests, failed } = await readManifests(found, path => archive.readText(path));
    return { manifests, failed, skipped, unsupported, treeTruncated: false };
}

const dirOf = path => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/**
 * Parses manifests into direct dependencies, merging duplicates and skipping packages that are
 * defined in the repository itself (monorepo workspaces). When a lockfile covers a manifest (same
 * ecosystem, in the manifest's folder or a parent folder), its exact versions are used.
 *
 * @returns {{ deps, locks, lockfilesUsed: string[], parseErrors }}
 */
export function collectDirectDependencies(files) {
    const isLock = f => Boolean(LOCKFILE_NAMES[f.path.split('/').pop()]);
    files = files.filter(f => f.path !== '.gitdoco-policy.json'); // read by the page, not a manifest
    const parseErrors = [];
    const locks = [];
    for (const f of files.filter(isLock)) {
        try {
            const g = parseLockfile(f.path, f.text);
            if (g) locks.push(g);
        } catch (err) {
            parseErrors.push({ path: f.path, error: `Could not read lockfile (${err.message || err})` });
        }
    }
    const lockFor = (ecosystem, manifestDir) => locks
        .map((g, index) => ({ g, index }))
        .filter(({ g }) => g.ecosystem === ecosystem && (g.dir === '' || g.dir === manifestDir || manifestDir.startsWith(`${g.dir}/`)))
        .sort((a, b) => b.g.dir.length - a.g.dir.length)[0] || null;

    const parsed = files.filter(f => !isLock(f)).map(m => ({ ...m, result: parseManifest(m.path, m.text) }));
    const localNames = new Set(parsed.map(p => p.result.name).filter(Boolean));
    const byKey = new Map();
    const used = new Set();
    for (const p of parsed) {
        for (let d of p.result.deps || []) {
            if (localNames.has(d.name)) continue;
            const lock = lockFor(d.ecosystem, dirOf(d.manifest));
            if (lock) {
                const id = lock.g.resolveDirect(d.name, d.spec, dirOf(d.manifest));
                const node = id && lock.g.nodes.get(id);
                if (node && node.local) continue; // the repository's own workspace package
                if (node) {
                    d = { ...d, version: node.version, versionKind: 'locked', lockIndex: lock.index, lockId: id };
                    used.add(lock.g.file);
                }
            }
            const key = `${d.ecosystem}|${d.name}|${d.version || ''}`;
            const existing = byKey.get(key);
            if (existing) {
                existing.manifests.add(d.manifest);
                existing.dev = existing.dev && d.dev; // a runtime use anywhere wins
                existing.indirect = existing.indirect && d.indirect;
            } else {
                byKey.set(key, { ...d, manifests: new Set([d.manifest]) });
            }
        }
    }
    for (const p of parsed) if (p.result.error) parseErrors.push({ path: p.path, error: p.result.error });
    return { deps: [...byKey.values()], locks, lockfilesUsed: [...used].sort(), parseErrors };
}

// ------------------------------------------------------------------ deps.dev

const cache = new Map();

/** GET a deps.dev URL with caching, 429/5xx retries and abort support. 404 resolves to null. */
async function depsDevGet(path, signal) {
    const url = `${DEPS_DEV_BASE}/${path}`;
    if (cache.has(url)) return cache.get(url);
    const promise = (async () => {
        for (let attempt = 0; ; attempt++) {
            const res = await fetch(url, { signal });
            if (res.ok) return res.json();
            if (res.status === 404) return null;
            if ((res.status === 429 || res.status >= 500) && attempt < 3) {
                await sleep(500 * 2 ** attempt, signal);
                continue;
            }
            throw new DepsError(`deps.dev request failed (${res.status})`, res.status);
        }
    })();
    cache.set(url, promise);
    promise.catch(() => cache.delete(url));
    return promise;
}

export function clearDepsDevCache() {
    cache.clear();
}

const pkgPath = (eco, name) => `systems/${SYSTEMS[eco]}/packages/${encodeURIComponent(name)}`;

async function defaultVersion(eco, name, signal) {
    const data = await depsDevGet(pkgPath(eco, name), signal);
    if (!data || !Array.isArray(data.versions)) return null;
    const def = data.versions.find(v => v.isDefault) || data.versions[data.versions.length - 1];
    return def ? def.versionKey.version : null;
}

/** Runs tasks with limited concurrency. */
async function pool(items, limit, fn, signal) {
    let i = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (i < items.length) {
            if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
            const idx = i++;
            await fn(items[idx], idx);
        }
    });
    await Promise.all(workers);
}

/** Shortest chain of names from the SELF node to each node of a deps.dev dependency graph. */
export function graphPaths(nodes, edges) {
    const out = new Array(nodes.length).fill(null);
    const self = nodes.findIndex(n => n.relation === 'SELF');
    if (self < 0) return out;
    const children = new Map();
    for (const e of edges) {
        if (!children.has(e.fromNode)) children.set(e.fromNode, []);
        children.get(e.fromNode).push(e.toNode);
    }
    const name = i => (nodes[i] && nodes[i].versionKey ? nodes[i].versionKey.name : '?');
    out[self] = [name(self)];
    const queue = [self];
    while (queue.length) {
        const i = queue.shift();
        for (const j of children.get(i) || []) {
            if (out[j]) continue;
            out[j] = [...out[i], name(j)];
            queue.push(j);
        }
    }
    return out;
}

/** CVSS v3 score -> severity band (FIRST.org ranges). */
export function severityOf(score) {
    if (typeof score !== 'number' || score <= 0) return 'unknown';
    if (score >= 9) return 'critical';
    if (score >= 7) return 'high';
    if (score >= 4) return 'medium';
    return 'low';
}
export const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'unknown'];

/**
 * Looks up licenses (and advisories) for direct dependencies and, optionally, their transitive
 * dependencies. Returns a flat package list. Lockfile versions and trees are used where
 * collectDirectDependencies found them (pass its `locks` as options.locks).
 *
 * Package: { key, ecosystem, name, version, versionKind: 'locked'|'exact'|'range-min'|'latest',
 *   relation: 'direct'|'transitive', dev, via: string[], manifests: string[],
 *   license: {expression, group, notes}, advisories: string[],
 *   advisoryDetails: [{ id, title, score, severity, aliases, url }], maxSeverity,
 *   latest, outdated, upgradeClears, health: { scorecard, maintained, stars, openIssues, project,
 *   projectLicense }, healthFlags: string[], deprecated,
 *   status: 'ok'|'not-found'|'error'|'not-checked', error? }
 * (latest/outdated/health only for direct dependencies.)
 *
 * `edges` lists who depends on whom as [fromKey, toKey] pairs of package keys; fromKey is
 * ROOT_KEY for the project's own direct dependencies (and its workspace members' dependencies).
 * Edges come from the lockfile, or from deps.dev's resolved graph when there is no lockfile.
 * Pipfile.lock has no edges, so its transitive packages appear unconnected.
 *
 * Every package found is returned. Only the first `maxLookups` are looked up on deps.dev (direct
 * first, then runtime, then those closest to a direct dependency); the rest have status
 * 'not-checked'. Lookups are cached, so calling again with a higher limit only fetches the new ones.
 * @returns {Promise<{ packages: object[], edges: [string, string][], unchecked: number, capped: boolean }>}
 */
export async function resolveLicenses(directDeps, options = {}) {
    const {
        includeTransitive = true,
        includeDev = false,
        locks = [],
        details = true,
        maxLookups = 5000,
        maxPackages = 50000,
        concurrency = 8,
        signal,
        onProgress
    } = options;

    const packages = new Map();
    let done = 0;
    let total = 0;
    const tick = () => { done++; if (onProgress) onProgress(done, total); };
    let capped = false;
    const edgeSet = new Set();
    const link = (from, to) => { if (from && to && from !== to) edgeSet.add(`${from}\n${to}`); };
    const pkgKey = (ecosystem, name, version) => `${ecosystem}|${name}|${version || ''}`;

    const add = (p) => {
        const key = `${p.ecosystem}|${p.name}|${p.version || ''}`;
        const existing = packages.get(key);
        if (existing) {
            if (p.relation === 'direct') { existing.relation = 'direct'; existing.path = null; }
            if (existing.relation !== 'direct' && p.path && (!existing.path || p.path.length < existing.path.length)) existing.path = p.path;
            existing.dev = existing.dev && p.dev;
            for (const v of p.via || []) if (!existing.via.includes(v)) existing.via.push(v);
            for (const m of p.manifests || []) if (!existing.manifests.includes(m)) existing.manifests.push(m);
            return existing;
        }
        if (packages.size >= maxPackages) { capped = true; return null; }
        const rec = {
            key, ecosystem: p.ecosystem, name: p.name, version: p.version || null, versionKind: p.versionKind || 'exact',
            relation: p.relation, dev: Boolean(p.dev), via: [...(p.via || [])], manifests: [...(p.manifests || [])],
            path: p.relation === 'direct' ? null : (p.path || null),
            license: classifyLicense([]), advisories: [], status: 'pending'
        };
        packages.set(key, rec);
        return rec;
    };

    // 1. Direct dependencies (Go modules marked "// indirect" in go.mod count as transitive).
    const direct = directDeps.filter(d => includeDev || !d.dev);
    total = direct.length;
    const directRecs = [];
    await pool(direct, concurrency, async (d) => {
        let version = d.version;
        let versionKind = d.versionKind;
        try {
            if (!version) {
                version = await defaultVersion(d.ecosystem, d.name, signal);
                versionKind = 'latest';
            }
        } catch (err) {
            if (err.name === 'AbortError') throw err;
        }
        const rec = add({
            ecosystem: d.ecosystem, name: d.name, version, versionKind,
            relation: d.indirect ? 'transitive' : 'direct', dev: d.dev,
            manifests: [...(d.manifests || [d.manifest])]
        });
        if (rec) {
            directRecs.push({ rec, wanted: d });
            if (rec.relation === 'direct') link(ROOT_KEY, rec.key);
        }
        tick();
    }, signal);

    // 2. Transitive dependencies: from the lockfile when there is one (exact and complete),
    //    otherwise from deps.dev's resolved graphs (npm, PyPI, Cargo).
    if (includeTransitive) {
        const roots = directRecs.filter(({ rec }) => rec.relation === 'direct' && (includeDev || !rec.dev) && rec.version);
        const fromLock = roots.filter(({ wanted }) => wanted.lockId && locks[wanted.lockIndex]);
        // Runtime roots first, so a package reachable at runtime is never marked dev-only.
        fromLock.sort((a, b) => Number(a.rec.dev) - Number(b.rec.dev));
        const flatLocks = new Set();
        // Walks a lockfile graph from one node. Local (workspace) nodes are passed through, not
        // reported; their development dependencies are followed only with includeDev.
        const workspaceLabel = n => `${n.name === '(root)' ? 'project' : n.name} (workspace)`;
        const walk = (g, startId, viaName, dev, manifests) => {
            const seen = new Set([startId]);
            const queue = [[startId, dev, viaName, [viaName]]];
            while (queue.length) {
                const [id, isDev, via, path] = queue.shift();
                const node = g.nodes.get(id);
                if (!node) continue;
                // Below a workspace member, "via" names the nearest member rather than the start.
                const childVia = node.local && id !== startId ? workspaceLabel(node) : via;
                const edges = [...node.deps].map(t => [t, isDev]);
                if (node.local && includeDev) edges.push(...[...node.devDeps].map(t => [t, true]));
                const fromKey = node.local ? ROOT_KEY : pkgKey(g.ecosystem, node.name, node.version);
                for (const [next, nextDev] of edges) {
                    const target = g.nodes.get(next);
                    if (target && !target.local) link(fromKey, pkgKey(g.ecosystem, target.name, target.version));
                    if (seen.has(next)) continue;
                    seen.add(next);
                    const n = g.nodes.get(next);
                    if (!n) continue;
                    // The chain from the direct dependency (or workspace member) down to this package.
                    const nextPath = [...path, n.local ? workspaceLabel(n) : n.name];
                    queue.push([next, nextDev, childVia, nextPath]);
                    if (!n.local) add({ ecosystem: g.ecosystem, name: n.name, version: n.version, versionKind: 'locked', relation: 'transitive', dev: nextDev, via: [childVia], path: nextPath, manifests });
                }
            }
        };
        for (const { rec, wanted } of fromLock) {
            const g = locks[wanted.lockIndex];
            if (g.flat) { flatLocks.add(g); continue; }
            walk(g, wanted.lockId, rec.name, rec.dev, rec.manifests);
        }
        // Workspace members' own dependencies (e.g. a Rust workspace's crates, npm/pnpm/yarn workspaces).
        const usedLocks = new Set(fromLock.map(({ wanted }) => locks[wanted.lockIndex]));
        for (const g of usedLocks) {
            if (g.flat) continue;
            for (const [id, node] of g.nodes) {
                if (node.local) walk(g, id, workspaceLabel(node), false, [g.file]);
            }
        }
        // Lockfiles without dependency edges (Pipfile.lock): every other locked package is transitive.
        for (const g of flatLocks) {
            for (const n of g.nodes.values()) {
                if (n.dev && !includeDev) continue;
                add({ ecosystem: g.ecosystem, name: n.name, version: n.version, versionKind: 'locked', relation: 'transitive', dev: n.dev, via: [], manifests: [g.file] });
            }
        }

        const fromGraph = roots.filter(({ rec, wanted }) => !(wanted.lockId && locks[wanted.lockIndex]) && GRAPH_SYSTEMS.has(rec.ecosystem));
        total += fromGraph.length;
        await pool(fromGraph, concurrency, async ({ rec }) => {
            try {
                const graph = await depsDevGet(`${pkgPath(rec.ecosystem, rec.name)}/versions/${encodeURIComponent(rec.version)}:dependencies`, signal);
                const nodes = (graph && graph.nodes) || [];
                const paths = graphPaths(nodes, (graph && graph.edges) || []);
                const keyAt = i => (nodes[i] && nodes[i].relation === 'SELF' ? rec.key
                    : nodes[i] && nodes[i].versionKey ? pkgKey(rec.ecosystem, nodes[i].versionKey.name, nodes[i].versionKey.version) : null);
                for (const e of (graph && graph.edges) || []) link(keyAt(e.fromNode), keyAt(e.toNode));
                nodes.forEach((n, i) => {
                    if (n.relation === 'SELF' || !n.versionKey) return;
                    add({
                        ecosystem: rec.ecosystem, name: n.versionKey.name, version: n.versionKey.version,
                        versionKind: 'exact', relation: 'transitive', dev: rec.dev, via: [rec.name], path: paths[i] || null, manifests: rec.manifests
                    });
                });
            } catch (err) {
                if (err.name === 'AbortError') throw err;
                rec.graphError = err.message;
            }
            tick();
        }, signal);
    }

    // 3. Licenses and advisories, most important packages first, up to the lookup limit.
    const all = [...packages.values()];
    const order = p => [p.relation === 'direct' ? 0 : 1, p.dev ? 1 : 0, p.path ? p.path.length : 1];
    const ranked = [...all].sort((a, b) => {
        const x = order(a), y = order(b);
        return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
    });
    const toCheck = ranked.slice(0, Math.max(0, maxLookups));
    for (const rec of ranked.slice(toCheck.length)) rec.status = 'not-checked';
    total += toCheck.length;
    await pool(toCheck, concurrency, async (rec) => {
        try {
            let info = rec.version ? await depsDevGet(`${pkgPath(rec.ecosystem, rec.name)}/versions/${encodeURIComponent(rec.version)}`, signal) : null;
            if (!info && rec.versionKind !== 'exact') {
                // The lowest version in a range may not exist; fall back to the latest release.
                const latest = await defaultVersion(rec.ecosystem, rec.name, signal);
                if (latest && latest !== rec.version) {
                    info = await depsDevGet(`${pkgPath(rec.ecosystem, rec.name)}/versions/${encodeURIComponent(latest)}`, signal);
                    if (info) { rec.version = latest; rec.versionKind = 'latest'; }
                }
            }
            if (!info) {
                rec.status = 'not-found';
            } else {
                rec.status = 'ok';
                rec.license = classifyLicense(info.licenses || []);
                rec.advisories = (info.advisoryKeys || []).map(a => a.id).filter(Boolean);
                rec.deprecated = Boolean(info.isDeprecated);
                const source = (info.relatedProjects || []).find(r => r.relationType === 'SOURCE_REPO' && r.projectKey);
                rec.sourceProject = source ? source.projectKey.id : null;
            }
        } catch (err) {
            if (err.name === 'AbortError') throw err;
            rec.status = 'error';
            rec.error = err.message;
        }
        tick();
    }, signal);

    if (details) await addDetails(toCheck, { concurrency, signal, onTick: () => tick(), onTotal: n => { total += n; } });
    const unchecked = all.length - toCheck.length;
    const edges = [...edgeSet].map(e => e.split('\n')).filter(([from, to]) => (from === ROOT_KEY || packages.has(from)) && packages.has(to));
    return { packages: all, edges, unchecked, capped: capped || unchecked > 0 };
}

/**
 * Advisory titles and severity for every package; latest version, whether upgrading clears
 * the advisories, and project health (OpenSSF Scorecard, maintenance, source licence) for
 * direct dependencies. Failures leave the fields empty rather than failing the report.
 */
async function addDetails(packages, { concurrency, signal, onTick, onTotal }) {
    const ids = [...new Set(packages.flatMap(p => p.advisories || []))];
    const directs = packages.filter(p => p.relation === 'direct' && p.status === 'ok' && p.version);
    onTotal(ids.length + directs.length);

    const advisories = new Map();
    await pool(ids, concurrency, async (id) => {
        try {
            const a = await depsDevGet(`advisories/${encodeURIComponent(id)}`, signal);
            if (a) {
                const score = typeof a.cvss3Score === 'number' ? a.cvss3Score : null;
                advisories.set(id, { id, title: a.title || '', score, severity: severityOf(score), aliases: a.aliases || [], url: a.url || '' });
            }
        } catch (err) {
            if (err.name === 'AbortError') throw err;
        }
        onTick();
    }, signal);
    for (const p of packages) {
        p.advisoryDetails = (p.advisories || []).map(id => advisories.get(id) || { id, title: '', score: null, severity: 'unknown', aliases: [], url: '' })
            .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || (b.score || 0) - (a.score || 0));
        p.maxSeverity = p.advisoryDetails.length ? p.advisoryDetails[0].severity : null;
        // deps.dev marks npm deprecations and PyPI/Cargo yanked releases the same way.
        p.healthFlags = p.deprecated ? ['deprecated or yanked'] : [];
    }

    await pool(directs, concurrency, async (p) => {
        try {
            const latest = await defaultVersion(p.ecosystem, p.name, signal);
            if (latest) {
                p.latest = latest;
                p.outdated = latest !== p.version && compareVersions(latest, p.version) > 0;
                if (p.outdated && p.advisories.length) {
                    const info = await depsDevGet(`${pkgPath(p.ecosystem, p.name)}/versions/${encodeURIComponent(latest)}`, signal);
                    const remaining = new Set(((info && info.advisoryKeys) || []).map(a => a.id));
                    p.upgradeClears = p.advisories.filter(id => !remaining.has(id)).length;
                }
            }
            if (p.sourceProject) {
                const proj = await depsDevGet(`projects/${encodeURIComponent(p.sourceProject)}`, signal);
                if (proj) {
                    const sc = proj.scorecard || null;
                    const maintained = sc && Array.isArray(sc.checks) ? sc.checks.find(c => c.name === 'Maintained') : null;
                    p.health = {
                        project: p.sourceProject,
                        scorecard: sc && typeof sc.overallScore === 'number' ? sc.overallScore : null,
                        maintained: maintained && typeof maintained.score === 'number' ? maintained.score : null,
                        stars: typeof proj.starsCount === 'number' ? proj.starsCount : null,
                        openIssues: typeof proj.openIssuesCount === 'number' ? proj.openIssuesCount : null,
                        projectLicense: proj.license || null
                    };
                    if (p.health.scorecard !== null && p.health.scorecard < 4) p.healthFlags.push(`low OpenSSF Scorecard (${p.health.scorecard.toFixed(1)}/10)`);
                    // Scorecard's Maintained check: 0 = no recent commits or issue activity; -1 = not checked.
                    if (p.health.maintained !== null && p.health.maintained >= 0 && p.health.maintained <= 1) p.healthFlags.push('little recent activity (Scorecard "Maintained" check)');
                    // Only a recognised source licence that disagrees with the registry is worth flagging
                    // (deps.dev reports "non-standard" when it cannot identify one).
                    const repoLic = p.health.projectLicense ? classifyLicense(p.health.projectLicense) : null;
                    if (repoLic && repoLic.group !== 'unknown' && repoLic.group !== p.license.group) {
                        p.healthFlags.push(`source repo license is ${p.health.projectLicense}`);
                    }
                }
            }
        } catch (err) {
            if (err.name === 'AbortError') throw err;
        }
        onTick();
    }, signal);
}
