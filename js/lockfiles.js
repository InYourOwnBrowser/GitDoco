/**
 * Lockfile readers. A lockfile records the exact version of every installed package and what
 * each depends on, so the Dependencies tool can check the versions a project really uses (not
 * the lowest version a range allows) and its real transitive tree.
 *
 * Supported: package-lock.json / npm-shrinkwrap.json (v1-v3), yarn.lock (classic and Berry),
 * pnpm-lock.yaml (v5-v9, including multi-document files), poetry.lock, uv.lock, Pipfile.lock
 * and Cargo.lock. Local packages (workspaces, links, path/git sources) are skipped.
 *
 * Every reader returns a LockGraph:
 *   { ecosystem, file, dir, flat,
 *     nodes: Map<id, { name, version, dev, local, deps: Set<id>, devDeps: Set<id> }>,
 *     resolveDirect(name, spec, manifestDir) -> id | null }
 * Local packages (workspace members, path/editable sources) are kept as `local` nodes: they are
 * never reported, but their dependencies are followed, so a monorepo's whole tree is found.
 * `devDeps` (local nodes only) are development dependencies, followed only when asked.
 * `flat` is true when the lockfile lists packages without their dependency edges (Pipfile.lock).
 */
import { normalizePypiName } from './manifest-parsers.js';

export const LOCKFILE_NAMES = {
    'package-lock.json': 'npm',
    'npm-shrinkwrap.json': 'npm',
    'yarn.lock': 'npm',
    'pnpm-lock.yaml': 'npm',
    'poetry.lock': 'pypi',
    'uv.lock': 'pypi',
    'Pipfile.lock': 'pypi',
    'Cargo.lock': 'cargo'
};

const dirOf = path => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const unquote = s => String(s ?? '').trim().replace(/^(['"])(.*)\1$/, '$2');

/** Compares dotted versions numerically ("1.10.0" > "1.9.3"); pre-releases sort before releases. */
export function compareVersions(a, b) {
    const pa = String(a).replace(/^v/, '').split(/[.+-]/);
    const pb = String(b).replace(/^v/, '').split(/[.+-]/);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = pa[i], y = pb[i];
        if (x === undefined) return /^\d/.test(y) ? -1 : 1;
        if (y === undefined) return /^\d/.test(x) ? 1 : -1;
        const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
        if (nx && ny && Number(x) !== Number(y)) return Number(x) - Number(y);
        if (nx !== ny) return nx ? 1 : -1;
        if (!nx && x !== y) return x < y ? -1 : 1;
    }
    return 0;
}

/** Shared graph: nodes by "name@version" plus a by-name index for lookups. */
function makeGraph(ecosystem, file) {
    const nodes = new Map();
    const byName = new Map();
    const add = (name, version, dev = false, local = false) => {
        const id = local ? `local:${name}@${version}` : `${name}@${version}`;
        if (!nodes.has(id)) {
            nodes.set(id, { name, version, dev, local, deps: new Set(), devDeps: new Set() });
            if (!local) {
                if (!byName.has(name)) byName.set(name, []);
                byName.get(name).push(id);
            }
        } else if (!dev) {
            nodes.get(id).dev = false;
        }
        return id;
    };
    /** The id for a package name: exact version from the spec if present, else the only or highest one. */
    const pickByName = (name, spec = '') => {
        const ids = byName.get(name);
        if (!ids || ids.length === 0) return null;
        if (ids.length === 1) return ids[0];
        const exact = /(\d+\.\d+\.\d+[^\s,]*)/.exec(String(spec));
        if (exact && /^[=v\s]*\d/.test(String(spec).trim())) {
            const hit = ids.find(id => nodes.get(id).version === exact[1]);
            if (hit) return hit;
        }
        return [...ids].sort((a, b) => compareVersions(nodes.get(b).version, nodes.get(a).version))[0];
    };
    return { ecosystem, file, dir: dirOf(file), flat: false, nodes, byName, add, pickByName, resolveDirect: (name, spec) => pickByName(name, spec) };
}

// ------------------------------------------------------------------ npm: package-lock.json

function npmNameFromPath(path) {
    const i = path.lastIndexOf('node_modules/');
    return i >= 0 ? path.slice(i + 'node_modules/'.length) : null;
}

export function parsePackageLock(text, file = 'package-lock.json') {
    const data = JSON.parse(text);
    const g = makeGraph('npm', file);
    let packages = data.packages;
    if (!packages && data.dependencies) {
        // lockfileVersion 1: nested "dependencies" tree -> v2-style paths.
        packages = {};
        const walk = (deps, prefix) => {
            for (const [name, info] of Object.entries(deps || {})) {
                const path = `${prefix}node_modules/${name}`;
                packages[path] = { version: info.version, dev: info.dev, dependencies: info.requires || {} };
                if (info.dependencies) walk(info.dependencies, `${path}/`);
            }
        };
        walk(data.dependencies, '');
    }
    packages = packages || {};
    const idByPath = new Map();
    for (const [path, info] of Object.entries(packages)) {
        if (!path || info.link) continue;
        if (!path.includes('node_modules/')) {
            // A workspace folder (e.g. "packages/web"): local, but its dependencies count.
            const name = info.name || path.split('/').pop();
            idByPath.set(path, g.add(name, info.version || '0.0.0', false, true));
            continue;
        }
        const name = info.name || npmNameFromPath(path);
        if (!name || !info.version || /^(file|link|git|github):/.test(info.resolved || '')) continue;
        idByPath.set(path, g.add(name, info.version, Boolean(info.dev)));
    }
    for (const [path, info] of Object.entries(packages)) {
        // node_modules/<workspace> links resolve to the workspace folder's node.
        if (info.link && info.resolved && idByPath.has(info.resolved)) idByPath.set(path, idByPath.get(info.resolved));
    }
    // Node's lookup: the nearest node_modules/<name> walking up from the requiring package.
    const resolveFrom = (fromPath, name) => {
        let base = fromPath;
        for (;;) {
            const candidate = `${base ? `${base}/` : ''}node_modules/${name}`;
            if (idByPath.has(candidate)) return idByPath.get(candidate);
            if (!base) return null;
            const i = base.lastIndexOf('/node_modules/');
            base = i >= 0 ? base.slice(0, i) : '';
        }
    };
    for (const [path, info] of Object.entries(packages)) {
        const id = idByPath.get(path);
        if (!id || info.link) continue;
        const node = g.nodes.get(id);
        for (const dep of Object.keys({ ...(info.dependencies || {}), ...(info.optionalDependencies || {}) })) {
            const target = resolveFrom(path, dep);
            if (target && target !== id) node.deps.add(target);
        }
        if (node.local) {
            for (const dep of Object.keys(info.devDependencies || {})) {
                const target = resolveFrom(path, dep);
                if (target && target !== id) node.devDeps.add(target);
            }
        }
    }
    g.resolveDirect = (name, spec, manifestDir = '') => {
        const rel = relDir(g.dir, manifestDir);
        return resolveFrom(rel, name) || g.pickByName(name, spec);
    };
    return g;
}

/** manifestDir relative to the lockfile's directory ('' when the same). */
function relDir(lockDir, manifestDir) {
    if (!lockDir) return manifestDir || '';
    if (manifestDir === lockDir) return '';
    return manifestDir.startsWith(`${lockDir}/`) ? manifestDir.slice(lockDir.length + 1) : '';
}

// ------------------------------------------------------------------ npm: yarn.lock (classic + Berry)

/** Splits a yarn descriptor ("@scope/name@^1.0", "name@npm:^1.0") into name and range. */
function yarnDescriptor(desc) {
    const d = unquote(desc);
    const at = d.indexOf('@', d.startsWith('@') ? 1 : 0);
    if (at < 0) return { name: d, range: '' };
    return { name: d.slice(0, at), range: d.slice(at + 1) };
}

export function parseYarnLock(text, file = 'yarn.lock') {
    const g = makeGraph('npm', file);
    const byDescriptor = new Map();
    const entries = [];
    let current = null;
    let section = null;
    for (const raw of String(text).split(/\r?\n/)) {
        if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
        const indent = raw.length - raw.trimStart().length;
        const line = raw.trim();
        if (indent === 0) {
            section = null;
            if (line.startsWith('__metadata')) { current = null; continue; }
            const header = line.replace(/:$/, '');
            // Classic: "a@^1", a@^1.2   Berry: "a@npm:^1, a@npm:^1.2"
            const descriptors = header.replace(/"/g, '').split(/,\s*/).map(d => d.trim()).filter(Boolean);
            current = { descriptors, version: null, deps: [], local: false };
            entries.push(current);
            continue;
        }
        if (!current) continue;
        if (indent === 2) {
            section = null;
            const m = /^([\w-]+):?\s+(.*)$/.exec(line);
            if (/^(dependencies|optionalDependencies):?$/.test(line)) { section = 'deps'; continue; }
        if (/^devDependencies:?$/.test(line)) { section = 'devDeps'; continue; }
            if (m && m[1] === 'version') current.version = unquote(m[2]);
            if (m && m[1] === 'resolution' && /@(workspace|link|portal|file):/.test(unquote(m[2]))) current.local = true;
            continue;
        }
        if (indent >= 4 && (section === 'deps' || section === 'devDeps')) {
            // Classic: name "range"   Berry: name: "npm:range"
            const m = /^("?[^"\s:]+"?|"[^"]+"):?\s+(.+)$/.exec(line);
            if (m) (section === 'deps' ? current.deps : (current.devDeps ||= [])).push(`${unquote(m[1])}@${unquote(m[2])}`);
        }
    }
    for (const e of entries) {
        if (!e.version || e.descriptors.length === 0) continue;
        if (e.local) {
            // Workspace packages: local nodes, reachable from other entries' workspace: descriptors.
            const { name } = yarnDescriptor(e.descriptors[0]);
            e.id = g.add(name, e.version, false, true);
            for (const d of e.descriptors) byDescriptor.set(d, e.id);
            continue;
        }
        const descs = e.descriptors.filter(d => !/@(workspace|link|portal|file):/.test(d));
        if (descs.length === 0) continue;
        const { name } = yarnDescriptor(descs[0]);
        const id = g.add(name.replace(/@patch$/, ''), e.version);
        e.id = id;
        for (const d of descs) byDescriptor.set(d, id);
    }
    const lookup = (desc) => {
        if (byDescriptor.has(desc)) return byDescriptor.get(desc);
        const { name, range } = yarnDescriptor(desc);
        return byDescriptor.get(`${name}@npm:${range}`) || null;
    };
    for (const e of entries) {
        if (!e.id) continue;
        const node = g.nodes.get(e.id);
        for (const d of e.deps) {
            const target = lookup(d);
            if (target && target !== e.id) node.deps.add(target);
        }
        if (node.local) for (const d of e.devDeps || []) {
            const target = lookup(d);
            if (target && target !== e.id) node.devDeps.add(target);
        }
    }
    g.resolveDirect = (name, spec) => lookup(`${name}@${spec}`) || g.pickByName(name, spec);
    return g;
}

// ------------------------------------------------------------------ npm: pnpm-lock.yaml

/** Minimal YAML reader for pnpm lockfiles: nested block maps and scalar values (lists ignored). */
export function parseYamlMaps(text) {
    const root = {};
    const stack = [{ indent: -1, obj: root }];
    for (const raw of String(text).split(/\r?\n/)) {
        if (!raw.trim() || raw.trimStart().startsWith('#') || raw.trimStart().startsWith('- ')) continue;
        const indent = raw.length - raw.trimStart().length;
        const line = raw.trim();
        while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
        const parent = stack[stack.length - 1].obj;
        let key;
        let rest;
        if (line[0] === "'" || line[0] === '"') {
            const end = line.indexOf(line[0], 1);
            if (end < 0) continue;
            key = line.slice(1, end);
            rest = line.slice(end + 1).replace(/^:\s?/, '');
        } else {
            const m = /^([^:]+?):(?:\s+(.*))?$/.exec(line);
            if (!m) continue;
            key = m[1];
            rest = m[2] || '';
        }
        rest = rest.trim();
        if (rest === '') {
            const obj = {};
            parent[key] = obj;
            stack.push({ indent, obj });
        } else {
            parent[key] = unquote(rest);
        }
    }
    return root;
}

export function parsePnpmLock(text, file = 'pnpm-lock.yaml') {
    const g = makeGraph('npm', file);
    // pnpm 10+ can put several YAML documents in one file (e.g. its own tool versions first).
    const docs = String(text).split(/^---\s*$/m).map(parseYamlMaps).filter(d => d && Object.keys(d).length);
    const importers = {};
    const entries = []; // { key, pkg, snap, major }

    for (const doc of docs) {
        const major = parseFloat(doc.lockfileVersion) || 9;
        const keys = new Set([...Object.keys(doc.packages || {}), ...Object.keys(doc.snapshots || {})]);
        for (const key of keys) entries.push({ key, pkg: (doc.packages || {})[key] || {}, snap: (doc.snapshots || {})[key], major });
        // Direct dependencies per workspace ("importers"), or at the root for single projects.
        const imps = doc.importers || (doc.dependencies || doc.devDependencies ? { '.': doc } : {});
        for (const [path, imp] of Object.entries(imps)) {
            const target = importers[path] || (importers[path] = { major, sections: {} });
            for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
                Object.assign(target.sections[section] || (target.sections[section] = {}), imp[section] || {});
            }
        }
    }

    const stripPeers = (v, major) => String(v).replace(/\(.*$/, '').replace(major < 6 ? /_.*$/ : /$^/, '');
    const parseKey = (key, major) => {
        const k = stripPeers(String(key).replace(/^\//, ''), major);
        if (major < 6) {
            const i = k.lastIndexOf('/');
            return i > 0 ? { name: k.slice(0, i), version: k.slice(i + 1) } : null;
        }
        const at = k.lastIndexOf('@');
        return at > 0 ? { name: k.slice(0, at), version: k.slice(at + 1) } : null;
    };
    // A dependency value is a version ("1.2.3(peer@1)"), an alias ("other@1.2.3"), or a link.
    const depId = (name, value, major) => {
        const v = String(value);
        if (/^(link|file|workspace):/.test(v)) return null;
        if (major < 6 && v.startsWith('/')) { const p = parseKey(v, major); return p ? `${p.name}@${p.version}` : null; }
        if (/^@?[^@\d][^@]*@/.test(v)) { const p = parseKey(v, major); return p ? `${p.name}@${p.version}` : null; }
        return `${name}@${stripPeers(v, major)}`;
    };

    for (const e of entries) {
        const p = parseKey(e.key, e.major);
        if (!p || !/^\d/.test(p.version)) continue;
        e.id = g.add(p.name, p.version, e.pkg.dev === 'true');
    }
    for (const e of entries) {
        if (!e.id) continue;
        const source = e.snap || e.pkg;
        for (const section of ['dependencies', 'optionalDependencies']) {
            for (const [dep, value] of Object.entries(source[section] || {})) {
                const target = depId(dep, typeof value === 'object' ? value.version : value, e.major);
                if (target && g.nodes.has(target) && target !== e.id) g.nodes.get(e.id).deps.add(target);
            }
        }
    }
    // Each workspace ("importer") becomes a local node, so its dependencies are followed.
    for (const [path, imp] of Object.entries(importers)) {
        const id = g.add(path === '.' ? '(root)' : path, 'workspace', false, true);
        const node = g.nodes.get(id);
        for (const section of ['dependencies', 'optionalDependencies', 'devDependencies']) {
            for (const [dep, v] of Object.entries(imp.sections[section] || {})) {
                const target = depId(dep, typeof v === 'object' ? v.version : v, imp.major);
                if (target && g.nodes.has(target)) (section === 'devDependencies' ? node.devDeps : node.deps).add(target);
            }
        }
    }
    g.resolveDirect = (name, spec, manifestDir = '') => {
        const imp = importers[relDir(g.dir, manifestDir) || '.'];
        if (imp) {
            for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
                const v = imp.sections[section] && imp.sections[section][name];
                if (v !== undefined) {
                    const target = depId(name, typeof v === 'object' ? v.version : v, imp.major);
                    if (target && g.nodes.has(target)) return target;
                }
            }
        }
        return g.pickByName(name, spec);
    };
    return g;
}

// ------------------------------------------------------------------ TOML [[package]] lockfiles

/** Splits a TOML lockfile into its [[package]] entries: { fields, tables } with raw values. */
export function tomlPackages(text) {
    const out = [];
    let current = null;
    let table = null;
    let pending = null;
    const assign = (line) => {
        const m = /^("?[\w.-]+"?)\s*=\s*([\s\S]*)$/.exec(line);
        if (!m || !current) return;
        const key = unquote(m[1]);
        if (table) (current.tables[table] ||= {})[key] = m[2].trim();
        else current.fields[key] = m[2].trim();
    };
    const depth = s => { let d = 0, q = null; for (const ch of s) { if (q) { if (ch === q) q = null; continue; } if (ch === '"' || ch === "'") q = ch; else if (ch === '[' || ch === '{') d++; else if (ch === ']' || ch === '}') d--; } return d; };
    for (const raw of String(text).split(/\r?\n/)) {
        const line = raw.replace(/^\s+/, '');
        if (pending !== null) {
            pending += ` ${line}`;
            if (depth(pending) <= 0) { assign(pending); pending = null; }
            continue;
        }
        if (!line || line.startsWith('#')) continue;
        if (/^\[\[package\]\]\s*$/.test(line)) { current = { fields: {}, tables: {} }; out.push(current); table = null; continue; }
        const header = /^\[([^\]]+)\]\s*$/.exec(line);
        if (header) {
            const h = header[1].trim();
            if (current && h.startsWith('package.')) table = h.slice('package.'.length);
            else { current = null; table = null; }
            continue;
        }
        if (depth(line) > 0) { pending = line; continue; }
        assign(line);
    }
    return out;
}

const tomlString = v => unquote(String(v || '').trim());
const tomlStrings = v => [...String(v || '').matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => m[1]);

export function parsePoetryLock(text, file = 'poetry.lock') {
    const g = makeGraph('pypi', file);
    const pkgs = tomlPackages(text);
    const ids = new Map();
    for (const p of pkgs) {
        const name = normalizePypiName(tomlString(p.fields.name));
        const version = tomlString(p.fields.version);
        const sourceType = p.tables.source ? tomlString(p.tables.source.type) : '';
        if (!name || !version || ['file', 'git', 'url'].includes(sourceType)) continue;
        // Poetry 1.x: category = "dev"; Poetry 2.x: groups = ["dev", ...]
        const groups = p.fields.groups ? tomlStrings(p.fields.groups) : [tomlString(p.fields.category) || 'main'];
        ids.set(p, g.add(name, version, !groups.includes('main'), sourceType === 'directory'));
    }
    for (const [p, id] of ids) {
        for (const dep of Object.keys(p.tables.dependencies || {})) {
            const target = g.pickByName(normalizePypiName(dep));
            if (target && target !== id) g.nodes.get(id).deps.add(target);
        }
    }
    return g;
}

export function parseUvLock(text, file = 'uv.lock') {
    const g = makeGraph('pypi', file);
    const ids = new Map();
    for (const p of tomlPackages(text)) {
        const name = normalizePypiName(tomlString(p.fields.name));
        const version = tomlString(p.fields.version);
        const source = String(p.fields.source || '');
        if (!name || /\bgit\s*=/.test(source)) continue;
        const local = /\b(editable|virtual|directory|path)\s*=/.test(source);
        if (!version && !local) continue;
        ids.set(p, g.add(name, version || '0.0.0', false, local));
    }
    const depsIn = raw => [...String(raw || '').matchAll(/name\s*=\s*"([^"]+)"(?:\s*,\s*version\s*=\s*"([^"]+)")?/g)]
        .map(d => (d[2] ? `${normalizePypiName(d[1])}@${d[2]}` : g.pickByName(normalizePypiName(d[1]))));
    for (const [p, id] of ids) {
        const node = g.nodes.get(id);
        for (const target of depsIn(p.fields.dependencies)) {
            if (target && g.nodes.has(target) && target !== id) node.deps.add(target);
        }
        if (node.local) for (const raw of Object.values(p.tables['dev-dependencies'] || {})) {
            for (const target of depsIn(raw)) if (target && g.nodes.has(target) && target !== id) node.devDeps.add(target);
        }
    }
    return g;
}

export function parseCargoLock(text, file = 'Cargo.lock') {
    const g = makeGraph('cargo', file);
    const ids = new Map();
    const pkgs = tomlPackages(text);
    for (const p of pkgs) {
        const name = tomlString(p.fields.name);
        const version = tomlString(p.fields.version);
        const source = tomlString(p.fields.source);
        // Workspace crates have no source (local); git crates have no crates.io license data.
        if (!name || !version || (source && !source.startsWith('registry+'))) continue;
        ids.set(p, g.add(name, version, false, !source));
    }
    for (const p of pkgs) {
        const from = ids.get(p) || null;
        for (const dep of tomlStrings(p.fields.dependencies)) {
            const [n, v] = dep.split(' ');
            const target = v
                ? (g.nodes.has(`${n}@${v}`) ? `${n}@${v}` : g.nodes.has(`local:${n}@${v}`) ? `local:${n}@${v}` : null)
                : (g.pickByName(n) || [...g.nodes.keys()].find(k => k.startsWith(`local:${n}@`)) || null);
            if (target && from && target !== from) g.nodes.get(from).deps.add(target);
        }
    }
    return g;
}

export function parsePipfileLock(text, file = 'Pipfile.lock') {
    const data = JSON.parse(text);
    const g = makeGraph('pypi', file);
    g.flat = true; // Pipfile.lock lists packages without their dependency edges
    for (const [section, dev] of [['default', false], ['develop', true]]) {
        for (const [name, info] of Object.entries(data[section] || {})) {
            const v = /^===?\s*(.+)$/.exec(String(info && info.version || ''));
            if (v) g.add(normalizePypiName(name), v[1].trim(), dev);
        }
    }
    return g;
}

/** Parses a lockfile by name; returns null for unknown files. Throws on malformed content. */
export function parseLockfile(path, text) {
    const name = path.split('/').pop();
    switch (name) {
        case 'package-lock.json':
        case 'npm-shrinkwrap.json': return parsePackageLock(text, path);
        case 'yarn.lock': return parseYarnLock(text, path);
        case 'pnpm-lock.yaml': return parsePnpmLock(text, path);
        case 'poetry.lock': return parsePoetryLock(text, path);
        case 'uv.lock': return parseUvLock(text, path);
        case 'Pipfile.lock': return parsePipfileLock(text, path);
        case 'Cargo.lock': return parseCargoLock(text, path);
        default: return null;
    }
}
