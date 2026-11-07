/**
 * Builds outbound links (GitHub files and threads, package registries, deps.dev, advisories).
 *
 * Every URL is https:// to a fixed host, and every path segment that comes from repository data
 * is URL-encoded, so data from a repo or an API can never change the scheme, the host or the
 * path structure of a link.
 */
import { isSafeBranchName } from './github-api.js';

const enc = encodeURIComponent;
const encPath = p => String(p).split('/').map(enc).join('/');
const OWNER_RE = /^[A-Za-z0-9_-]+$/;
const REPO_RE = /^[A-Za-z0-9_.-]+$/;

/** https://github.com/{owner}/{repo}/blob/{branch}/{path}, or null if any part is unsafe. */
export function githubFileUrl(owner, repo, branch, path) {
    if (!OWNER_RE.test(owner || '') || !REPO_RE.test(repo || '') || !isSafeBranchName(branch) || !path) return null;
    if (String(path).split('/').some(seg => !seg || seg === '.' || seg === '..')) return null;
    return `https://github.com/${owner}/${repo}/blob/${encPath(branch)}/${encPath(path)}`;
}

/** True for a URL that may be used as a link to a GitHub page (issues, discussions, files). */
export function isGithubUrl(url) {
    return typeof url === 'string' && /^https:\/\/github\.com\/[^\s"'<>]+$/.test(url);
}

// npm scoped names keep their "@" ("@babel/core"); everything else is encoded per segment.
const npmName = name => encPath(name).replace(/^%40/, '@');

/** The package's page on its registry (npm, PyPI, pkg.go.dev, crates.io). */
export function registryUrl(ecosystem, name, version) {
    if (!name) return null;
    const v = version ? String(version) : '';
    switch (ecosystem) {
        case 'npm': return `https://www.npmjs.com/package/${npmName(name)}${v ? `/v/${enc(v)}` : ''}`;
        case 'pypi': return `https://pypi.org/project/${enc(name)}/${v ? `${enc(v)}/` : ''}`;
        case 'go': return `https://pkg.go.dev/${encPath(name)}${v ? `@${enc(v)}` : ''}`;
        case 'cargo': return `https://crates.io/crates/${enc(name)}${v ? `/${enc(v)}` : ''}`;
        default: return null;
    }
}

const DEPS_DEV_SYSTEMS = { npm: 'npm', pypi: 'pypi', go: 'go', cargo: 'cargo' };

/** The package version's page on deps.dev (licenses, dependencies, advisories). */
export function depsDevUrl(ecosystem, name, version) {
    const system = DEPS_DEV_SYSTEMS[ecosystem];
    if (!system || !name) return null;
    return `https://deps.dev/${system}/${enc(name)}${version ? `/${enc(version)}` : ''}`;
}

/** GitHub advisory pages for GHSA IDs; OSV for other IDs (CVE, PYSEC, RUSTSEC, GO, ...). */
export function advisoryUrl(id) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,80}$/.test(id || '')) return null;
    return /^GHSA-/i.test(id) ? `https://github.com/advisories/${enc(id)}` : `https://osv.dev/vulnerability/${enc(id)}`;
}

const ICON = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7"></path><path d="M8 7h9v9"></path></svg>';

/**
 * An <a> that opens in a new tab without giving the new page access to this one, and that does
 * not trigger the row it sits in (row clicks toggle selection).
 */
export function externalLink(href, text, { title = '', className = 'ext-link', icon = true, focusable = true } = {}) {
    const a = document.createElement('a');
    a.className = className;
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    if (title) { a.title = title; a.setAttribute('aria-label', title); }
    if (!focusable) a.tabIndex = -1;
    if (text) {
        const span = document.createElement('span');
        span.textContent = text;
        a.appendChild(span);
    }
    if (icon) a.insertAdjacentHTML('beforeend', ICON);
    a.addEventListener('click', (e) => e.stopPropagation());
    a.addEventListener('keydown', (e) => e.stopPropagation());
    return a;
}
