import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Guards for GitDoco's privacy promises (see privacy.html): no third-party resources, network
 * access limited to GitHub and deps.dev, no referrer, token never persisted, everything the
 * site stores can be cleared, and licenses ship with the site.
 */
const ROOT = new URL('../', import.meta.url).pathname;
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const PAGES = ['index.html', 'privacy.html', 'terms.html', '404.html', 'code.html', 'issues.html', 'discussions.html', 'deps.html'];
const JS = fs.readdirSync(path.join(ROOT, 'js')).filter(f => f.endsWith('.js')).map(f => `js/${f}`);
const CSS = fs.readdirSync(path.join(ROOT, 'css')).filter(f => f.endsWith('.css')).map(f => `css/${f}`);
const ALLOWED_CONNECT = ['https://api.github.com', 'https://raw.githubusercontent.com', 'https://api.deps.dev'];

test('no page loads anything from another website (scripts, styles, fonts, images, frames)', () => {
    for (const page of PAGES) {
        const html = read(page);
        const offsite = [...html.matchAll(/<(script|link|img|iframe|source|video|audio|embed|object)\b[^>]*\b(src|href|srcset)="(https?:)?\/\/[^"]+"/gi)]
            .filter(m => !/rel="canonical"/.test(m[0]));
        assert.deepEqual(offsite.map(m => m[0]), [], page);
        assert.doesNotMatch(html, /<script(?![^>]*\bsrc=")[^>]*>(?![\s\S]*?<\/script>\s*$)/i, `${page}: inline script`);
    }
    for (const css of CSS) {
        assert.doesNotMatch(read(css), /url\(\s*['"]?(https?:)?\/\//i, `${css}: off-site url()`);
        assert.doesNotMatch(read(css), /@import/i, `${css}: @import`);
    }
});

test('the only hosts the code talks to are GitHub and deps.dev', () => {
    for (const page of PAGES) {
        const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(read(page));
        assert.ok(csp, `${page}: CSP`);
        const connect = /connect-src ([^;]+);/.exec(csp[1])[1].split(/\s+/).filter(Boolean);
        assert.deepEqual(connect, ["'self'", ...ALLOWED_CONNECT], `${page}: connect-src`);
        assert.match(csp[1], /default-src 'self'/);
        assert.match(read(page), /<meta name="referrer" content="no-referrer">/, `${page}: referrer`);
    }
    const headers = read('_headers');
    assert.match(headers, new RegExp(`connect-src 'self' ${ALLOWED_CONNECT.join(' ').replace(/\./g, '\\.')};`));
    assert.match(headers, /Referrer-Policy: no-referrer/);
    // No beacons, sockets or tracking APIs anywhere in the code.
    for (const f of JS) {
        assert.doesNotMatch(read(f), /sendBeacon|new WebSocket|EventSource|document\.cookie|navigator\.serviceWorker\.register/, f);
    }
});

test('links that open a new tab never pass the opener or the referrer', () => {
    for (const page of PAGES) {
        for (const m of read(page).matchAll(/<a\b[^>]*target="_blank"[^>]*>/g)) {
            assert.match(m[0], /rel="noopener noreferrer"/, `${page}: ${m[0]}`);
        }
    }
    assert.match(read('js/links.js'), /a\.rel = 'noopener noreferrer';/);
});

test('the GitHub token is never stored, logged or put in a URL', () => {
    for (const f of JS) {
        const src = read(f);
        for (const line of src.split('\n')) {
            if (/\bpat\b/.test(line) && /(setItem|store\.set|console\.|searchParams\.set|location\.|\.href\s*=)/.test(line)) {
                // The only allowed mention: deciding NOT to remember a repo when a token was used.
                assert.match(line, /if \(!pat/, `${f}: ${line.trim()}`);
            }
        }
    }
    for (const page of PAGES) {
        const pat = /<input[^>]*id="pat"[^>]*>/.exec(read(page));
        if (pat) assert.match(pat[0], /type="password"[^>]*autocomplete="off"|autocomplete="off"[^>]*type="password"/, page);
    }
});

test('"Clear GitDoco data" covers every key the site stores', () => {
    const keys = new Set();
    for (const f of JS) {
        for (const m of read(f).matchAll(/(?:setItem|store\.set)\(\s*['`]([^'`]+)['`]/g)) keys.add(m[1]);
    }
    assert.ok(keys.size > 5);
    keys.add(/NOTICE_KEY = '([^']+)'/.exec(read('js/first-use.js'))[1]);
    const pattern = /KEY = (\/.+\/);/.exec(read('js/privacy.js'))[1];
    const re = new Function(`return ${pattern}`)();
    for (const k of keys) assert.match(k.replace(/\$\{KIND\}/, 'issues'), re, `key ${k} is not cleared`);
});

test('license files exist and are published with the site', () => {
    assert.match(read('LICENSE'), /^MIT License\n\nCopyright \(c\) 2026 In Your Own Browser/);
    assert.match(read('fonts/OFL.txt'), /SIL OPEN FONT LICENSE Version 1\.1/);
    assert.match(read('NOTICE'), /fonts\/OFL\.txt/);
    // LICENSE stays the plain MIT text: anything appended makes GitHub report the license as "Other".
    assert.doesNotMatch(read('LICENSE'), /Third-party|OFL|-{10}/);
    const build = read('scripts/build-site.mjs');
    for (const f of ['privacy.html', 'LICENSE', 'NOTICE']) assert.ok(build.includes(`'${f}'`), `build copies ${f}`);
    assert.ok(build.includes("'fonts'"), 'build copies fonts/ (with OFL.txt)');
});

test('opening a page contacts nothing: GitHub is only called after the user acts', () => {
    // Top-level (unindented) calls run on page open; none may reach the network.
    for (const f of ['js/app.js', 'js/issues-app.js', 'js/deps-app.js', 'js/landing.js', 'js/privacy.js']) {
        const topLevel = read(f).split('\n').filter(l => /^\S/.test(l) && !/^(\/\/|\*|\/\*|import|export|function|async function|const|let|var|if|for|try|\}|\[|class)/.test(l));
        for (const line of topLevel) {
            assert.doesNotMatch(line, /fetch|refreshRateLimitBadge\(\)|fetchRateLimit\(/, `${f}: ${line}`);
        }
    }
});

test('the TimeDoco banner makes no requests, is remembered under a clearable key, and is on the seven main pages', () => {
    const js = read('js/promo-banner.js');
    assert.doesNotMatch(js, /fetch\(|XMLHttpRequest|new Image|createElement\(['"](script|img|iframe)/, 'promo banner must not load anything');
    assert.match(js, /'cfg_promo_timedoco_closed'/);
    for (const page of ['index', 'privacy', 'terms', 'code', 'issues', 'discussions', 'deps']) {
        assert.match(read(`${page}.html`), /<script src="js\/promo-banner\.js"><\/script>/, `${page}: banner script`);
        assert.match(read(`${page}.html`), /css\/promo-banner\.css/, `${page}: banner css`);
    }
});
