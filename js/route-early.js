// 404 page, before it renders: a path with two or more segments may be a repository shortcut
// (gitdoco.../owner/repo/issues), so hide the "Page not found" text until js/not-found.js has
// decided. Without this the text flashes before the redirect. A classic script so it runs first.
(function () {
    var parts = window.location.pathname.split('/').filter(Boolean);
    if (parts.length >= 2) document.documentElement.classList.add('routing');
})();
