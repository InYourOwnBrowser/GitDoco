/**
 * Landing page (index.html): quick start form and forwarding of old Code tool links.
 */
import { parseRepoInput } from './github-api.js';
import { buildTabHref } from './nav.js';

// The Code tool used to live at index.html; forward its old deep links (?repo=, ?branch=, ...).
const params = new URLSearchParams(window.location.search);
if (params.has('repo')) {
    window.location.replace(`code.html${window.location.search}${window.location.hash}`);
}

// Same saved theme as the tool pages.
try {
    const saved = localStorage.getItem('app_theme');
    if (saved === 'dark' || saved === 'light') document.documentElement.setAttribute('data-theme', saved);
} catch (_) {}

const form = document.getElementById('quickStart');
const input = document.getElementById('quickRepo');
const error = document.getElementById('quickError');

function go(page) {
    const value = input.value.trim();
    if (value && !parseRepoInput(value)) {
        error.hidden = false;
        input.focus();
        return;
    }
    error.hidden = true;
    window.location.href = buildTabHref(page, value);
}

if (form) {
    form.addEventListener('submit', (e) => {
        e.preventDefault();
        go('deps');
    });
    form.querySelectorAll('button[data-page]').forEach(btn => {
        if (btn.type === 'submit') return;
        btn.addEventListener('click', () => go(btn.dataset.page));
    });
    form.querySelectorAll('button[data-repo]').forEach(btn => {
        btn.addEventListener('click', () => {
            input.value = btn.dataset.repo;
            error.hidden = true;
            input.focus();
        });
    });
    input.addEventListener('input', () => { error.hidden = true; });
}
