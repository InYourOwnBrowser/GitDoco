/**
 * Privacy page: lists what GitDoco keeps in this browser and clears it on request.
 */
const KEY = /^(cfg_|app_theme$)/;

try {
    const saved = localStorage.getItem('app_theme');
    if (saved === 'dark' || saved === 'light') document.documentElement.setAttribute('data-theme', saved);
} catch (_) {}

const list = document.getElementById('savedKeys');
const btn = document.getElementById('clearDataBtn');
const status = document.getElementById('clearStatus');

function savedKeys() {
    try { return Object.keys(localStorage).filter(k => KEY.test(k)).sort(); } catch (_) { return []; }
}

function render() {
    const keys = savedKeys();
    list.textContent = keys.length ? keys.join(', ') : 'Nothing is saved in this browser.';
    btn.disabled = keys.length === 0;
}

btn.addEventListener('click', () => {
    const keys = savedKeys();
    try { for (const k of keys) localStorage.removeItem(k); } catch (_) {}
    document.documentElement.removeAttribute('data-theme');
    status.textContent = `Cleared ${keys.length} saved setting${keys.length === 1 ? '' : 's'}.`;
    render();
});

render();
