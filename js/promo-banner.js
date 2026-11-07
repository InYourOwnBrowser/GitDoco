/**
 * Dismissible ticker that points to TimeDoco. Classic script (not a module) placed right after
 * <body> so the bar is in place before the page paints and nothing jumps. Closing it is
 * remembered in this browser only (key starts with "cfg_", so "Clear GitDoco data" removes it).
 * It makes no network request: the link only opens when someone clicks it.
 */
(function () {
    var CLOSED_KEY = 'cfg_promo_timedoco_closed';
    try { if (localStorage.getItem(CLOSED_KEY) === '1') return; } catch (_) { /* storage blocked: show it, it just won't be remembered */ }
    if (!document.body) return;

    var URL = 'https://timedoco.com/?utm_source=gitdoco&utm_medium=banner&utm_campaign=ticker';
    var LEAD = 'Track your time with TimeDoco';
    var REST = ': a privacy-first time tracker that runs in your browser, no account needed. Try it at timedoco.com →';
    var COPIES = 4;       // per group: enough to fill an ultra-wide screen
    var SPEED = 55;       // pixels per second

    function el(tag, cls) { var e = document.createElement(tag); if (cls) e.className = cls; return e; }

    function item(hidden) {
        var a = el('a', 'promo-item');
        a.href = URL;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = LEAD + REST;
        if (hidden) { a.tabIndex = -1; a.setAttribute('aria-hidden', 'true'); }
        return a;
    }

    function group(hidden) {
        var g = el('span', 'promo-group');
        if (hidden) g.setAttribute('aria-hidden', 'true');
        for (var i = 0; i < COPIES; i++) g.appendChild(item(hidden || i > 0));
        return g;
    }

    var bar = el('aside', 'promo');
    bar.setAttribute('aria-label', 'TimeDoco');
    var viewport = el('div', 'promo-viewport');
    var track = el('div', 'promo-track');
    track.appendChild(group(false));
    track.appendChild(group(true));
    viewport.appendChild(track);

    var close = el('button', 'promo-close');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close this banner');
    close.title = 'Close';
    close.textContent = '×';
    close.addEventListener('click', function () {
        try { localStorage.setItem('cfg_promo_timedoco_closed', '1'); } catch (_) { /* not remembered */ }
        bar.parentNode && bar.parentNode.removeChild(bar);
        document.documentElement.classList.remove('has-promo');
    });

    bar.appendChild(viewport);
    bar.appendChild(close);
    document.body.insertBefore(bar, document.body.firstChild);
    document.documentElement.classList.add('has-promo');

    // Constant reading speed whatever the screen width: duration = one group's width / speed.
    var w = track.firstChild.getBoundingClientRect().width;
    if (w > 0) track.style.setProperty('--promo-duration', Math.round(w / SPEED) + 's');
})();
