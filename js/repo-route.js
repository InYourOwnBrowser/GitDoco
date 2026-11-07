/**
 * GitHub URL shortcut: replace "github.com" with GitDoco's domain in a repository URL and land in
 * the matching tool, e.g. github.com/facebook/react/issues -> gitdoco.timedoco.com/facebook/react/issues.
 *
 * The site is static, so such paths are served 404.html by the host (Cloudflare Pages, Netlify and
 * GitHub Pages all do this); js/not-found.js asks this module where the path should go.
 *
 *   /owner/repo                                   a page to pick a tool for the repo
 *   /owner/repo/issues[/...]                      Issues
 *   /owner/repo/pulls[/...]                       Issues, pull requests only
 *   /owner/repo/pull/123[/...]                    Dependencies, comparing pull request #123 with its base
 *   /owner/repo/compare/base...head               Dependencies, comparing head with base
 *   /owner/repo/discussions[/...]                 Discussions
 *   /owner/repo/tree|blob/<ref>[/<path>]          Code, at that branch (and folder)
 *   /owner/repo/commit/<sha>                      Code, at that commit
 *   /owner/repo/network/dependencies, /security   Dependencies
 *   /owner/repo/graph                             Dependencies, opening the dependency graph
 *   /owner/repo/<anything else>                   the pick-a-tool page
 *
 * Links from a shortcut carry go=1: the tool starts loading the repo (after the one-time notice).
 * Owner and repository names are checked against GitHub's rules, so nothing else is passed on.
 */

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
// First path segments that are GitHub site pages, not owners. (GitDoco's own folders such as js/
// and css/ are not listed: they are also valid account names, and their files never reach 404.html.)
const NOT_OWNERS = new Set([
    'about', 'apps', 'collections', 'contact', 'enterprise', 'events', 'explore', 'features', 'login', 'logout',
    'marketplace', 'new', 'notifications', 'orgs', 'organizations', 'pricing', 'pulls', 'issues', 'search',
    'settings', 'sponsors', 'topics', 'trending', 'users'
]);

function decode(segment) {
    try { return decodeURIComponent(segment); } catch (_) { return null; }
}

function link(page, params) {
    const q = new URLSearchParams({ ...params, go: '1' });
    // Root-absolute: this runs on the 404 page, which is served at /owner/repo/....
    return `/${page}?${q.toString()}`;
}

/**
 * Where a path on GitDoco's domain should go.
 * @returns {{ href: string, tool: string, repo: string } | { hub: true, repo: string } | null}
 *   null when the path is not a repository (a genuine "page not found").
 */
export function routeFor(pathname) {
    const parts = String(pathname || '').split('/').filter(Boolean).map(decode);
    if (parts.length < 2 || parts.some(p => p === null)) return null;
    const [owner, rawRepo, section, ...rest] = parts;
    const repoName = rawRepo.replace(/\.git$/i, '');
    if (NOT_OWNERS.has(owner.toLowerCase()) || !OWNER.test(owner)) return null;
    if (!REPO.test(repoName) || repoName === '.' || repoName === '..' || /\.html?$/i.test(repoName)) return null;
    const repo = `${owner}/${repoName}`;
    const github = `https://github.com/${owner}/${repoName}`;

    switch ((section || '').toLowerCase()) {
        case 'issues':
            return { tool: 'issues', repo, href: link('issues.html', { repo, includePrs: 'issues' }) };
        case 'pulls':
            return { tool: 'issues', repo, href: link('issues.html', { repo, includePrs: 'prs' }) };
        case 'pull': {
            const n = /^\d{1,7}$/.test(rest[0] || '') ? rest[0] : null;
            return n
                ? { tool: 'deps', repo, href: link('deps.html', { repo, compare: `#${n}` }) }
                : { tool: 'issues', repo, href: link('issues.html', { repo, includePrs: 'prs' }) };
        }
        case 'compare': {
            // base...head (or base..head); a lone ref is compared with the default branch.
            const spec = rest.join('/');
            const m = /^(.+?)\.{2,3}(.+)$/.exec(spec);
            const base = m ? m[1] : '';
            const head = m ? m[2] : spec;
            if (!head) return { tool: 'deps', repo, href: link('deps.html', { repo }) };
            return { tool: 'deps', repo, href: link('deps.html', { repo, compare: head.slice(0, 250), ...(base ? { base: base.slice(0, 250) } : {}) }) };
        }
        case 'discussions':
            return { tool: 'discussions', repo, href: link('discussions.html', { repo }) };
        case 'tree':
        case 'blob':
        case 'commit': {
            if (!rest.length) return { tool: 'code', repo, href: link('code.html', { repo }) };
            // A file (blob) opens its folder; the Code tool resolves branch names that contain "/".
            // /blob/<ref> with no file keeps the ref.
            const tail = section.toLowerCase() === 'blob' && rest.length > 1 ? rest.slice(0, -1) : rest;
            const target = `${github}/tree/${tail.map(encodeURIComponent).join('/')}`;
            return { tool: 'code', repo, href: link('code.html', { repo: target }) };
        }
        case 'graph':
            return { tool: 'deps', repo, href: link('deps.html', { repo, view: 'graph' }) };
        case 'network':
        case 'security':
            return { tool: 'deps', repo, href: link('deps.html', { repo }) };
        default:
            return { hub: true, repo };
    }
}

/** Shortcut links for the pick-a-tool page. */
export function toolLinks(repo) {
    return {
        deps: link('deps.html', { repo }),
        issues: link('issues.html', { repo, includePrs: 'issues' }),
        discussions: link('discussions.html', { repo }),
        code: link('code.html', { repo })
    };
}
