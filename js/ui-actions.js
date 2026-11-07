/**
 * Shared actions for the tool pages:
 *
 *   showCopyHint   after Copy: "Copied. Now paste it into Claude." with a link that opens the AI
 *                  (a plain link: nothing is sent to it, the user pastes)
 *   initShortcuts  Ctrl/Cmd+Enter runs the main step (Load, or Build once loaded);
 *                  Ctrl/Cmd+Shift+Enter copies. (Ctrl+Shift+C would clash with the browsers'
 *                  developer tools.)
 */
import { externalLink } from './links.js';

export const AI_APPS = {
    claude: { label: 'Claude', url: 'https://claude.ai/new' },
    chatgpt: { label: 'ChatGPT', url: 'https://chatgpt.com/' },
    gemini: { label: 'Gemini', url: 'https://gemini.google.com/app' }
};

/** The hint's text for a copy of part `part` (1-based) of `parts` for the chosen AI. */
export function copyHintText(targetKey, part = 1, parts = 1) {
    const app = AI_APPS[targetKey];
    const where = app ? app.label : 'your AI';
    if (parts > 1 && part < parts) return `Copied part ${part} of ${parts}. Paste it into ${where}, then copy the next part.`;
    if (parts > 1) return `Copied the last part (${part} of ${parts}). Paste it into ${where}.`;
    return `Copied. Now paste it into ${where}.`;
}

let hideTimer = null;

/**
 * Shows the hint under the output pane's header (next to the Copy button).
 * @param {HTMLElement} copyButton
 * @param {string} targetKey claude | chatgpt | gemini | custom
 */
export function showCopyHint(copyButton, targetKey, { part = 1, parts = 1 } = {}) {
    if (typeof document === 'undefined' || !copyButton || typeof copyButton.closest !== 'function') return;
    const header = copyButton.closest('.pane-header');
    if (!header || !header.parentNode) return;
    let hint = document.getElementById('copyHint');
    if (!hint) {
        hint = document.createElement('div');
        hint.id = 'copyHint';
        hint.className = 'copy-hint';
        hint.setAttribute('role', 'status');
        header.insertAdjacentElement('afterend', hint);
    }
    hint.textContent = '';
    const text = document.createElement('span');
    text.textContent = copyHintText(targetKey, part, parts);
    hint.appendChild(text);
    const app = AI_APPS[targetKey];
    if (app) hint.appendChild(externalLink(app.url, `Open ${app.label}`, { className: 'copy-hint-link', title: `Opens ${app.label} in a new tab. Nothing is sent to it: you paste.` }));
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'copy-hint-close';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '×';
    close.addEventListener('click', () => hideCopyHint());
    hint.appendChild(close);
    hint.hidden = false;
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(hideCopyHint, 20000);
}

export function hideCopyHint() {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    const hint = typeof document !== 'undefined' ? document.getElementById('copyHint') : null;
    if (hint) hint.hidden = true;
}

/**
 * Keyboard shortcuts. `main()` returns the button for the current step (Load before anything is
 * loaded, Build after), decided by the page's state rather than visibility: on phones the Build
 * button is hidden, and guessing from visibility would reload the repo instead.
 */
export function initShortcuts({ main, copy, mainButtons = [] }) {
    if (typeof document === 'undefined') return;
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey) || e.altKey) return;
        const target = e.shiftKey ? copy : (typeof main === 'function' ? main() : null);
        if (!target || target.disabled) return;
        e.preventDefault();
        target.click();
    });
    const key = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || '') ? '⌘' : 'Ctrl';
    const addHint = (b, hint) => { if (b && !(b.title || '').includes(hint)) b.title = `${b.title ? `${b.title} ` : ''}(${hint})`; };
    for (const b of mainButtons) addHint(b, `${key}+Enter`);
    addHint(copy, `${key}+Shift+Enter`);
}
