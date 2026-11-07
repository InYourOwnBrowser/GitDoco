/**
 * Warning banner rendering and diagnostics message generator.
 */

/**
 * Builds banner items based on system and fetch state.
 *
 * @param {Object} s
 * @param {number} [s.failedThreads]
 * @param {boolean} [s.rateLimited]
 * @param {string} [s.resetTime]
 * @param {boolean} [s.truncatedTree]
 * @param {number} [s.skippedLarge]
 * @param {boolean} [s.redactionOff]
 * @param {number} [s.secretCount]
 * @returns {Array<{ level: 'warn' | 'error', text: string }>}
 */
export function buildBannerItems(s = {}) {
    const items = [];

    if (s.failedThreads > 0 && s.rateLimited) {
        items.push({
            level: 'error',
            text: `GitHub's request limit was reached. Comments for ${s.failedThreads} issue(s) weren't loaded. Add a token or retry${s.resetTime ? ' after ' + s.resetTime : ''}.`
        });
    } else if (s.failedThreads > 0 && !s.rateLimited) {
        items.push({
            level: 'error',
            text: `Comments could not be loaded for ${s.failedThreads} issue(s). See Details, then retry.`
        });
    }

    if (s.truncatedTree) {
        items.push({
            level: 'warn',
            text: 'This repository is very large, so GitHub returned a partial file list.'
        });
    }

    if (s.skippedLarge > 0) {
        items.push({
            level: 'warn',
            text: `${s.skippedLarge} large file(s) were skipped. Raise "Max file size (KB)" to include them.`
        });
    }

    if (s.redactionOff && s.secretCount > 0) {
        items.push({
            level: 'warn',
            text: `Secret hiding is off and ${s.secretCount} possible secret(s) were found.`
        });
    }

    return items;
}

/**
 * Renders banner items into a DOM container.
 *
 * @param {HTMLElement} el
 * @param {Array<{ level: 'warn' | 'error', text: string }>} items
 */
export function renderBanner(el, items = []) {
    if (!el) return;
    el.innerHTML = '';
    if (!items || items.length === 0) {
        el.style.display = 'none';
        return;
    }

    el.style.display = 'flex';
    for (const item of items) {
        const div = document.createElement('div');
        div.className = `banner-item ${item.level}`;
        div.textContent = item.text;
        if (item.action && typeof item.action.onClick === 'function') {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'secondary btn-xs banner-action';
            btn.textContent = item.action.label;
            btn.addEventListener('click', item.action.onClick);
            div.appendChild(btn);
        }
        el.appendChild(div);
    }
}
