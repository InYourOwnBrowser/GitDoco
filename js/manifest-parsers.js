/**
 * Reads direct dependencies from manifest files: package.json (npm), requirements*.txt,
 * pyproject.toml and Pipfile (PyPI), go.mod (Go) and Cargo.toml (Cargo). Manifests of other
 * ecosystems are recognised (UNSUPPORTED_PATTERNS) so the report can say what it did not check.
 *
 * The TOML readers are deliberately narrow line-based parsers for the dependency sections only
 * (the project has no third-party dependencies, so no TOML library). They handle the common
 * forms; anything they do not understand is skipped rather than guessed.
 *
 * Each dependency: { ecosystem, name, spec, version, versionKind, dev, indirect, manifest }
 *   version      exact version when the manifest gives one, the lowest version a range allows
 *                (npm/Cargo "^1.2.3" -> 1.2.3), else null (resolved to the latest release later)
 *   versionKind  'exact' | 'range-min' | 'latest'
 */

const SEMVER = /(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/;

const MANIFEST_PATTERNS = [
    { ecosystem: 'npm', test: name => name === 'package.json' },
    { ecosystem: 'pypi', test: name => /^(requirements[\w.-]*|[\w.-]*requirements)\.txt$/i.test(name) },
    { ecosystem: 'pypi', test: name => name === 'pyproject.toml' },
    { ecosystem: 'go', test: name => name === 'go.mod' },
    { ecosystem: 'cargo', test: name => name === 'Cargo.toml' },
    { ecosystem: 'pypi', test: name => name === 'Pipfile' },
    // Lockfiles: exact versions and the real transitive tree (js/lockfiles.js).
    { ecosystem: 'npm', kind: 'lock', test: name => ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml'].includes(name) },
    { ecosystem: 'pypi', kind: 'lock', test: name => ['poetry.lock', 'uv.lock', 'Pipfile.lock'].includes(name) },
    { ecosystem: 'cargo', kind: 'lock', test: name => name === 'Cargo.lock' }
];

// Package manifests of ecosystems this tool does not read. Listing them lets the report warn that
// it is incomplete instead of looking complete.
const UNSUPPORTED_PATTERNS = [
    { ecosystem: 'Maven', test: name => name === 'pom.xml' },
    { ecosystem: 'Gradle', test: name => /^build\.gradle(\.kts)?$/.test(name) },
    { ecosystem: 'RubyGems', test: name => name === 'Gemfile' || /\.gemspec$/.test(name) },
    { ecosystem: 'Composer (PHP)', test: name => name === 'composer.json' },
    { ecosystem: 'NuGet (.NET)', test: name => /\.(cs|fs|vb)proj$/.test(name) || name === 'packages.config' || name === 'Directory.Packages.props' },
    { ecosystem: 'Swift Package Manager', test: name => name === 'Package.swift' },
    { ecosystem: 'CocoaPods', test: name => name === 'Podfile' },
    { ecosystem: 'Pub (Dart/Flutter)', test: name => name === 'pubspec.yaml' },
    { ecosystem: 'Hex (Elixir)', test: name => name === 'mix.exs' },
    { ecosystem: 'Conan / vcpkg (C/C++)', test: name => name === 'conanfile.txt' || name === 'conanfile.py' || name === 'vcpkg.json' },
    // setup.py / setup.cfg are only reported when the folder has no manifest that is read.
    { ecosystem: 'Python setup.py / setup.cfg', test: name => name === 'setup.py' || name === 'setup.cfg', pythonFallback: true }
];

const SKIP_DIRS = new Set(['node_modules', 'vendor', 'third_party', 'third-party', '.git', 'dist', 'build', 'target', '.venv', 'venv', 'site-packages', 'bower_components', 'jspm_packages']);
const EXAMPLE_DIRS = /^(examples?|samples?|demos?|tests?|__tests__|testdata|fixtures?|docs?|benchmarks?|e2e)$/i;

/**
 * Picks manifest files from a list of repository paths.
 * @param {string[]} paths
 * @param {{ skipExamples?: boolean, max?: number }} opts
 */
export function findManifestPaths(paths, { skipExamples = true, max = 60 } = {}) {
    const found = [];
    const unsupported = [];
    for (const path of paths) {
        // A license policy committed at the repository root (js/license-policy.js).
        if (path === '.gitdoco-policy.json') { found.push({ path, ecosystem: null, kind: 'policy' }); continue; }
        const parts = path.split('/');
        const name = parts[parts.length - 1];
        const dirs = parts.slice(0, -1);
        if (dirs.some(d => SKIP_DIRS.has(d) || d.startsWith('.'))) continue;
        if (skipExamples && dirs.some(d => EXAMPLE_DIRS.test(d))) continue;
        const pattern = MANIFEST_PATTERNS.find(p => p.test(name));
        if (pattern) { found.push({ path, ecosystem: pattern.ecosystem, kind: pattern.kind || 'manifest' }); continue; }
        const other = UNSUPPORTED_PATTERNS.find(p => p.test(name));
        if (other) unsupported.push({ path, ecosystem: other.ecosystem, pythonFallback: Boolean(other.pythonFallback) });
    }
    // Shallow manifests first: the root project matters most if we hit the cap.
    found.sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path));
    const dirOf = p => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
    const pythonDirs = new Set(found.filter(m => m.ecosystem === 'pypi').map(m => dirOf(m.path)));
    return {
        manifests: found.slice(0, max),
        skipped: Math.max(0, found.length - max),
        unsupported: unsupported
            .filter(u => !u.pythonFallback || !pythonDirs.has(dirOf(u.path)))
            .map(({ path, ecosystem }) => ({ path, ecosystem }))
            .sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path))
    };
}

/**
 * One sentence naming the ecosystems that were found but not checked, e.g.
 * "Not checked: Maven (pom.xml) and RubyGems (Gemfile, api/Gemfile). ..." Empty when none.
 */
export function unsupportedText(unsupported) {
    if (!unsupported || !unsupported.length) return '';
    const byEco = new Map();
    for (const u of unsupported) {
        if (!byEco.has(u.ecosystem)) byEco.set(u.ecosystem, []);
        byEco.get(u.ecosystem).push(u.path);
    }
    const parts = [...byEco].map(([eco, list]) => `${eco} (${list.slice(0, 3).join(', ')}${list.length > 3 ? `, +${list.length - 3} more` : ''})`);
    const joined = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
    return `Not checked: ${joined}. These package managers are not supported yet, so this report does not cover their dependencies.`;
}

function versionFromSpec(spec, { pep440 = false } = {}) {
    const s = String(spec || '').trim();
    if (pep440) {
        const exact = /^===?\s*([0-9][0-9A-Za-z.+!-]*)$/.exec(s.split(',')[0].trim());
        if (exact && !exact[1].includes('*')) return { version: exact[1], versionKind: 'exact' };
        return { version: null, versionKind: 'latest' };
    }
    const m = SEMVER.exec(s);
    if (!m) return { version: null, versionKind: 'latest' };
    const isExact = new RegExp(`^[=v\\s]*${m[0].replace(/[.+]/g, '\\$&')}$`).test(s);
    return { version: m[0], versionKind: isExact ? 'exact' : 'range-min' };
}

/** PEP 503 name normalisation, as used by PyPI and deps.dev. */
export function normalizePypiName(name) {
    return String(name).toLowerCase().replace(/[-_.]+/g, '-');
}

function dep(ecosystem, name, spec, manifest, extra = {}) {
    const v = versionFromSpec(spec, { pep440: ecosystem === 'pypi' && !extra.poetry });
    // In Cargo a bare version ("1.0.200") is a caret requirement; only "=1.0.200" is exact.
    if (ecosystem === 'cargo' && v.versionKind === 'exact' && !/^\s*=/.test(String(spec))) v.versionKind = 'range-min';
    return { ecosystem, name, spec: String(spec || '').trim(), ...v, dev: Boolean(extra.dev), indirect: Boolean(extra.indirect), manifest };
}

// ------------------------------------------------------------------ npm

export function parsePackageJson(text, manifest = 'package.json') {
    let data;
    try { data = JSON.parse(text); } catch (_) { return { deps: [], name: null, error: 'Invalid JSON' }; }
    const deps = [];
    const sections = [['dependencies', false], ['optionalDependencies', false], ['devDependencies', true]];
    for (const [key, dev] of sections) {
        const obj = data && typeof data[key] === 'object' ? data[key] : null;
        if (!obj) continue;
        for (let [name, spec] of Object.entries(obj)) {
            spec = String(spec || '').trim();
            // Local, workspace and VCS dependencies have no registry license to look up.
            if (/^(workspace:|file:|link:|portal:|git\+|git:|github:|gitlab:|bitbucket:|https?:|\.{0,2}\/)/.test(spec) || /^[\w.-]+\/[\w.-]+(#.*)?$/.test(spec)) continue;
            const alias = /^npm:(@?[^@]+)@?(.*)$/.exec(spec);
            if (alias) { name = alias[1]; spec = alias[2] || ''; }
            deps.push(dep('npm', name, spec, manifest, { dev }));
        }
    }
    return { deps, name: data && typeof data.name === 'string' ? data.name : null };
}

// ------------------------------------------------------------------ PyPI

/** Parses one PEP 508 requirement ("name[extra]>=1.0; marker"). Returns null for URLs and options. */
export function parseRequirement(line) {
    let s = String(line || '').replace(/\s+#.*$/, '').trim();
    if (!s || s.startsWith('#') || s.startsWith('-') || /:\/\//.test(s) || /\s@\s/.test(s)) return null;
    s = s.split(';')[0].trim();
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*(.*)$/.exec(s);
    if (!m) return null;
    return { name: normalizePypiName(m[1]), spec: m[3].replace(/^\(|\)$/g, '').trim() };
}

export function parseRequirementsTxt(text, manifest = 'requirements.txt') {
    const dev = /(dev|test|lint|doc)/i.test(manifest.split('/').pop());
    const deps = [];
    for (const raw of String(text).split(/\r?\n/)) {
        const r = parseRequirement(raw);
        if (r) deps.push(dep('pypi', r.name, r.spec, manifest, { dev }));
    }
    return { deps };
}

/** Splits TOML into [section] -> lines (comments stripped); multi-line arrays are joined. */
function tomlSections(text) {
    const sections = new Map();
    let current = '';
    sections.set(current, []);
    let pending = null;
    for (const raw of String(text).split(/\r?\n/)) {
        const line = raw.replace(/(^|\s)#.*$/, '').trim();
        if (pending !== null) {
            pending += ' ' + line;
            if (/\]\s*,?\s*$/.test(line) && balanced(pending)) { sections.get(current).push(pending); pending = null; }
            continue;
        }
        if (!line) continue;
        const header = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(line);
        if (header) {
            current = header[1].replace(/\s+/g, '');
            if (!sections.has(current)) sections.set(current, []);
            continue;
        }
        if (/=\s*\[/.test(line) && !balanced(line)) { pending = line; continue; }
        sections.get(current).push(line);
    }
    return sections;
}

function balanced(s) {
    let depth = 0;
    let quote = null;
    for (const ch of s) {
        if (quote) { if (ch === quote) quote = null; continue; }
        if (ch === '"' || ch === "'") quote = ch;
        else if (ch === '[' || ch === '{') depth++;
        else if (ch === ']' || ch === '}') depth--;
    }
    return depth <= 0;
}

const quotedStrings = s => [...String(s).matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map(m => m[1] ?? m[2]);

function keyValue(line) {
    const m = /^("?[\w.-]+"?)\s*=\s*(.+)$/.exec(line);
    return m ? { key: m[1].replace(/"/g, ''), value: m[2].trim() } : null;
}

function inlineField(value, field) {
    const m = new RegExp(`(?:^|[{,\\s])${field}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(value);
    return m ? (m[2] ?? m[3]) : null;
}

export function parsePyprojectToml(text, manifest = 'pyproject.toml') {
    const sections = tomlSections(text);
    const deps = [];
    for (const line of sections.get('project') || []) {
        const kv = keyValue(line);
        if (kv && kv.key === 'dependencies') {
            for (const req of quotedStrings(kv.value)) {
                const r = parseRequirement(req);
                if (r) deps.push(dep('pypi', r.name, r.spec, manifest));
            }
        }
    }
    for (const [section, lines] of sections) {
        const poetryMain = section === 'tool.poetry.dependencies';
        const poetryDev = section === 'tool.poetry.dev-dependencies' || /^tool\.poetry\.group\.[^.]+\.dependencies$/.test(section);
        if (!poetryMain && !poetryDev) continue;
        for (const line of lines) {
            const kv = keyValue(line);
            if (!kv || kv.key.toLowerCase() === 'python') continue;
            let spec;
            if (kv.value.startsWith('{')) {
                if (/\b(path|git|url)\s*=/.test(kv.value)) continue;
                spec = inlineField(kv.value, 'version');
            } else {
                spec = quotedStrings(kv.value)[0];
            }
            if (spec === null || spec === undefined) continue;
            deps.push(dep('pypi', normalizePypiName(kv.key), spec, manifest, { dev: poetryDev, poetry: true }));
        }
    }
    return { deps };
}

// ------------------------------------------------------------------ Go

export function parseGoMod(text, manifest = 'go.mod') {
    const deps = [];
    let inBlock = false;
    let module = null;
    for (const raw of String(text).split(/\r?\n/)) {
        const indirect = /\/\/\s*indirect\b/.test(raw);
        const line = raw.replace(/\/\/.*$/, '').trim();
        if (!line) continue;
        const mod = /^module\s+(\S+)/.exec(line);
        if (mod) { module = mod[1]; continue; }
        if (/^require\s*\($/.test(line)) { inBlock = true; continue; }
        if (inBlock && line === ')') { inBlock = false; continue; }
        const single = /^require\s+(\S+)\s+(\S+)$/.exec(line);
        const inside = inBlock ? /^(\S+)\s+(\S+)$/.exec(line) : null;
        const m = single || inside;
        if (m) deps.push({ ecosystem: 'go', name: m[1], spec: m[2], version: m[2], versionKind: 'exact', dev: false, indirect, manifest });
    }
    return { deps, name: module };
}

// ------------------------------------------------------------------ Cargo

export function parseCargoToml(text, manifest = 'Cargo.toml') {
    const sections = tomlSections(text);
    const deps = [];
    const kindOf = section => {
        if (section === 'dependencies' || section === 'workspace.dependencies') return 'main';
        if (section === 'dev-dependencies' || section === 'build-dependencies') return 'dev';
        const t = /^target\..+\.((?:dev-|build-)?dependencies)$/.exec(section); // [target.'cfg(unix)'.dependencies]
        if (t) return t[1] === 'dependencies' ? 'main' : 'dev';
        return null;
    };
    for (const [section, lines] of sections) {
        // [dependencies.serde] style: one table per crate.
        const table = /^((?:workspace\.)?(?:dev-|build-)?dependencies)\.("?[\w-]+"?)$/.exec(section);
        if (table) {
            const kind = kindOf(table[1]);
            const fields = Object.fromEntries(lines.map(keyValue).filter(Boolean).map(kv => [kv.key, quotedStrings(kv.value)[0] ?? kv.value]));
            if (fields.path || fields.git || fields.workspace === 'true') continue;
            const name = fields.package || table[2].replace(/"/g, '');
            if (fields.version) deps.push(dep('cargo', name, fields.version, manifest, { dev: kind === 'dev' }));
            continue;
        }
        const kind = kindOf(section);
        if (!kind) continue;
        for (const line of lines) {
            const kv = keyValue(line);
            if (!kv || kv.key.endsWith('.workspace')) continue;
            let name = kv.key;
            let spec;
            if (kv.value.startsWith('{')) {
                if (/\b(path|git)\s*=/.test(kv.value) || /\bworkspace\s*=\s*true/.test(kv.value)) continue;
                spec = inlineField(kv.value, 'version');
                name = inlineField(kv.value, 'package') || name;
            } else {
                spec = quotedStrings(kv.value)[0];
            }
            if (!spec) continue;
            deps.push(dep('cargo', name, spec, manifest, { dev: kind === 'dev' }));
        }
    }
    let name = null;
    for (const line of sections.get('package') || []) {
        const kv = keyValue(line);
        if (kv && kv.key === 'name') name = quotedStrings(kv.value)[0] || null;
    }
    return { deps, name };
}

/** Pipfile ([packages] and [dev-packages]); Pipfile.lock supplies exact versions when present. */
export function parsePipfile(text, manifest = 'Pipfile') {
    const sections = tomlSections(text);
    const deps = [];
    for (const [section, dev] of [['packages', false], ['dev-packages', true]]) {
        for (const line of sections.get(section) || []) {
            const kv = keyValue(line);
            if (!kv) continue;
            let spec;
            if (kv.value.startsWith('{')) {
                if (/\b(path|git|file|editable)\s*=/.test(kv.value)) continue;
                spec = inlineField(kv.value, 'version') || '';
            } else {
                spec = quotedStrings(kv.value)[0] || '';
            }
            deps.push(dep('pypi', normalizePypiName(kv.key), spec === '*' ? '' : spec, manifest, { dev }));
        }
    }
    return { deps };
}

/** Parses any supported manifest by file name. */
export function parseManifest(path, text) {
    const name = path.split('/').pop();
    if (name === 'package.json') return parsePackageJson(text, path);
    if (name === 'pyproject.toml') return parsePyprojectToml(text, path);
    if (name === 'go.mod') return parseGoMod(text, path);
    if (name === 'Cargo.toml') return parseCargoToml(text, path);
    if (name === 'Pipfile') return parsePipfile(text, path);
    if (/\.txt$/i.test(name)) return parseRequirementsTxt(text, path);
    return { deps: [] };
}
