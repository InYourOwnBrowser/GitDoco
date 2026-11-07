/**
 * One-time notice shown the first time a tool is about to contact another service (GitHub,
 * deps.dev). The user continues only after accepting the Terms and acknowledging the Privacy
 * notice; the choice is remembered in this browser.
 *
 * Bump NOTICE_VERSION when the notice changes materially (for example if analytics or
 * advertising are ever added): everyone is asked again.
 */
export const NOTICE_VERSION = 1;
export const NOTICE_KEY = 'cfg_notice_accepted';

const SERVICES = {
    github: 'GitHub',
    deps: 'GitHub and deps.dev (run by Google)',
    depsZip: 'deps.dev (run by Google)'
};

export function hasAcceptedNotice() {
    try {
        return Number(localStorage.getItem(NOTICE_KEY)) >= NOTICE_VERSION;
    } catch (_) {
        return false;
    }
}

function rememberAcceptance() {
    try { localStorage.setItem(NOTICE_KEY, String(NOTICE_VERSION)); } catch (_) {}
}

function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    for (const c of children) node.append(c);
    return node;
}

const link = (href, text) => el('a', { href, target: '_blank', rel: 'noopener noreferrer', textContent: text });

/**
 * Resolves true when the user may go ahead (already accepted, or accepts now), false if they
 * cancel. `services` is one of 'github' | 'deps' | 'depsZip'.
 */
export function confirmFirstUse(services = 'github') {
    if (hasAcceptedNotice()) return Promise.resolve(true);
    const dialog = document.createElement('dialog');
    // Every current browser supports <dialog>; without it (very old browsers, test DOMs) the
    // notice cannot be shown, and the links on every page still lead to the Privacy and Terms.
    if (typeof dialog.showModal !== 'function') return Promise.resolve(true);

    const who = SERVICES[services] || SERVICES.github;
    dialog.className = 'first-use-dialog';
    dialog.setAttribute('aria-labelledby', 'firstUseTitle');
    const accept = el('input', { type: 'checkbox', id: 'firstUseAccept' });
    const continueBtn = el('button', { type: 'button', className: 'primary', textContent: 'Continue', disabled: true });
    const cancelBtn = el('button', { type: 'button', className: 'secondary', textContent: 'Cancel' });
    dialog.append(
        el('h2', { id: 'firstUseTitle', textContent: 'Before you load a repository' }),
        el('p', {}, [`GitDoco has no server. Your browser will connect directly to ${who} to fetch what you ask for. Those services see your IP address and what you look up, under their own privacy policies.`]),
        el('p', {}, ['Repository content is untrusted and secret hiding is best-effort. Check the output before you paste it into an AI service, whose own terms then apply.']),
        el('label', { className: 'first-use-accept' }, [accept, el('span', {}, ['I accept the ', link('terms.html', 'Terms of Use'), ' and have read the ', link('privacy.html', 'Privacy notice'), '.'])]),
        el('div', { className: 'first-use-actions' }, [cancelBtn, continueBtn])
    );
    document.body.appendChild(dialog);

    return new Promise(resolve => {
        const finish = (ok) => {
            if (ok) rememberAcceptance();
            dialog.close();
            dialog.remove();
            resolve(ok);
        };
        accept.addEventListener('change', () => { continueBtn.disabled = !accept.checked; });
        continueBtn.addEventListener('click', () => finish(true));
        cancelBtn.addEventListener('click', () => finish(false));
        dialog.addEventListener('cancel', (e) => { e.preventDefault(); finish(false); }); // Escape
        dialog.showModal();
        accept.focus();
    });
}
