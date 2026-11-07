/**
 * Navigation helpers between the Code, Issues and Discussions tabs.
 */

/**
 * Builds the destination URL when navigating between tabs.
 *
 * @param {'code'|'issues'|'discussions'|'deps'} page - Target page identifier.
 * @param {string} [repoText] - Current repository input text (e.g. "owner/repo" or GitHub URL).
 * @returns {string} The relative URL to the destination page, including the ?repo= parameter if repoText is present.
 */
export function buildTabHref(page, repoText) {
    const pages = { code: 'code.html', issues: 'issues.html', discussions: 'discussions.html', deps: 'deps.html' };
    const base = pages[page] || 'issues.html';
    const trimmed = (repoText || '').trim();
    if (!trimmed) {
        return base;
    }
    return `${base}?repo=${encodeURIComponent(trimmed)}`;
}

/**
 * A GitDoco shortcut link (github.com swapped for GitDoco's domain, see js/repo-route.js) carries
 * go=1: start loading the repo straight away. The one-time notice before the first request still
 * comes first (the load button shows it). "go" is then dropped from the address bar, so reloading
 * or sharing the page doesn't load again unasked.
 */
export function startFromShortcut(loadButton, repoInput) {
    if (typeof window === 'undefined' || !window.location) return false;
    const params = new URLSearchParams(window.location.search);
    if (params.get('go') !== '1') return false;
    params.delete('go');
    try {
        const query = params.toString();
        window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
    } catch (_) {}
    if (!loadButton || !repoInput || !String(repoInput.value || '').trim()) return false;
    setTimeout(() => loadButton.click(), 0);
    return true;
}
