/**
 * Terms page: applies the theme saved by the tool pages.
 */
try {
    const saved = localStorage.getItem('app_theme');
    if (saved === 'dark' || saved === 'light') document.documentElement.setAttribute('data-theme', saved);
} catch (_) {}
