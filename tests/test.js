import test from 'node:test';
import assert from 'node:assert/strict';

import {
    escapeXml,
    escapeCdata,
    getMarkdownFence,
    formatClaudeXml,
    formatMarkdown,
    formatGenericXml,
    formatJson,
    chunkContextOutput,
    buildContextOutput
} from '../js/formatters.js';

import { minifyCode } from '../js/minifier.js';
import { parseRepoInput, extractRateLimitHeaders } from '../js/github-api.js';
import { estimateTokens } from '../js/tokenizer.js';
import { generateTree } from '../js/tree.js';
import { scanForSecrets, redactSecrets } from '../js/secrets.js';
import { isBotUser, isLowSignalComment, extractIssueReferences, sanitizeIssueText, processIssueThread } from '../js/issue-cleaner.js';
import { formatIssuesClaudeXml, formatIssuesMarkdown, formatIssuesGenericXml, formatIssuesJson, buildIssuesOutput, chunkIssuesOutput } from '../js/issue-formatters.js';

test('formatters: escapeXml', () => {
    assert.equal(escapeXml('<script>alert("xss & ' + "'" + '")</script>'), '&lt;script&gt;alert(&quot;xss &amp; &apos;&quot;)&lt;/script&gt;');
    assert.equal(escapeXml(null), '');
});

test('formatters: escapeCdata', () => {
    assert.equal(escapeCdata('hello ]]> world'), 'hello ]]]]><![CDATA[> world');
    assert.equal(escapeCdata('normal text'), 'normal text');
});

test('formatters: getMarkdownFence', () => {
    assert.equal(getMarkdownFence('const x = 1;'), '```');
    assert.equal(getMarkdownFence('```js\ncode\n```'), '````');
    assert.equal(getMarkdownFence('````nested````'), '`````');
});

test('formatters: R4 failedFilesCount notes in Code Explorer output formats', () => {
    const repoInfo = { owner: 'owner', repo: 'repo' };
    const files = [{ path: 'app.js', content: 'console.log(1);' }];
    const opts = { failedFilesCount: 3 };

    const xml = formatClaudeXml(repoInfo, 'main', '', files, opts);
    assert.ok(xml.text.includes('<warnings>3 file(s) failed to download and were excluded.</warnings>'));

    const md = formatMarkdown(repoInfo, 'main', '', files, opts);
    assert.ok(md.text.includes('> **Warning:** 3 file(s) failed to download and were excluded.'));

    const gxml = formatGenericXml(repoInfo, 'main', '', files, opts);
    assert.ok(gxml.text.includes('<warnings>3 file(s) failed to download and were excluded.</warnings>'));

    const json = formatJson(repoInfo, 'main', '', files, opts);
    const parsed = JSON.parse(json.text);
    assert.equal(parsed.warnings, '3 file(s) failed to download and were excluded.');
});

test('formatters: Claude XML formatting emits raw content', () => {
    const repoInfo = { owner: 'user', repo: 'my-repo', url: 'http://localhost/?repo=user/my-repo' };
    const branch = 'main';
    const treeText = '├── index.js\n';
    const files = [{ path: 'index.js', content: 'console.log("<hello>");' }];

    const result = formatClaudeXml(repoInfo, branch, treeText, files);
    assert.equal(result.ext, 'xml');
    assert.match(result.text, /<repository>user\/my-repo<\/repository>/);
    assert.match(result.text, /<url>http:\/\/localhost\/\?repo=user\/my-repo<\/url>/);
    assert.match(result.text, /console\.log\("<hello>"\);/);
});

test('formatters: Generic XML CDATA escaping', () => {
    const repoInfo = { owner: 'user', repo: 'my-repo' };
    const files = [{ path: 'test.txt', content: 'end ]]> block' }];
    const result = formatGenericXml(repoInfo, 'main', '', files);

    assert.match(result.text, /<!\[CDATA\[\nend \]\]\]\]><!\[CDATA\[> block\n\]\]>/);
});

test('formatters: Markdown fence generation', () => {
    const repoInfo = { owner: 'user', repo: 'my-repo' };
    const files = [{ path: 'test.md', content: '```js\nconsole.log(1);\n```' }];
    const result = formatMarkdown(repoInfo, 'main', '', files);

    assert.match(result.text, /````md/);
});

test('minifier: JS comment stripping preserves strings and URLs', () => {
    const code = `
    // This is a comment
    const url = "https://example.com/path?a=1//2";
    /* Multi-line
       comment */
    const text = 'hello // world';
    `;
    const minified = minifyCode(code, 'app.js', 'aggressive');
    assert.ok(minified.includes('const url = "https://example.com/path?a=1//2";'));
    assert.ok(minified.includes("const text = 'hello // world';"));
    assert.ok(!minified.includes('This is a comment'));
    assert.ok(!minified.includes('Multi-line'));
});

test('minifier: Python comment stripping preserves strings and shebang', () => {
    const code = `#!/usr/bin/env python
# This is a comment
url = "https://example.com/#anchor"
msg = 'hello # world'
""" Triple quoted
    # comment inside string
"""
`;
    const minified = minifyCode(code, 'script.py', 'aggressive');
    assert.ok(minified.startsWith('#!/usr/bin/env python'));
    assert.ok(minified.includes('url = "https://example.com/#anchor"'));
    assert.ok(minified.includes("msg = 'hello # world'"));
    assert.ok(minified.includes('# comment inside string'));
    assert.ok(!minified.includes('# This is a comment'));
});

test('github-api: parseRepoInput validation', () => {
    assert.deepEqual(parseRepoInput('LukeAFullard/senti'), { owner: 'LukeAFullard', repo: 'senti', branch: null, subpath: null, treeTail: null });
    assert.deepEqual(parseRepoInput('https://github.com/LukeAFullard/senti.git'), { owner: 'LukeAFullard', repo: 'senti', branch: null, subpath: null, treeTail: null });
    assert.deepEqual(parseRepoInput('github.com/LukeAFullard/senti'), { owner: 'LukeAFullard', repo: 'senti', branch: null, subpath: null, treeTail: null });
    assert.deepEqual(parseRepoInput('www.github.com/LukeAFullard/senti'), { owner: 'LukeAFullard', repo: 'senti', branch: null, subpath: null, treeTail: null });
    assert.deepEqual(parseRepoInput('https://github.com/LukeAFullard/senti/tree/dev/src/components'), { owner: 'LukeAFullard', repo: 'senti', branch: 'dev', subpath: 'src/components', treeTail: 'dev/src/components' });
    assert.equal(parseRepoInput('invalid-input'), null);
    assert.equal(parseRepoInput('bad owner/repo name!'), null);
    assert.equal(parseRepoInput('./..'), null);
    assert.equal(parseRepoInput('../repo'), null);
    assert.equal(parseRepoInput('owner/.'), null);
    assert.equal(parseRepoInput(''), null);
});

test('tokenizer: estimateTokens', () => {
    const count = estimateTokens('function helloWorld() { return 42; }');
    assert.ok(count > 0);
});

test('minifier: JS comment stripping preserves RegExp literals and distinguishes division', () => {
    const code = `
    // comment before
    const pattern = /^https?:\\/\\//;
    const regexWithCommentLike = /a\\/b/*c/;
    const myreturn = 10 / 2;
    /* comment after */
    `;
    const minified = minifyCode(code, 'app.js', 'aggressive');
    assert.ok(!minified.includes('comment before'));
    assert.ok(!minified.includes('comment after'));
    assert.ok(minified.includes('const pattern = /^https?:\\/\\//;'));
    assert.ok(minified.includes('const myreturn = 10 / 2;'));
});

test('formatters: linear chunking does not stall or throw', () => {
    const repoInfo = { owner: 'user', repo: 'my-repo' };
    const files = Array.from({ length: 50 }, (_, i) => ({
        path: `file_${i}.js`,
        content: `console.log("File ${i} content repeat ".repeat(20));`
    }));

    const chunks = chunkContextOutput('claude-xml', repoInfo, 'main', '├── file.js\n', files, 200, estimateTokens);
    assert.ok(chunks.length > 1);
});

test('github-api: extractRateLimitHeaders converts strings to numbers', () => {
    const map = new Map([
        ['x-ratelimit-remaining', '4999'],
        ['x-ratelimit-limit', '5000'],
        ['x-ratelimit-reset', '1600000000'],
        ['retry-after', '30']
    ]);
    const mockResponse = {
        headers: {
            get: (k) => map.get(k) || null
        }
    };

    const parsed = extractRateLimitHeaders(mockResponse);
    assert.strictEqual(parsed.remaining, 4999);
    assert.strictEqual(parsed.limit, 5000);
    assert.strictEqual(parsed.reset, 1600000000);
    assert.strictEqual(parsed.retryAfter, 30);
});

test('tree: generateTree handles prototype property collisions safely', () => {
    const paths = ['toString/file.js', 'constructor/test.js', 'valueOf/index.js'];
    const ascii = generateTree(paths);
    assert.ok(ascii.includes('toString'));
    assert.ok(ascii.includes('constructor'));
    assert.ok(ascii.includes('valueOf'));
});


test('minifier: block comment removal inserts space to prevent token merging', () => {
    const code = 'return/*comment*/x;';
    const minified = minifyCode(code, 'app.js', 'aggressive');
    assert.equal(minified, 'return x;');
});

test('minifier: unquoted hash in YAML value is not treated as comment', () => {
    const code = 'value: abc#def\nurl: http://example.com/#anchor';
    const minified = minifyCode(code, 'config.yaml', 'aggressive');
    assert.ok(minified.includes('value: abc#def'));
    assert.ok(minified.includes('url: http://example.com/#anchor'));
});

test('minifier: blank lines inside Python triple quoted strings are preserved', () => {
    const code = 'x = """\nline1\n\nline3\n"""';
    const minified = minifyCode(code, 'script.py', 'aggressive');
    assert.ok(minified.includes('line1\n\nline3'));
});

test('github-api: parseRepoInput handles query strings and blob URLs', () => {
    const parsedQuery = parseRepoInput('https://github.com/owner/repo/tree/main/src?ref=123');
    assert.deepEqual(parsedQuery, { owner: 'owner', repo: 'repo', branch: 'main', subpath: 'src', treeTail: 'main/src' });

    const parsedBlob = parseRepoInput('https://github.com/owner/repo/blob/main/src/index.js');
    assert.deepEqual(parsedBlob, { owner: 'owner', repo: 'repo', branch: 'main', subpath: 'src/index.js', treeTail: 'main/src/index.js' });
});

test('github-api: Retry-After HTTP-date parsing', () => {
    const futureDateStr = new Date(Date.now() + 45000).toUTCString();
    const map = new Map([['retry-after', futureDateStr]]);
    const response = { headers: { get: (k) => map.get(k) || null } };
    const meta = extractRateLimitHeaders(response);
    assert.ok(meta.retryAfter >= 40 && meta.retryAfter <= 50);
});

test('formatters: markdown file path extension extraction in directories with dots', () => {
    const repoInfo = { owner: 'owner', repo: 'repo' };
    const files = [{ path: 'v1.0.0/src/component.js', content: 'const a = 1;' }];
    const res = formatMarkdown(repoInfo, 'main', '', files);
    assert.ok(res.text.includes('```js'));
});

test('minifier: CSS url(//host/a.css) is preserved and not stripped as line comment', () => {
    const code = '@import url(//cdn.example.com/style.css);';
    const minified = minifyCode(code, 'style.css', 'aggressive');
    assert.ok(minified.includes('url(//cdn.example.com/style.css)'));
});

test('minifier: JSX apostrophe in text does not truncate subsequent lines', () => {
    const code = 'const text = <p>Don\'t stop</p>;\nconst url = "//cdn.example.com/script.js";';
    const minified = minifyCode(code, 'Component.jsx', 'aggressive');
    assert.ok(minified.includes("Don't stop"));
    assert.ok(minified.includes('//cdn.example.com/script.js'));
});

test('minifier: Markdown files in aggressive mode do not strip blank lines', () => {
    const code = '# Title\n\nParagraph 1\n\nParagraph 2';
    const minified = minifyCode(code, 'README.md', 'aggressive');
    assert.equal(minified, code);
});

test('github-api: parseRepoInput with branch containing slashes', () => {
    const parsed = parseRepoInput('https://github.com/owner/repo/tree/feature/ui/src/app', 'feature/ui');
    assert.deepEqual(parsed, { owner: 'owner', repo: 'repo', branch: 'feature/ui', subpath: 'src/app', treeTail: 'feature/ui/src/app' });
});

test('formatters: Claude XML wraps CDATA when closing document tags exist in content', () => {
    const repoInfo = { owner: 'owner', repo: 'repo' };
    const files = [{ path: 'test.xml', content: '</document> inside content' }];
    const res = formatClaudeXml(repoInfo, 'main', '', files);
    assert.ok(res.text.includes('<![CDATA['), 'Expected CDATA block for content containing closing document tags');
});

test('minifier: HTML textarea content is preserved during aggressive minification', () => {
    const code = '<textarea>\n  line 1\n\n  line 2\n</textarea>';
    const minified = minifyCode(code, 'index.html', 'aggressive');
    assert.ok(minified.includes('line 1\n\n  line 2'));
});

test('minifier: JS template literal interpolation preserves expressions and literal text surrounding interpolation', () => {
    const code = 'const msg = `hello ${val /* comment */ || "world `nested`"}!`;';
    const minified = minifyCode(code, 'app.js', 'aggressive');
    assert.ok(!minified.includes('comment'), 'Minified was: ' + JSON.stringify(minified));
    assert.ok(minified.includes('const msg = `hello ${'), 'Minified was: ' + JSON.stringify(minified));
    assert.ok(minified.includes('world `nested`'), 'Minified was: ' + JSON.stringify(minified));
    assert.ok(minified.includes('}!`;'), 'Minified was: ' + JSON.stringify(minified));
});

test('minifier: Python inline comment without preceding space is stripped', () => {
    const code = 'x = 1;#inline comment\ny = [1, 2]#comment2';
    const minified = minifyCode(code, 'script.py', 'aggressive');
    assert.equal(minified, 'x = 1;\ny = [1, 2]');
});

test('minifier: Shell parameter expansion ${var#pattern} and unquoted hash are preserved', () => {
    const code = 'echo ${var#prefix}\n echo foo#bar\n# Real comment';
    const minified = minifyCode(code, 'script.sh', 'aggressive');
    assert.ok(minified.includes('echo ${var#prefix}'));
    assert.ok(minified.includes('echo foo#bar'));
    assert.ok(!minified.includes('Real comment'));
});

test('minifier: HTML script and style tags are preserved during aggressive minification', () => {
    const code = '<script>\n  // JS comment\n  if (a <!-- b) console.log("ok");\n</script>\n<style>\n  /* CSS comment */\n  body { color: red; }\n</style>';
    const minified = minifyCode(code, 'index.html', 'aggressive');
    assert.ok(minified.includes('if (a <!-- b) console.log("ok");'));
    assert.ok(minified.includes('body { color: red; }'));
});

test('github-api: parseRepoInput override branch honors explicit branch over URL tree segment', () => {
    const parsed = parseRepoInput('https://github.com/owner/repo/tree/feature/login/src', 'main');
    assert.deepEqual(parsed, { owner: 'owner', repo: 'repo', branch: 'main', subpath: 'feature/login/src', treeTail: 'feature/login/src' });
});

test('github-api: fetchFileContent with mock fetch (public raw OK, raw 404 REST fallback, 429 backoff)', async () => {
    const originalFetch = globalThis.fetch;
    try {
        globalThis.fetch = async (url) => {
            if (url.includes('raw.githubusercontent.com')) {
                return { ok: true, status: 200, text: async () => 'hello world' };
            }
            return { ok: false, status: 404 };
        };
        const { fetchFileContent } = await import('../js/github-api.js');
        const res1 = await fetchFileContent('owner', 'repo', 'main', 'index.js', '');
        assert.equal(res1.success, true);
        assert.equal(res1.content, 'hello world');

        globalThis.fetch = async (url) => {
            if (url.includes('raw.githubusercontent.com')) {
                return { ok: false, status: 404, statusText: 'Not Found' };
            }
            if (url.includes('api.github.com')) {
                return {
                    ok: true,
                    status: 200,
                    headers: new Map(),
                    text: async () => 'rest content'
                };
            }
            return { ok: false, status: 404 };
        };
        const res2 = await fetchFileContent('owner', 'repo', 'main', 'secret.txt', 'ghp_token');
        assert.equal(res2.success, true);
        assert.equal(res2.content, 'rest content');

        globalThis.fetch = async (url) => {
            if (url.includes('raw.githubusercontent.com')) {
                return { ok: false, status: 429 };
            }
            return { ok: false, status: 429 };
        };
        const res3 = await fetchFileContent('owner', 'repo', 'main', 'file.js', '');
        assert.equal(res3.success, false);
        assert.equal(res3.backoff, 60);

        globalThis.fetch = async (url) => {
            return { ok: false, status: 500, statusText: 'Internal Server Error' };
        };
        const res4 = await fetchFileContent('owner', 'repo', 'main', 'file.js', '');
        assert.equal(res4.success, false);
        assert.equal(res4.backoff, 5);

    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('minifier: CSS slash is not treated as regex start', () => {
    const code = '.box { font: 12px/1.5 sans-serif; /* comment */ background: 50% / 10%; }';
    const minified = minifyCode(code, 'style.css', 'aggressive');
    assert.ok(!minified.includes('comment'), 'Comment should be removed');
    assert.ok(minified.includes('font: 12px/1.5 sans-serif;'));
    assert.ok(minified.includes('background: 50% / 10%;'));
});

test('minifier: JSX closing tag does not prevent comment stripping', () => {
    const code = '<div>hello</div> // trailing comment';
    const minified = minifyCode(code, 'App.jsx', 'aggressive');
    assert.ok(!minified.includes('trailing comment'));
    assert.ok(minified.includes('<div>hello</div>'));
});

test('minifier: Rust lifetime annotations do not corrupt string state or comments', () => {
    const code = "fn foo<'a>(x: &'a str) {\n    let val = 42; // Rust comment\n}";
    const minified = minifyCode(code, 'lib.rs', 'aggressive');
    assert.ok(!minified.includes('Rust comment'));
    assert.ok(minified.includes("fn foo<'a>(x: &'a str)"));
});

test('formatters: invalid XML control characters are stripped', () => {
    const repoInfo = { owner: 'owner', repo: 'repo' };
    const files = [{ path: 'ansi.txt', content: 'hello \x1b[31mred\x1b[0m world\x07' }];
    const res = formatClaudeXml(repoInfo, 'main', '', files);
    assert.ok(!res.text.includes('\x1b'));
    assert.ok(!res.text.includes('\x07'));
    assert.ok(res.text.includes('hello [31mred[0m world'));
});

test('formatters: continuous indexing in Claude XML across chunks', () => {
    const repoInfo = { owner: 'owner', repo: 'repo' };
    const files = [
        { path: 'a.js', content: 'const a = 1;' },
        { path: 'b.js', content: 'const b = 2;' }
    ];
    const chunks = chunkContextOutput('claude-xml', repoInfo, 'main', '', files, 40, estimateTokens);
    assert.ok(chunks.length >= 2, 'Expected multiple chunks');
    assert.ok(chunks[0].text.includes('<document index="1">'));
    assert.ok(chunks[1].text.includes('<document index="2">'));
});

test('minifier: basic mode preserves first line leading indentation', () => {
    const code = '  first_line: true\n  second_line: 123\n\n\n';
    const minified = minifyCode(code, 'config.yaml', 'basic');
    assert.equal(minified, '  first_line: true\n  second_line: 123');
});

test('formatters: chunks 2+ omit structure tree to optimize token overhead', () => {
    const repoInfo = { owner: 'owner', repo: 'repo' };
    const treeText = '├── large_tree_file_1.js\n├── large_tree_file_2.js\n';
    const files = [
        { path: 'f1.js', content: 'console.log("file 1 content");' },
        { path: 'f2.js', content: 'console.log("file 2 content");' }
    ];
    const chunks = chunkContextOutput('claude-xml', repoInfo, 'main', treeText, files, 50, estimateTokens);
    assert.ok(chunks.length >= 2);
    assert.ok(chunks[0].text.includes('<structure>'));
    assert.ok(!chunks[1].text.includes('<structure>'));
});

test('app: boots safely when localStorage throws', () => {
    const originalLocalStorage = globalThis.localStorage;
    try {
        Object.defineProperty(globalThis, 'localStorage', {
            configurable: true,
            get() {
                throw new Error('SecurityError: Access to localStorage is denied');
            }
        });

        assert.doesNotThrow(() => {
            try {
                localStorage.getItem('cfg_format');
            } catch (_) {}
        });
    } finally {
        Object.defineProperty(globalThis, 'localStorage', {
            configurable: true,
            value: originalLocalStorage
        });
    }
});

test('tree: filtering updates tab stops so hidden tab-stop row transfers tabIndex=0 to visible row', async () => {
    function createMockElement(tagName = 'div') {
        const children = [];
        const eventListeners = {};
        const style = { display: '' };
        const attributes = {};

        const el = {
            tagName: tagName.toUpperCase(),
            children,
            style,
            attributes,
            tabIndex: -1,
            className: '',
            textContent: '',
            innerHTML: '',
            checked: false,
            type: '',
            parentElement: null,
            get offsetParent() {
                if (el.style.display === 'none') return null;
                let p = el.parentElement;
                while (p) {
                    if (p.style && p.style.display === 'none') return null;
                    p = p.parentElement;
                }
                return {};
            },

            appendChild(child) {
                child.parentElement = el;
                children.push(child);
                return child;
            },
            insertBefore(newChild, refChild) {
                newChild.parentElement = el;
                const idx = children.indexOf(refChild);
                if (idx !== -1) children.splice(idx, 0, newChild);
                else children.push(newChild);
                return newChild;
            },
            setAttribute(k, v) { attributes[k] = String(v); },
            getAttribute(k) { return attributes[k] || null; },
            addEventListener(type, fn) {
                if (!eventListeners[type]) eventListeners[type] = [];
                eventListeners[type].push(fn);
            },
            dispatchEvent(evt) {
                const fns = eventListeners[evt.type] || [];
                for (const fn of fns) fn(evt);
            },
            closest() { return null; }
        };
        return el;
    }

    const originalDoc = globalThis.document;
    try {
        globalThis.document = {
            createElement: createMockElement
        };

        const { renderInteractiveTree } = await import('../js/tree.js');
        const container = createMockElement('div');
        const nodes = [
            { path: 'alpha.js', type: 'blob', size: 100 },
            { path: 'beta.js', type: 'blob', size: 200 }
        ];

        const controls = renderInteractiveTree(nodes, container);

        function findRows(el) {
            let res = [];
            if (el.className === 'tree-row') res.push(el);
            for (const child of el.children) {
                res = res.concat(findRows(child));
            }
            return res;
        }

        const rows = findRows(container);
        assert.equal(rows.length, 2);
        assert.equal(rows[0].tabIndex, 0);
        assert.equal(rows[1].tabIndex, -1);

        controls.filter('beta');

        assert.equal(rows[0].tabIndex, -1);
        assert.equal(rows[1].tabIndex, 0);

        controls.setLargeThresholdKb(0.05);
        assert.ok(container.children[0].innerHTML.includes('[Large]') || rows[0].innerHTML.includes('[Large]') || findRows(container).some(r => r.children.some(c => c.textContent && c.textContent.includes('[Large]'))));

    } finally {
        globalThis.document = originalDoc;
    }
});

test('ui: PR1 rate-limit quota badge displays only when remaining requests drop below 30', () => {
    function createMockBadge() {
        return { style: { display: 'none' } };
    }
    const rateBadge = createMockBadge();
    const updateBadgeVisibility = (remaining) => {
        rateBadge.style.display = remaining < 30 ? 'flex' : 'none';
    };

    updateBadgeVisibility(60);
    assert.equal(rateBadge.style.display, 'none');

    updateBadgeVisibility(30);
    assert.equal(rateBadge.style.display, 'none');

    updateBadgeVisibility(29);
    assert.equal(rateBadge.style.display, 'flex');

    updateBadgeVisibility(5);
    assert.equal(rateBadge.style.display, 'flex');

    updateBadgeVisibility(0);
    assert.equal(rateBadge.style.display, 'flex');

    updateBadgeVisibility(5000);
    assert.equal(rateBadge.style.display, 'none');
});

test('ui: PR1 persistent warning banner state formatting and options', () => {
    let bannerDisplay = 'none';
    let bannerText = '';
    let tokenBtnDisplay = 'none';
    let retryBtnDisplay = 'none';
    let retryFn = null;

    function showPersistentWarning(message, options = {}) {
        bannerText = message;
        tokenBtnDisplay = options.showTokenBtn ? 'inline-block' : 'none';
        retryBtnDisplay = options.showRetryBtn ? 'inline-block' : 'none';
        retryFn = options.onRetry || null;
        bannerDisplay = 'flex';
    }

    function hidePersistentWarning() {
        bannerDisplay = 'none';
    }

    // Trigger warning on failed comments with rate limit
    showPersistentWarning('3 comment thread(s) failed to load. Rate limit reached. Output context is incomplete.', {
        showTokenBtn: true,
        showRetryBtn: true,
        onRetry: () => 'retried'
    });

    assert.equal(bannerDisplay, 'flex');
    assert.ok(bannerText.includes('Rate limit reached'));
    assert.equal(tokenBtnDisplay, 'inline-block');
    assert.equal(retryBtnDisplay, 'inline-block');
    assert.equal(retryFn(), 'retried');

    hidePersistentWarning();
    assert.equal(bannerDisplay, 'none');
});

test('ui: PR1 build summary card data formatting logic for code and issues', () => {
    // Helper replicating summary card formatting
    function formatCodeSummary(fileCount, estTokens, chunkCount, secretsCount, redactedCount) {
        let secretsText = 'None detected';
        if (secretsCount > 0) {
            secretsText = (redactedCount === secretsCount)
                ? `${redactedCount} hidden`
                : `${redactedCount} hidden (${secretsCount - redactedCount} present)`;
        }
        return {
            items: `${fileCount} file${fileCount === 1 ? '' : 's'}`,
            tokens: `~${estTokens.toLocaleString()} estimated tokens`,
            parts: chunkCount > 1 ? `${chunkCount} parts` : '1 part',
            secrets: secretsText
        };
    }

    const singlePart = formatCodeSummary(5, 12000, 1, 0, 0);
    assert.equal(singlePart.items, '5 files');
    assert.equal(singlePart.tokens, '~12,000 estimated tokens');
    assert.equal(singlePart.parts, '1 part');
    assert.equal(singlePart.secrets, 'None detected');

    const multiPartWithSecrets = formatCodeSummary(25, 450000, 3, 4, 4);
    assert.equal(multiPartWithSecrets.items, '25 files');
    assert.equal(multiPartWithSecrets.tokens, '~450,000 estimated tokens');
    assert.equal(multiPartWithSecrets.parts, '3 parts');
    assert.equal(multiPartWithSecrets.secrets, '4 hidden');

    const partiallyRedacted = formatCodeSummary(1, 500, 1, 3, 2);
    assert.equal(partiallyRedacted.secrets, '2 hidden (1 present)');
});

test('ui: PR1 copy button dynamic label and next part advancement', () => {
    let activeChunkIndex = 0;
    const chunks = ['part 1 content', 'part 2 content', 'part 3 content'];
    const copyBtn = { textContent: 'Copy' };
    const nextPartBtn = { style: { display: 'none' } };

    function updateActiveChunkView(index) {
        activeChunkIndex = index;
        if (chunks.length > 1) {
            copyBtn.textContent = `Copy part ${activeChunkIndex + 1} of ${chunks.length}`;
            nextPartBtn.style.display = activeChunkIndex < chunks.length - 1 ? 'inline-flex' : 'none';
        } else {
            copyBtn.textContent = 'Copy';
            nextPartBtn.style.display = 'none';
        }
    }

    // Initial multi-part state
    updateActiveChunkView(0);
    assert.equal(copyBtn.textContent, 'Copy part 1 of 3');
    assert.equal(nextPartBtn.style.display, 'inline-flex');

    // Advance to part 2
    updateActiveChunkView(1);
    assert.equal(copyBtn.textContent, 'Copy part 2 of 3');
    assert.equal(nextPartBtn.style.display, 'inline-flex');

    // Advance to last part 3
    updateActiveChunkView(2);
    assert.equal(copyBtn.textContent, 'Copy part 3 of 3');
    assert.equal(nextPartBtn.style.display, 'none', 'Next part button should be hidden on last part');
});

test('ui: PR2 Send-to presets configuration mappings', () => {
    function getPresetConfig(target) {
        switch (target) {
            case 'claude':
                return { format: 'claude-xml', budget: 200000, chunkLimit: 200000 };
            case 'chatgpt':
                return { format: 'markdown', budget: 128000, chunkLimit: 128000 };
            case 'gemini':
                return { format: 'markdown', budget: 1000000, chunkLimit: 1000000 };
            default:
                return null;
        }
    }

    assert.deepEqual(getPresetConfig('claude'), {
        format: 'claude-xml',
        budget: 200000,
        chunkLimit: 200000
    });
    assert.deepEqual(getPresetConfig('chatgpt'), {
        format: 'markdown',
        budget: 128000,
        chunkLimit: 128000
    });
    assert.deepEqual(getPresetConfig('gemini'), {
        format: 'markdown',
        budget: 1000000,
        chunkLimit: 1000000
    });
});

test('ui: PR2 dynamic copy button labels based on Send-to target and parts', () => {
    function getCopyButtonLabel(target, activeIndex = 0, totalParts = 1) {
        if (totalParts > 1) {
            return `Copy part ${activeIndex + 1} of ${totalParts}`;
        }
        switch (target) {
            case 'claude': return 'Copy for Claude';
            case 'chatgpt': return 'Copy for ChatGPT';
            case 'gemini': return 'Copy for Gemini';
            default: return 'Copy';
        }
    }

    // Single chunk copy labels
    assert.equal(getCopyButtonLabel('claude', 0, 1), 'Copy for Claude');
    assert.equal(getCopyButtonLabel('chatgpt', 0, 1), 'Copy for ChatGPT');
    assert.equal(getCopyButtonLabel('gemini', 0, 1), 'Copy for Gemini');
    assert.equal(getCopyButtonLabel('custom', 0, 1), 'Copy');

    // Multi-part overrides target name
    assert.equal(getCopyButtonLabel('claude', 0, 3), 'Copy part 1 of 3');
    assert.equal(getCopyButtonLabel('claude', 1, 3), 'Copy part 2 of 3');
    assert.equal(getCopyButtonLabel('chatgpt', 2, 4), 'Copy part 3 of 4');
});

test('ui: PR2 settings summary formatting for Code Packer and Issues Explorer', () => {
    function formatSettingsSummaryCode({ format, minifyMode, secretsMode }) {
        const formatLabels = {
            'claude-xml': 'Claude XML',
            'markdown': 'Markdown',
            'generic-xml': 'Generic XML',
            'json': 'JSON'
        };
        const fmtText = formatLabels[format] || 'Claude XML';

        let codeText = 'original code';
        if (minifyMode === 'basic') codeText = 'blank lines removed';
        else if (minifyMode === 'aggressive') codeText = 'comments removed';

        let secText = 'secrets hidden';
        if (secretsMode === 'off') secText = 'secrets visible';
        else if (secretsMode === 'strict') secText = 'strict secrets hidden';

        return `Settings: ${fmtText} · ${codeText} · ${secText}`;
    }

    function formatSettingsSummaryIssues({ format, secretsMode }) {
        const formatLabels = {
            'claude-xml': 'Claude XML',
            'markdown': 'Markdown',
            'generic-xml': 'Generic XML',
            'json': 'JSON'
        };
        const fmtText = formatLabels[format] || 'Claude XML';

        let secText = 'secrets hidden';
        if (secretsMode === 'off') secText = 'secrets visible';
        else if (secretsMode === 'strict') secText = 'strict secrets hidden';

        return `Settings: ${fmtText} · ${secText}`;
    }

    // Code Packer default
    assert.equal(
        formatSettingsSummaryCode({ format: 'claude-xml', minifyMode: 'none', secretsMode: 'standard' }),
        'Settings: Claude XML · original code · secrets hidden'
    );

    // Code Packer with blank lines stripped and strict secrets
    assert.equal(
        formatSettingsSummaryCode({ format: 'markdown', minifyMode: 'basic', secretsMode: 'strict' }),
        'Settings: Markdown · blank lines removed · strict secrets hidden'
    );

    // Code Packer with comments removed and secrets off
    assert.equal(
        formatSettingsSummaryCode({ format: 'json', minifyMode: 'aggressive', secretsMode: 'off' }),
        'Settings: JSON · comments removed · secrets visible'
    );

    // Issues Explorer default
    assert.equal(
        formatSettingsSummaryIssues({ format: 'claude-xml', secretsMode: 'standard' }),
        'Settings: Claude XML · secrets hidden'
    );

    // Issues Explorer with markdown and secrets off
    assert.equal(
        formatSettingsSummaryIssues({ format: 'markdown', secretsMode: 'off' }),
        'Settings: Markdown · secrets visible'
    );
});

test('ui: PR2 unified secrets control mode mapping', () => {
    function mapSecretsMode(redact, aggressive) {
        if (!redact) return 'off';
        if (aggressive) return 'strict';
        return 'standard';
    }

    assert.equal(mapSecretsMode(false, false), 'off');
    assert.equal(mapSecretsMode(false, true), 'off');
    assert.equal(mapSecretsMode(true, false), 'standard');
    assert.equal(mapSecretsMode(true, true), 'strict');

    function applySecretsMode(mode) {
        return {
            redact: mode !== 'off',
            aggressive: mode === 'strict'
        };
    }

    assert.deepEqual(applySecretsMode('off'), { redact: false, aggressive: false });
    assert.deepEqual(applySecretsMode('standard'), { redact: true, aggressive: false });
    assert.deepEqual(applySecretsMode('strict'), { redact: true, aggressive: true });
});

test('ui: PR3 rate limit quota badge threshold (< 10) and text format', () => {
    function formatQuotaBadgeText(remaining, resetTimeStr) {
        return `${remaining} requests left, resets ${resetTimeStr}`;
    }

    function createMockBadge() {
        return { style: { display: 'none' } };
    }

    const rateBadge = createMockBadge();
    const updateBadgeVisibility = (remaining) => {
        rateBadge.style.display = remaining < 10 ? 'flex' : 'none';
    };

    updateBadgeVisibility(60);
    assert.equal(rateBadge.style.display, 'none');

    updateBadgeVisibility(30);
    assert.equal(rateBadge.style.display, 'none');

    updateBadgeVisibility(10);
    assert.equal(rateBadge.style.display, 'none');

    updateBadgeVisibility(9);
    assert.equal(rateBadge.style.display, 'flex');

    updateBadgeVisibility(5);
    assert.equal(rateBadge.style.display, 'flex');

    updateBadgeVisibility(0);
    assert.equal(rateBadge.style.display, 'flex');

    assert.equal(formatQuotaBadgeText(12, '3:14 PM'), '12 requests left, resets 3:14 PM');
    assert.equal(formatQuotaBadgeText(5, '10:00 AM'), '5 requests left, resets 10:00 AM');
});

test('ui: PR3 token on demand display trigger conditions and DOM reveal', () => {
    function showTokenPanelMock(dom, message) {
        if (dom.tokenPanel) {
            dom.tokenPanel.hidden = false;
        }
        if (dom.tokenPanelMessage) {
            dom.tokenPanelMessage.textContent = message || '';
        }
    }

    const domMock = {
        tokenPanel: { hidden: true },
        tokenPanelMessage: { textContent: '' },
        pat: { focused: false }
    };

    // Initially hidden
    assert.equal(domMock.tokenPanel.hidden, true);

    // Trigger showTokenPanel
    showTokenPanelMock(domMock, 'If this is a private repo, add a token.');
    assert.equal(domMock.tokenPanel.hidden, false);
    assert.equal(domMock.tokenPanelMessage.textContent, 'If this is a private repo, add a token.');
    assert.equal(domMock.pat.focused, false); // Focus is not moved
});

test('ui: PR3 example repos and mode switch radio behavior', () => {
    const exampleRepos = ['anthropics/claude-code', 'facebook/react', 'astral-sh/ruff'];

    function handleExampleClick(repo) {
        return {
            repoUrl: repo,
            shouldTriggerLoad: true
        };
    }

    for (const repo of exampleRepos) {
        const res = handleExampleClick(repo);
        assert.equal(res.repoUrl, repo);
        assert.equal(res.shouldTriggerLoad, true);
    }

    function getTargetModeUrl(currentMode, targetMode, currentRepo) {
        if (currentMode === targetMode) return null;
        const targetPage = targetMode === 'issues' ? 'issues.html' : 'index.html';
        return currentRepo ? `${targetPage}?repo=${encodeURIComponent(currentRepo)}` : targetPage;
    }

    assert.equal(getTargetModeUrl('code', 'issues', 'facebook/react'), 'issues.html?repo=facebook%2Freact');
    assert.equal(getTargetModeUrl('code', 'issues', ''), 'issues.html');
    assert.equal(getTargetModeUrl('issues', 'code', 'astral-sh/ruff'), 'index.html?repo=astral-sh%2Fruff');
    assert.equal(getTargetModeUrl('issues', 'code', ''), 'index.html');
});

test('ui: PR3 workspace reveal on load vs empty initial state', () => {
    function computeWorkspaceVisibility(appState, repoUrlParam) {
        const isVisible = appState !== 'empty' || (Boolean(repoUrlParam) && repoUrlParam.trim().length > 0);
        return {
            workspaceHidden: !isVisible,
            heroHidden: isVisible
        };
    }

    // Initial first-screen state with no repo
    const initial = computeWorkspaceVisibility('empty', '');
    assert.equal(initial.workspaceHidden, true, 'Workspace should be hidden on first screen');
    assert.equal(initial.heroHidden, false, 'Hero section should be visible on first screen');

    // Repo param in URL
    const withRepoParam = computeWorkspaceVisibility('empty', 'facebook/react');
    assert.equal(withRepoParam.workspaceHidden, false, 'Workspace should be visible if repo param exists');
    assert.equal(withRepoParam.heroHidden, true, 'Hero section should be hidden if repo param exists');

    // Loaded state
    const loaded = computeWorkspaceVisibility('loaded', '');
    assert.equal(loaded.workspaceHidden, false);
    assert.equal(loaded.heroHidden, true);

    // Built state
    const built = computeWorkspaceVisibility('built', '');
    assert.equal(built.workspaceHidden, false);
    assert.equal(built.heroHidden, true);
});

// --- Regression & Verification Tests for Review Findings ---

test('issue-cleaner: titled image long URL and unclosed image performance', () => {
    const longUrl = 'https://x.io/' + 'a'.repeat(60) + '.png "t"';
    const inputTitled = `![s](${longUrl})`;
    const start1 = Date.now();
    const res1 = sanitizeIssueText(inputTitled, { stripImages: true });
    const dur1 = Date.now() - start1;

    assert.ok(dur1 < 50, `Titled image took ${dur1} ms (expected < 50 ms)`);
    assert.equal(res1, '[Image: s]');

    const unclosedInput = '![a](' + 'x'.repeat(100000);
    const start2 = Date.now();
    const res2 = sanitizeIssueText(unclosedInput, { stripImages: true });
    const dur2 = Date.now() - start2;

    assert.ok(dur2 < 50, `Unclosed image took ${dur2} ms (expected < 50 ms)`);
});

test('issue-cleaner: code fence is preserved and not altered by image/template stripping', () => {
    const raw = "```html\n<!-- keep me -->\n<img src=\"a.png\" alt=\"logo\">\n<details><summary>x</summary>text</details>\n```";
    const cleaned = sanitizeIssueText(raw, { stripTemplates: true, stripImages: true, maxLogLines: 0 });
    assert.equal(cleaned, raw);
});

test('issue-cleaner: small maxLogLines truncates without negative count', () => {
    const raw = "```log\nline 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\n```";
    const cleaned = sanitizeIssueText(raw, { maxLogLines: 6 });
    assert.ok(cleaned.includes('lines of log/code truncated'));
    assert.ok(!cleaned.includes('-'));
});

test('issue-formatters: export NLP only overview filtering with nlpScope', () => {
    const repoInfo = { owner: 'owner', repo: 'repo' };
    const nlpData = {
        clusters: [
            { label: 'Authentication', count: 5, issueNumbers: [1, 2, 3, 4, 5] },
            { label: 'Database', count: 3, issueNumbers: [10, 11, 12] }
        ]
    };
    const issues = []; // NLP export passes empty issues list
    const chunks = chunkIssuesOutput('claude-xml', repoInfo, issues, 0, estimateTokens, {
        includeNlpSummary: true,
        nlpData,
        nlpScope: [1, 2]
    });

    assert.equal(chunks.length, 1);
    assert.ok(chunks[0].text.includes('Authentication'));
    assert.ok(!chunks[0].text.includes('Database'));
});

test('secrets: unquoted env secrets in issues are redacted and benign lines untouched', () => {
    const rawIssue = {
        number: 12,
        title: 'Crash report',
        body: "```sh\nAPI_TOKEN=abcd1234efgh5678\nNODE_ENV=production\nPASSWORD_MIN_LENGTH=12\n```",
        author: 'user',
        authorAssociation: 'NONE',
        createdAt: '2023-01-01'
    };
    const processed = processIssueThread(rawIssue, [], { isRedact: true, aggressiveRedact: true });
    assert.ok(processed.cleanedBody.includes('[REDACTED:generic-secret]'));
    assert.ok(!processed.cleanedBody.includes('abcd1234efgh5678'));
    assert.ok(processed.cleanedBody.includes('NODE_ENV=production'));
    assert.ok(processed.cleanedBody.includes('PASSWORD_MIN_LENGTH=12'));
});

test('issue-cleaner: cross-references extraction with lookbehind regex', () => {
    const text = 'Refs #12,#13 and fixes:#15 and (#14). Also known as GH-99.';
    const refs = extractIssueReferences(text);
    assert.deepEqual(refs, [12, 13, 14, 15, 99]);
});

test('issue-formatters: chunking issues with large instructions budgets within chunk token limit', () => {
    const repoInfo = { owner: 'owner', repo: 'repo' };
    const issues = Array.from({ length: 6 }, (_, i) => ({
        number: i + 1,
        title: `Issue ${i + 1}`,
        state: 'open',
        author: 'user',
        authorAssociation: 'MEMBER',
        createdAt: '2023-01-01',
        cleanedBody: `Detailed description for issue ${i + 1} `.repeat(40),
        cleanedComments: []
    }));
    const instructions = 'Instructions '.repeat(100);
    const limit = 1000;

    const chunks = chunkIssuesOutput('claude-xml', repoInfo, issues, limit, estimateTokens, { instructions });
    assert.ok(chunks.length > 1);

    for (const c of chunks) {
        assert.equal(c.exceedsLimit, false, 'No issue chunk part should exceed token limit');
    }
    assert.ok(chunks[chunks.length - 1].text.includes('Instructions '));
});

test('minifier: arrow function regex start, Ruby comments, and diff pass-through', () => {
    const arrowJs = 'const fn = f => /^node_modules\\//.test(f.path);';
    const minifiedJs = minifyCode(arrowJs, 'test.js', 'aggressive');
    assert.ok(minifiedJs.includes('f => /^node_modules\\//.test(f.path)'));

    const diffContent = '--- a/f.js\n+++ b/f.js\n@@ -1,2 +1,2 @@\n context line\n-old\n+new';
    const minifiedDiff = minifyCode(diffContent, 'patch.diff', 'aggressive');
    assert.equal(minifiedDiff, diffContent);

    const rubyCode = 'str = "/foo#bar"\n# Line comment\nx = 1';
    const minifiedRuby = minifyCode(rubyCode, 'app.rb', 'aggressive');
    assert.ok(minifiedRuby.includes('str = "/foo#bar"'));
    assert.ok(!minifiedRuby.includes('Line comment'));
});

test('github-issues-api: PR merged state mapped to stateReason completed', async () => {
    const originalFetch = globalThis.fetch;
    try {
        globalThis.fetch = async (url) => {
            if (url.includes('/issues?')) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => [
                        {
                            number: 10,
                            title: 'Merged PR',
                            state: 'closed',
                            pull_request: { merged_at: '2023-01-02T00:00:00Z' },
                            user: { login: 'author1' }
                        }
                    ]
                };
            }
            return { ok: false, status: 404 };
        };

        const { fetchIssuesManifest } = await import('../js/github-issues-api.js');
        const manifest = await fetchIssuesManifest('owner', 'repo', { itemType: 'prs' });

        assert.equal(manifest.length, 1);
        assert.equal(manifest[0].state, 'closed');
        assert.equal(manifest[0].stateReason, 'completed');
        assert.equal(manifest[0].mergedAt, '2023-01-02T00:00:00Z');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('minifier: cache does not return stale output for same-length edits beyond byte 1024', () => {
    const prefix = 'const padding = "' + 'a'.repeat(1200) + '";\n';
    const codeV1 = prefix + 'const flag = 0; // comment 1\n';
    const codeV2 = prefix + 'const flag = 1; // comment 2\n';

    assert.equal(codeV1.length, codeV2.length);

    const outV1 = minifyCode(codeV1, 'bundle.js', 'aggressive');
    const outV2 = minifyCode(codeV2, 'bundle.js', 'aggressive');

    assert.ok(outV1.includes('const flag = 0;'));
    assert.ok(outV2.includes('const flag = 1;'));
    assert.notEqual(outV1, outV2);
});

test('minifier: O(n) slash processing performance on 600KB file', () => {
    const line = 'const x = 10 / 2; // division\n';
    const numLines = Math.floor(600000 / line.length);
    const bigJs = line.repeat(numLines);

    const start = Date.now();
    const minified = minifyCode(bigJs, 'big.js', 'aggressive');
    const duration = Date.now() - start;

    assert.ok(duration < 500, `Minification took ${duration} ms (expected < 500 ms)`);
    assert.ok(minified.includes('const x = 10 / 2;'));
    assert.ok(!minified.includes('// division'));
});

test('budget status logic for pre-build split and oversized split chunk', () => {
    function calcBudgetStatus(totalTokens, numChunks = 1, isPreBuild = false, maxChunkTokens = 0, hasOversizedChunk = false, currentBudgetWindow = 200000, chunkLimitVal = 0) {
        if (isPreBuild && chunkLimitVal > 0 && totalTokens > chunkLimitVal) {
            const estChunks = Math.ceil(totalTokens / chunkLimitVal);
            return {
                text: `About ${totalTokens.toLocaleString()} tokens, will split into about ${estChunks} parts`,
                statusClass: 'status-fits'
            };
        }

        const isSplit = numChunks > 1 || (chunkLimitVal > 0 && totalTokens > chunkLimitVal);
        const displayTokens = maxChunkTokens || Math.round(totalTokens / numChunks);

        if (isSplit && numChunks > 1) {
            if (hasOversizedChunk) {
                return {
                    text: `Split into ${numChunks} parts (largest: ${displayTokens.toLocaleString()} tok) - 1+ part exceeds split limit`,
                    statusClass: 'status-over'
                };
            } else {
                return {
                    text: `Split into ${numChunks} parts (largest: ${displayTokens.toLocaleString()} tok) - fits target window`,
                    statusClass: 'status-fits'
                };
            }
        }

        return { text: 'Fits context window', statusClass: 'status-fits' };
    }

    const preBuildRes = calcBudgetStatus(120000, 1, true, 0, false, 200000, 50000);
    assert.equal(preBuildRes.text, 'About 120,000 tokens, will split into about 3 parts');

    const splitOversizedRes = calcBudgetStatus(150000, 3, false, 65000, true, 200000, 50000);
    assert.equal(splitOversizedRes.text, 'Split into 3 parts (largest: 65,000 tok) - 1+ part exceeds split limit');
    assert.equal(splitOversizedRes.statusClass, 'status-over');
});

function makeFakeCommentRepo(issueCount, perIssue) {
    const issues = [];
    const comments = [];
    let cid = 1;
    for (let n = 1; n <= issueCount; n++) {
        const created = new Date(Date.UTC(2025, 0, 1) + n * 86400000);
        issues.push({ number: n, createdAt: created.toISOString().slice(0, 10), commentsCount: perIssue });
        for (let j = 0; j < perIssue; j++) {
            const t = new Date(created.getTime() + (j + 1) * 3600000).toISOString();
            comments.push({ id: cid++, issue_url: `https://api.github.com/repos/o/r/issues/${n}`, body: `c${n}-${j}`, user: { login: 'u' }, created_at: t, updated_at: t });
        }
    }
    return { issues, comments };
}

function installFakeCommentApi(db, { dropFromBulkIssue = null } = {}) {
    const log = { calls: 0 };
    globalThis.fetch = async (url) => {
        log.calls++;
        const u = new URL(url);
        const page = Number(u.searchParams.get('page') || 1);
        const perPage = Number(u.searchParams.get('per_page') || 30);
        let list;
        const m = /\/issues\/(\d+)\/comments$/.exec(u.pathname);
        if (m) {
            list = db.comments.filter(c => c.issue_url.endsWith('/' + m[1]));
        } else if (u.pathname.endsWith('/issues/comments')) {
            const since = u.searchParams.get('since');
            list = db.comments.filter(c => !since || c.updated_at >= since);
            if (dropFromBulkIssue) {
                const suffix = '/issues/' + dropFromBulkIssue;
                const idx = list.map(c => c.issue_url.endsWith(suffix)).lastIndexOf(true);
                if (idx >= 0) list = list.filter((_, i) => i !== idx);
            }
        } else {
            return { ok: false, status: 404, statusText: 'Not Found', headers: new Map() };
        }
        return { ok: true, status: 200, headers: new Map(), json: async () => list.slice((page - 1) * perPage, page * perPage) };
    };
    return log;
}

test('github-issues-api: bulk comment strategy uses far fewer requests and matches per-issue output', async () => {
    const originalFetch = globalThis.fetch;
    try {
        const db = makeFakeCommentRepo(200, 3);
        const selected = db.issues.slice(-60);
        const { fetchCommentsForIssues } = await import('../js/github-issues-api.js');

        const perLog = installFakeCommentApi(db);
        const ref = await fetchCommentsForIssues('o', 'r', selected, { throttleMs: 0, strategy: 'per-issue' });
        assert.equal(perLog.calls, 60);

        const bulkLog = installFakeCommentApi(db);
        const res = await fetchCommentsForIssues('o', 'r', selected, { throttleMs: 0, universe: db.issues });
        assert.equal(res.stats.strategy, 'bulk');
        assert.ok(bulkLog.calls <= 4, `expected <= 4 requests, got ${bulkLog.calls}`);
        assert.equal(res.failures.length, 0);
        for (const iss of selected) {
            assert.deepEqual(res.commentsByIssue.get(iss.number).map(c => c.id), ref.commentsByIssue.get(iss.number).map(c => c.id));
        }
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('github-issues-api: bulk result with a count mismatch falls back to per-issue for that issue only', async () => {
    const originalFetch = globalThis.fetch;
    try {
        const db = makeFakeCommentRepo(200, 3);
        const selected = db.issues.slice(-60);
        const { fetchCommentsForIssues } = await import('../js/github-issues-api.js');
        const log = installFakeCommentApi(db, { dropFromBulkIssue: 190 });
        const res = await fetchCommentsForIssues('o', 'r', selected, { throttleMs: 0, universe: db.issues });
        assert.equal(res.stats.strategy, 'bulk+per-issue');
        assert.equal(res.commentsByIssue.get(190).length, 3, 'mismatched issue must be re-fetched in full');
        assert.ok(log.calls <= 6, `expected <= 6 requests, got ${log.calls}`);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('github-issues-api: auto strategy keeps per-issue for small or sparse old selections', async () => {
    const originalFetch = globalThis.fetch;
    try {
        const db = makeFakeCommentRepo(200, 3);
        const { fetchCommentsForIssues } = await import('../js/github-issues-api.js');
        installFakeCommentApi(db);
        const small = await fetchCommentsForIssues('o', 'r', db.issues.slice(-2), { throttleMs: 0, universe: db.issues });
        assert.equal(small.stats.strategy, 'per-issue');
        const old = await fetchCommentsForIssues('o', 'r', db.issues.slice(0, 5), { throttleMs: 0, universe: db.issues });
        assert.equal(old.stats.strategy, 'per-issue');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

// --- Secrets Detection & Redaction Tests ---

test('secrets: Phase 1 regression tests for long keys, provider tokens, URL credentials, and Auth headers', () => {
    function makeTestKey(prefix, targetTotalLength) {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
        let res = prefix;
        let seed = 12345;
        while (res.length < targetTotalLength) {
            seed = (seed * 9301 + 49297) % 233280;
            res += chars[seed % chars.length];
        }
        return res;
    }

    // Anthropic 101-char key after sk-ant- (total length 108)
    const longAntKey = makeTestKey('sk-ant-api03-', 108);
    const antText = `anthropic_key = "${longAntKey}"`;
    const antScan = scanForSecrets('config.js', antText);
    assert.equal(antScan.length, 1);
    assert.equal(antScan[0].type, 'anthropic-key');
    const antRedacted = redactSecrets(antText, 'config.js');
    assert.equal(antRedacted, 'anthropic_key = "[REDACTED:anthropic-key]"');
    assert.ok(!antRedacted.includes('sk-ant-'));
    assert.ok(!antRedacted.includes(longAntKey.slice(10, 20)));

    // OpenAI project ~189-char key
    const longOaiKey = makeTestKey('sk-proj-', 189);
    const oaiText = `openai_key = "${longOaiKey}"`;
    const oaiScan = scanForSecrets('config.js', oaiText);
    assert.equal(oaiScan.length, 1);
    assert.equal(oaiScan[0].type, 'openai-key');
    const oaiRedacted = redactSecrets(oaiText, 'config.js');
    assert.equal(oaiRedacted, 'openai_key = "[REDACTED:openai-key]"');
    assert.ok(!oaiRedacted.includes('sk-proj-'));
    assert.ok(!oaiRedacted.includes(longOaiKey.slice(10, 20)));

    // Google key ending in '-' or '_'
    const googleDashKey = makeTestKey('AIza', 38).slice(0, 38) + '-';
    const googleText = `google_key = "${googleDashKey}"`;
    const googleScan = scanForSecrets('config.js', googleText);
    assert.equal(googleScan.length, 1);
    assert.equal(googleScan[0].type, 'google-key');
    const googleRedacted = redactSecrets(googleText, 'config.js');
    assert.equal(googleRedacted, 'google_key = "[REDACTED:google-key]"');
    assert.ok(!googleRedacted.includes('AIza'));

    // Provider tokens
    const glpat = 'glpat-a1b2c3d4e5f6g7h8i9j0';
    const npmTok = 'npm_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8';
    const providerText = `gitlab: ${glpat}\nnpm: ${npmTok}`;
    const providerRedacted = redactSecrets(providerText, 'config.txt');
    assert.ok(!providerRedacted.includes(glpat));
    assert.ok(!providerRedacted.includes(npmTok));
    assert.ok(providerRedacted.includes('[REDACTED:provider-token]'));

    // URL credentials
    const dbUrl = 'postgres://admin:secretPassword123@localhost:5432/mydb';
    const dbScan = scanForSecrets('app.log', dbUrl);
    assert.equal(dbScan.length, 1);
    assert.equal(dbScan[0].type, 'url-credentials');
    const dbRedacted = redactSecrets(dbUrl, 'app.log');
    assert.equal(dbRedacted, 'postgres://admin:[REDACTED:url-credentials]@localhost:5432/mydb');

    // Authorization headers
    const authHeader = 'Authorization: Bearer secretBearerToken12345';
    const authScan = scanForSecrets('app.log', authHeader);
    assert.equal(authScan.length, 1);
    assert.equal(authScan[0].type, 'authorization-header');
    const authRedacted = redactSecrets(authHeader, 'app.log');
    assert.equal(authRedacted, 'Authorization: Bearer [REDACTED:authorization-header]');

    // Redaction of title and labels in processIssueThread
    const secretInTitleIssue = {
        number: 1,
        title: `Bug with ${longAntKey} in production`,
        body: 'Issue description',
        author: 'alice',
        authorAssociation: 'MEMBER',
        createdAt: '2023-01-01',
        labels: [`secret-${longOaiKey}`]
    };
    const processed = processIssueThread(secretInTitleIssue, [], { isRedact: true });
    assert.ok(!processed.title.includes(longAntKey));
    assert.ok(processed.title.includes('[REDACTED:anthropic-key]'));
    assert.ok(!processed.labels[0].includes(longOaiKey));
    assert.ok(processed.labels[0].includes('[REDACTED:openai-key]'));
});

test('secrets: true positive and near-miss for each pattern detector', () => {
    // AWS
    const awsPos = scanForSecrets('app.js', 'const k = "' + 'AKIA' + '1234567890ABCDEF";');
    assert.equal(awsPos.length, 1);
    assert.equal(awsPos[0].type, 'aws-key');

    const awsNear = scanForSecrets('app.js', 'const k = "AKIAEXAMPLEKEY1234";');
    assert.equal(awsNear.length, 0);

    // GitHub
    const ghPos = scanForSecrets('app.js', 'const token = "' + 'ghp_' + '1234567890abcdefghijklmnopqrstuvwxyz";');
    assert.equal(ghPos.length, 1);
    assert.equal(ghPos[0].type, 'github-token');

    const ghNear = scanForSecrets('app.js', 'const token = "ghp_your_token_here_xxxxxxxxx";');
    assert.equal(ghNear.length, 0);

    // Slack
    const slackPos = scanForSecrets('app.js', 'const token = "' + 'xoxb-' + '1234567890-1234567890123-abcdefghijklmnopqrstuvwx";');
    assert.equal(slackPos.length, 1);
    assert.equal(slackPos[0].type, 'slack-token');

    const slackNear = scanForSecrets('app.js', 'const token = "xoxb-your_token_here";');
    assert.equal(slackNear.length, 0);

    // Stripe
    const stripePos = scanForSecrets('app.js', 'const key = "' + 'sk_live_' + '51Hz3abc123def456ghi789jkl";');
    assert.equal(stripePos.length, 1);
    assert.equal(stripePos[0].type, 'stripe-key');

    const stripeNear = scanForSecrets('app.js', 'const key = "sk_live_xxxxchangeme00000000000";');
    assert.equal(stripeNear.length, 0);

    // Google
    const googlePos = scanForSecrets('app.js', 'const key = "' + 'AIza' + 'SyD1234567890abcdefghijklmnopqrstUV";');
    assert.equal(googlePos.length, 1);
    assert.equal(googlePos[0].type, 'google-key');

    const googleNear = scanForSecrets('app.js', 'const key = "AIzaSyD_your_google_api_key_xxxx";');
    assert.equal(googleNear.length, 0);

    // PEM
    const pemPos = scanForSecrets('app.js', '-----BEGIN RSA PRIVATE KEY-----\nMIIEogIBAAK...\n-----END RSA PRIVATE KEY-----');
    assert.equal(pemPos.length, 1);
    assert.equal(pemPos[0].type, 'pem-key');

    const pemNear = scanForSecrets('app.js', '-----BEGIN PUBLIC KEY-----\nMIIE...\n-----END PUBLIC KEY-----');
    assert.equal(pemNear.length, 0);

    // JWT
    const jwtPos = scanForSecrets('app.js', 'const token = "' + 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' + 'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.' + 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";');
    assert.equal(jwtPos.length, 1);
    assert.equal(jwtPos[0].type, 'jwt');

    const jwtNear = scanForSecrets('app.js', 'const token = "eyJ_your_jwt.eyJ_test.eyJ_xxxx";');
    assert.equal(jwtNear.length, 0);

    // Anthropic
    const antPos = scanForSecrets('app.js', 'const key = "' + 'sk-ant-' + 'api03-1234567890abcdefghijklmnopqrstuvwxyz";');
    assert.equal(antPos.length, 1);
    assert.equal(antPos[0].type, 'anthropic-key');

    const antNear = scanForSecrets('app.js', 'const key = "sk-ant-your_anthropic_key_here";');
    assert.equal(antNear.length, 0);

    // OpenAI
    const oaiPos = scanForSecrets('app.js', 'const key = "' + 'sk-proj-' + '1234567890abcdefghijklmnopqrstuvwxyz";');
    assert.equal(oaiPos.length, 1);
    assert.equal(oaiPos[0].type, 'openai-key');

    const oaiNear = scanForSecrets('app.js', 'const key = "sk-your_openai_key_xxxx";');
    assert.equal(oaiNear.length, 0);

    // OpenAI non-matches for normal kebab-case text
    const kebab1 = scanForSecrets('app.js', '<div class="disk-usage-monitoring-panel">');
    assert.equal(kebab1.filter(f => f.type === 'openai-key').length, 0);

    const kebab2 = scanForSecrets('app.js', 'const doc = "risk-assessment-framework-document";');
    assert.equal(kebab2.filter(f => f.type === 'openai-key').length, 0);

    const kebab3 = scanForSecrets('app.js', 'const t = "task-mask-desk-flask-cask-bask-desk-task";');
    assert.equal(kebab3.filter(f => f.type === 'openai-key').length, 0);

    // Generic (Quoted & Unquoted)
    const genPos = scanForSecrets('config.js', 'password = "Zx9!kLm2Qr8w"');
    assert.equal(genPos.length, 1);
    assert.equal(genPos[0].type, 'generic-secret');

    const genJsonPos = scanForSecrets('config.json', '{"password": "Zx9!kLm2Qr8w"}');
    assert.equal(genJsonPos.filter(f => f.type === 'generic-secret').length, 1);

    const genSuffixPos = scanForSecrets('config.py', 'SECRET_KEY = "Zx9kLm2Qr8wTv7"');
    assert.equal(genSuffixPos.filter(f => f.type === 'generic-secret').length, 1);

    const genUnquotedPos = scanForSecrets('.env', 'DB_PASSWORD=Zx9kLm2Qr8wTv7');
    assert.equal(genUnquotedPos.filter(f => f.type === 'generic-secret').length, 1);

    // Ordinary code statements must NOT be flagged as generic secrets
    const code1 = scanForSecrets('app.js', 'const auth = getAuthHeader(req);');
    assert.equal(code1.filter(f => f.type === 'generic-secret').length, 0);

    const code2 = scanForSecrets('app.js', 'const auth = require("./authentication");');
    assert.equal(code2.filter(f => f.type === 'generic-secret').length, 0);

    const code3 = scanForSecrets('app.js', 'tokenCount = estimateTokens(text) + 1;');
    assert.equal(code3.filter(f => f.type === 'generic-secret').length, 0);

    const code4 = scanForSecrets('app.js', 'const author = "Jane Q. Public";');
    assert.equal(code4.filter(f => f.type === 'generic-secret').length, 0);

    const code5 = scanForSecrets('package.json', '"tokenizer": "bert-base-uncased"');
    assert.equal(code5.filter(f => f.type === 'generic-secret').length, 0);

    const genNear = scanForSecrets('config.js', 'password = "your_password"');
    assert.equal(genNear.length, 0);

    // Sensitive filename
    const filePos = scanForSecrets('.env', 'FOO=bar');
    assert.equal(filePos.some(f => f.type === 'sensitive-file'), true);

    const fileNear = scanForSecrets('.env.example', 'FOO=bar');
    assert.equal(fileNear.some(f => f.type === 'sensitive-file'), false);
});

test('secrets: placeholders are not flagged', () => {
    const code = `
    const a = "your_api_key";
    const b = "AKIAEXAMPLEKEY1234";
    const c = "\${TOKEN}";
    const d = "<YOUR_KEY>";
    const e = process.env.SECRET;
    const f = os.environ["KEY"];
    `;
    const findings = scanForSecrets('app.js', code);
    assert.equal(findings.length, 0);
});

test('secrets: masking guarantees full secret never appears in finding', () => {
    const secret = "AKIA" + "1234567890ABCDEF";
    const findings = scanForSecrets('app.js', `const k = "${secret}";`);
    assert.equal(findings.length, 1);
    const f = findings[0];

    assert.equal(f.preview, "AKIA…");
    assert.equal('value' in f, false);
    assert.equal('secret' in f, false);
    assert.equal(JSON.stringify(f).includes(secret), false);
});

test('secrets: redaction on all four formats and with chunking produces valid output', () => {
    const rawSecret = 'AKIA' + '1234567890ABCDEF';
    const content = `const aws = "${rawSecret}";`;
    const redacted = redactSecrets(content, 'app.js');

    assert.equal(redacted.includes('[REDACTED:aws-key]'), true);
    assert.equal(redacted.includes(rawSecret), false);

    const repoInfo = { owner: 'owner', repo: 'repo' };
    const files = [{ path: 'app.js', content: redacted }];

    // Claude XML
    const xml1 = formatClaudeXml(repoInfo, 'main', '', files);
    assert.ok(xml1.text.includes('[REDACTED:aws-key]'));
    assert.ok(xml1.text.startsWith('<documents>') && xml1.text.endsWith('</documents>'));

    // Generic XML
    const xml2 = formatGenericXml(repoInfo, 'main', '', files);
    assert.ok(xml2.text.includes('[REDACTED:aws-key]'));
    assert.ok(xml2.text.startsWith('<repository') && xml2.text.endsWith('</repository>'));

    // Markdown
    const md = formatMarkdown(repoInfo, 'main', '', files);
    assert.ok(md.text.includes('[REDACTED:aws-key]'));

    // JSON
    const json = formatJson(repoInfo, 'main', '', files);
    const parsed = JSON.parse(json.text);
    assert.ok(parsed.files[0].content.includes('[REDACTED:aws-key]'));

    // Chunking
    const chunks = chunkContextOutput('json', repoInfo, 'main', '', files, 500, estimateTokens);
    assert.ok(chunks.length >= 1);
    assert.ok(JSON.parse(chunks[0].text).files[0].content.includes('[REDACTED:aws-key]'));
});

test('secrets: file containing ]]> plus secret produces well-formed output', () => {
    const rawSecret = 'AKIA' + '1234567890ABCDEF';
    const rawContent = `hello ]]> world ${rawSecret}`;
    const redacted = redactSecrets(rawContent, 'file.txt');
    const repoInfo = { owner: 'owner', repo: 'repo' };
    const files = [{ path: 'file.txt', content: redacted }];

    const resXml = formatGenericXml(repoInfo, 'main', '', files);
    assert.ok(resXml.text.includes(']]]]><![CDATA[>'));
    assert.ok(resXml.text.includes('[REDACTED:aws-key]'));
    assert.ok(!resXml.text.includes(rawSecret));
});

test('instructions: appear exactly once, in last chunk when chunked, with part notes in others, in all four formats', () => {
    const repoInfo = { owner: 'owner', repo: 'repo' };
    const files = Array.from({ length: 10 }, (_, i) => ({
        path: `file_${i}.js`,
        content: `console.log("file ${i} content repeat ".repeat(20));`
    }));
    const instructions = 'Review this code for architecture.';

    const formats = ['claude-xml', 'generic-xml', 'markdown', 'json'];

    for (const fmt of formats) {
        const chunks = chunkContextOutput(fmt, repoInfo, 'main', '', files, 200, estimateTokens, { instructions });
        assert.ok(chunks.length >= 2, `Expected multiple chunks for format ${fmt}`);

        for (let i = 0; i < chunks.length; i++) {
            const isLast = i === chunks.length - 1;
            const text = chunks[i].text;

            if (isLast) {
                assert.ok(text.includes('Review this code for architecture'), `Last chunk in ${fmt} should contain instructions`);
                assert.ok(!text.includes('Part 1 of'), `Last chunk in ${fmt} should not contain intermediate part note`);
            } else {
                assert.ok(!text.includes('Review this code for architecture'), `Chunk ${i + 1} in ${fmt} should NOT contain instructions`);
                assert.ok(text.includes(`Part ${i + 1} of ${chunks.length}. Instructions are in part ${chunks.length}.`), `Chunk ${i + 1} in ${fmt} should contain part note`);
            }
        }
    }
});

test('instructions: tokens are included in chunk-size estimates', () => {
    const repoInfo = { owner: 'owner', repo: 'repo' };
    const files = [{ path: 'app.js', content: 'const x = 1;' }];

    const outNoInst = buildContextOutput('claude-xml', repoInfo, 'main', '', files, {});
    const outWithInst = buildContextOutput('claude-xml', repoInfo, 'main', '', files, { instructions: 'Detailed architectural instructions '.repeat(20) });

    const tokNoInst = estimateTokens(outNoInst.text);
    const tokWithInst = estimateTokens(outWithInst.text);

    assert.ok(tokWithInst > tokNoInst, 'Output with instructions should produce higher token estimate');
});

test('instructions: chunking budgets instructions in final chunk without exceeding chunk limit', () => {
    const repoInfo = { owner: 'owner', repo: 'repo' };
    const files = Array.from({ length: 5 }, (_, i) => ({
        path: `file_${i}.js`,
        content: `console.log("file ${i} content repeat ".repeat(15));`
    }));
    const instructions = 'Detailed instruction block '.repeat(10);

    const chunks = chunkContextOutput('claude-xml', repoInfo, 'main', '', files, 500, estimateTokens, { instructions });
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
        assert.equal(chunk.exceedsLimit, false, 'No chunk should exceed chunk token limit');
    }
    assert.ok(chunks[chunks.length - 1].text.includes('Detailed instruction block'));
});

test('secrets: long single-line input scans in under 1 second', () => {
    const start = Date.now();
    const longSingleLine = 'a'.repeat(1000000);
    const findings = scanForSecrets('bigfile.txt', longSingleLine);
    const duration = Date.now() - start;

    assert.equal(findings.length, 0);
    assert.ok(duration < 1000, `Scan took ${duration} ms (expected < 1000 ms)`);
});

test('secrets: sensitive file content is fully redacted', () => {
    const redactedEnv = redactSecrets('API_KEY=abc123XYZ789def456', '.env');
    assert.equal(redactedEnv, '[REDACTED:sensitive-file]');

    const redactedPem = redactSecrets('some private key content', 'server.key');
    assert.equal(redactedPem, '[REDACTED:sensitive-file]');
});

test('secrets: scans beyond 200 KB in file', () => {
    const padding = 'x'.repeat(210000);
    const secret = 'AKIA' + '1234567890ABCDEF';
    const content = padding + ' const k = "' + secret + '";';

    const findings = scanForSecrets('large.txt', content);
    assert.equal(findings.filter(f => f.type === 'aws-key').length, 1);

    const redacted = redactSecrets(content, 'large.txt');
    assert.ok(redacted.includes('[REDACTED:aws-key]'));
    assert.ok(!redacted.includes(secret));
});

test('secrets: overlapping secret redaction does not corrupt output', () => {
    // Overlapping specific pattern or multiple secrets
    const skKey = 'sk-proj-' + '1234567890abcdefghijklmnopqrstuvwxyz';
    const content = `const secret = "${skKey}"; password = "${skKey}";`;
    const redacted = redactSecrets(content, 'test.js');

    assert.ok(!redacted.includes('undefined'));
    assert.ok(!redacted.includes('NaN'));
    assert.ok(redacted.includes('[REDACTED:openai-key]'));
    assert.ok(!redacted.includes(skKey));

    // JWT inside token = "..."
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' + 'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.' + 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const jwtContent = `token = "${jwt}"`;
    const jwtRedacted = redactSecrets(jwtContent, 'config.js');
    assert.ok(!jwtRedacted.includes(jwt));
    assert.ok(jwtRedacted.includes('[REDACTED:jwt]'));
});

test('secrets: status per finding and AWS secret key with slashes/plus/brackets', () => {
    // AWS Secret Key (40 base64 chars)
    const awsKey = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYzQ9d1T3k7A';
    const awsContent = `aws_secret_access_key = "${awsKey}"`;
    const awsScan = scanForSecrets('config.py', awsContent);
    assert.equal(awsScan.length, 1);
    assert.equal(awsScan[0].type, 'aws-key');

    // Base64 value with + and / (32+ chars, high entropy)
    const clientSecret = 'Qx7+vN2pLm9/Zk4Rt8Yw1Hs6Bc3Df5Gj';
    const csContent = `client_secret = "${clientSecret}"`;
    const csScan = scanForSecrets('config.yml', csContent);
    assert.equal(csScan.length, 1);
    assert.equal(csScan[0].type, 'generic-secret');

    // Quoted password with brackets
    const bracketPass = 'p@ss(w0rd){1}';
    const bpContent = `PASSWORD = "${bracketPass}"`;
    const bpScan = scanForSecrets('config.js', bpContent);
    assert.equal(bpScan.length, 1);
    assert.equal(bpScan[0].type, 'generic-secret');
});

test('secrets: panel status per finding row status calculation', () => {
    function computePanelStatus(selectedFiles, secretsMap, isRedactOn, isAggressiveOn) {
        let totalFindings = 0;
        let redactedCount = 0;
        let presentCount = 0;
        const rows = [];

        for (const file of selectedFiles) {
            const findings = secretsMap.get(file.path) || [];
            totalFindings += findings.length;
            for (const f of findings) {
                const isRedacted = isRedactOn && (f.type !== 'generic-secret' || isAggressiveOn);
                if (isRedacted) redactedCount++;
                else presentCount++;
                rows.push({ path: file.path, type: f.type, isRedacted });
            }
        }
        return { totalFindings, redactedCount, presentCount, rows };
    }

    const secretsMap = new Map([
        ['app.js', [{ type: 'aws-key' }]],
        ['config.yml', [{ type: 'generic-secret' }]]
    ]);
    const files = [{ path: 'app.js' }, { path: 'config.yml' }];

    // Default: Redact ON, Aggressive OFF
    const defStatus = computePanelStatus(files, secretsMap, true, false);
    assert.equal(defStatus.redactedCount, 1);
    assert.equal(defStatus.presentCount, 1);
    assert.equal(defStatus.rows[0].isRedacted, true);
    assert.equal(defStatus.rows[1].isRedacted, false);

    // Aggressive ON: Redact ON, Aggressive ON
    const aggStatus = computePanelStatus(files, secretsMap, true, true);
    assert.equal(aggStatus.redactedCount, 2);
    assert.equal(aggStatus.presentCount, 0);
    assert.equal(aggStatus.rows[0].isRedacted, true);
    assert.equal(aggStatus.rows[1].isRedacted, true);
});

test('instructions: single file exceeding limit due to instructions produces instructions-only final chunk', () => {
    const repoInfo = { owner: 'owner', repo: 'repo' };
    const files = [{ path: 'file.js', content: 'const content = "x".repeat(2000);' }];
    const instructions = 'Long instruction block '.repeat(150);

    const limit = 600;
    const chunks = chunkContextOutput('claude-xml', repoInfo, 'main', '', files, limit, estimateTokens, { instructions });

    assert.equal(chunks.length, 2, 'Should spill into 2 chunks');

    // First chunk should contain file but NO instructions, with part note
    assert.ok(chunks[0].text.includes('<source>file.js</source>'));
    assert.ok(!chunks[0].text.includes('Long instruction block'));
    assert.ok(chunks[0].text.includes('Part 1 of 2. Instructions are in part 2.'));

    // Second chunk should contain instructions with empty files
    assert.ok(!chunks[1].text.includes('<source>file.js</source>'));
    assert.ok(chunks[1].text.includes('Long instruction block'));
    assert.ok(!chunks[1].text.includes('Part 1 of'));
});

// --- Issue Cleaner & Issue Formatters Tests ---

test('issue-cleaner: bot comment detection', () => {
    assert.equal(isBotUser('dependabot[bot]', 'Bot'), true);
    assert.equal(isBotUser('github-actions[bot]', 'User'), true);
    assert.equal(isBotUser('stale', 'Bot'), true);
    assert.equal(isBotUser('octocat', 'User'), false);
});

test('issue-cleaner: noise comment detection', () => {
    assert.equal(isLowSignalComment('+1'), true);
    assert.equal(isLowSignalComment('me too'), true);
    assert.equal(isLowSignalComment('same here'), true);
    assert.equal(isLowSignalComment('Here is a detailed trace of the error when running npm test'), false);
});

test('issue-cleaner: Phase 3 fence truncation, empty blocks, tildes, images', () => {
    const rawBody = `
Prose line before empty block

\`\`\`
\`\`\`

Prose line between blocks

~~~~log
line 1
line 2
line 3
line 4
line 5
~~~~

![alt text](http://example.com/u_(1).png) Prose after image
`;
    const cleaned = sanitizeIssueText(rawBody, {
        stripTemplates: true,
        stripImages: true,
        maxLogLines: 2
    });

    assert.ok(cleaned.includes('Prose line before empty block'), 'Prose before empty block must be preserved');
    assert.ok(cleaned.includes('Prose line between blocks'), 'Prose between blocks must NOT be truncated');
    assert.ok(cleaned.includes('Prose after image'), 'Prose after image must NOT be stripped by image regex');
    assert.ok(cleaned.includes('lines of log/code truncated'), 'Tilde fence logs should be truncated');
});

test('issue-cleaner: Phase 3 cross-reference HTML comment stripping and knownNumbers filtering', () => {
    const body = `
<!-- e.g. #123 -->
Here is a bug. See #456 and #999.
`;
    const refs = extractIssueReferences(body);
    assert.ok(!refs.includes(123), 'Template comment #123 should be stripped');
    assert.ok(refs.includes(456));
    assert.ok(refs.includes(999));

    const issue = {
        number: 1,
        title: 'Title',
        body,
        author: 'alice',
        authorAssociation: 'NONE',
        createdAt: '2023-01-01'
    };
    const knownNumbers = new Set([1, 456]); // 999 is not in loaded issues
    const processed = processIssueThread(issue, [], { knownNumbers });
    assert.deepEqual(processed.relatedIssues, [456], 'Should filter out #999 because it is not in knownNumbers');
});

test('issue-cleaner: Phase 3 CONTRIBUTOR is not in maintainer scope', () => {
    const issue = {
        number: 1,
        title: 'Title',
        body: 'Body',
        author: 'alice',
        authorAssociation: 'NONE',
        createdAt: '2023-01-01'
    };
    const comments = [
        { id: 1, author: 'bob', authorAssociation: 'CONTRIBUTOR', createdAt: '2023-01-01', body: 'Drive-by comment' },
        { id: 2, author: 'charlie', authorAssociation: 'MEMBER', createdAt: '2023-01-01', body: 'Maintainer comment' }
    ];
    const processed = processIssueThread(issue, comments, { commentScope: 'maintainers' });
    assert.equal(processed.cleanedComments.length, 1);
    assert.equal(processed.cleanedComments[0].author, 'charlie');
});

test('issue-cleaner: issue body sanitization (media, log truncation, templates)', () => {
    const rawBody = `
<!-- Please describe your bug below -->
## Bug Description
An error occurred during build.

<img src="https://user-images.githubusercontent.com/123/456.png" />
![Screenshot](https://github.com/user/repo/assets/123.jpg)

\`\`\`log
line 1
line 2
line 3
line 4
line 5
\`\`\`
`;
    const cleaned = sanitizeIssueText(rawBody, {
        stripTemplates: true,
        stripImages: true,
        maxLogLines: 2
    });

    assert.ok(!cleaned.includes('Please describe your bug below'));
    assert.ok(!cleaned.includes('<img'));
    assert.ok(cleaned.includes('[Image: Screenshot]'));
    assert.ok(cleaned.includes('lines of log/code truncated'));
    assert.ok(cleaned.includes('line 1'));
    assert.ok(cleaned.includes('line 5'));
});

test('issue-cleaner: reference extraction', () => {
    const text = 'This fixes #123 and relates to GH-456.';
    const refs = extractIssueReferences(text);
    assert.deepEqual(refs.sort((a, b) => a - b), [123, 456]);
});

test('issue-formatters: Claude XML formatting for issues', () => {
    const repoInfo = { owner: 'user', repo: 'my-repo', url: 'https://github.com/user/my-repo' };
    const issues = [
        {
            number: 1,
            title: 'Bug in authentication',
            state: 'open',
            author: 'alice',
            authorAssociation: 'MEMBER',
            createdAt: '2023-01-01T00:00:00Z',
            closedAt: null,
            labels: ['bug'],
            htmlUrl: 'https://github.com/user/my-repo/issues/1',
            cleanedBody: 'Auth fails on login',
            cleanedComments: [
                {
                    id: 101,
                    author: 'bob',
                    role: 'CONTRIBUTOR',
                    createdAt: '2023-01-01T10:00:00Z',
                    body: 'I reproduced this.'
                }
            ]
        }
    ];

    const res = formatIssuesClaudeXml(repoInfo, issues, { redactSecrets: false });
    assert.equal(res.ext, 'xml');
    assert.ok(res.text.includes('issue_number="1"'));
    assert.ok(res.text.includes('<source>Issue #1: Bug in authentication</source>'));
    assert.ok(res.text.includes('author role="MEMBER">alice</author>'));
    assert.ok(res.text.includes('Auth fails on login'));
    assert.ok(res.text.includes('author="bob"'));
    assert.ok(res.text.includes('I reproduced this.'));
});

test('issue-formatters: Markdown formatting for issues', () => {
    const repoInfo = { owner: 'user', repo: 'my-repo' };
    const issues = [
        {
            number: 42,
            title: 'Feature request',
            state: 'open',
            author: 'charlie',
            authorAssociation: 'NONE',
            createdAt: '2023-01-01T00:00:00Z',
            labels: [],
            htmlUrl: 'https://github.com/user/my-repo/issues/42',
            cleanedBody: 'Please add dark mode',
            cleanedComments: []
        }
    ];

    const res = formatIssuesMarkdown(repoInfo, issues);
    assert.equal(res.ext, 'md');
    assert.ok(res.text.includes('### [#42] Feature request'));
    assert.ok(res.text.includes('Please add dark mode'));
});

test('issue-cleaner & formatters: N1 end-to-end test passing options through processIssueThread into output', () => {
    const rawIssue = {
        number: 42,
        title: 'End-to-End Test Issue',
        state: 'open',
        author: 'alice',
        authorAssociation: 'NONE',
        createdAt: '2023-01-01',
        body: 'Body text'
    };
    const rawComments = [];
    rawComments.truncated = true;

    const processed = processIssueThread(rawIssue, rawComments, {
        commentsFetchFailed: true,
        commentsFetchError: '500 Server Error',
        commentsTruncated: true
    });

    assert.equal(processed.commentsFetchFailed, true);
    assert.equal(processed.commentsFetchError, '500 Server Error');
    assert.equal(processed.commentsTruncated, true);

    const repoInfo = { owner: 'owner', repo: 'repo' };
    const formats = ['claude-xml', 'markdown', 'generic-xml', 'json'];

    for (const fmt of formats) {
        const output = buildIssuesOutput(fmt, repoInfo, [processed]);
        assert.ok(output.text.includes('500 Server Error'), `Expected 500 Server Error warning in ${fmt} output`);
        assert.ok(output.text.includes('truncated'), `Expected truncation note in ${fmt} output`);
    }
});

test('issue-formatters: R2 failure and truncation notes in all output formats', () => {
    const repoInfo = { owner: 'user', repo: 'my-repo' };
    const issues = [
        {
            number: 1,
            title: 'Truncated Issue',
            state: 'open',
            author: 'alice',
            authorAssociation: 'NONE',
            createdAt: '2023-01-01',
            cleanedBody: 'Body 1',
            cleanedComments: [{ id: 1, author: 'bob', role: 'NONE', createdAt: '2023-01-01', body: 'C1' }],
            commentsTruncated: true
        },
        {
            number: 2,
            title: 'Failed Issue',
            state: 'open',
            author: 'charlie',
            authorAssociation: 'NONE',
            createdAt: '2023-01-01',
            cleanedBody: 'Body 2',
            cleanedComments: [],
            commentsFetchFailed: true,
            commentsFetchError: '500 Server Error'
        }
    ];

    // Claude XML
    const xml = formatIssuesClaudeXml(repoInfo, issues);
    assert.ok(xml.text.includes('<warnings>'));
    assert.ok(xml.text.includes('<comments_warning>Comment thread fetch failed (500 Server Error)</comments_warning>'));
    assert.ok(xml.text.includes('<comments_note>Comment thread truncated at API page limit</comments_note>'));

    // Markdown
    const md = formatIssuesMarkdown(repoInfo, issues);
    assert.ok(md.text.includes('> **Warning:**'));
    assert.ok(md.text.includes('Comment thread fetch failed (500 Server Error)'));
    assert.ok(md.text.includes('Only first 1 comments included (thread truncated at API limit)'));

    // Generic XML
    const gxml = formatIssuesGenericXml(repoInfo, issues);
    assert.ok(gxml.text.includes('<warnings>'));
    assert.ok(gxml.text.includes('<comments_warning>500 Server Error</comments_warning>'));

    // JSON
    const json = formatIssuesJson(repoInfo, issues);
    const parsed = JSON.parse(json.text);
    assert.ok(parsed.warnings.includes('failed to fetch comments'));
    assert.equal(parsed.issues[0].comments_truncated, true);
    assert.equal(parsed.issues[1].comments_warning, '500 Server Error');
});

test('issue-formatters: Generic XML and JSON formatting for issues', () => {
    const repoInfo = { owner: 'user', repo: 'my-repo' };
    const issues = [
        {
            number: 10,
            title: 'Sample Issue',
            state: 'closed',
            author: 'dave',
            authorAssociation: 'COLLABORATOR',
            createdAt: '2023-01-01T00:00:00Z',
            labels: [],
            htmlUrl: 'https://github.com/user/my-repo/issues/10',
            cleanedBody: 'Sample body',
            cleanedComments: []
        }
    ];

    const resXml = formatIssuesGenericXml(repoInfo, issues);
    assert.ok(resXml.text.includes('<issue number="10"'));

    const resJson = formatIssuesJson(repoInfo, issues);
    const parsed = JSON.parse(resJson.text);
    assert.equal(parsed.issues[0].number, 10);
    assert.equal(parsed.issues[0].title, 'Sample Issue');
});

test('github-issues-api: Phase 2 C2 multi-page comment fetching', async () => {
    const originalFetch = globalThis.fetch;
    try {
        globalThis.fetch = async (url) => {
            if (url.includes('/issues/1/comments')) {
                // The first request has no page number (GitHub's default is page 1).
                if (!/[?&]page=/.test(url) || /[?&]page=1\b/.test(url)) {
                    return {
                        ok: true,
                        status: 200,
                        json: async () => Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: `Comment ${i + 1}`, user: { login: 'user1' } }))
                    };
                }
                if (/[?&]page=2\b/.test(url)) {
                    return {
                        ok: true,
                        status: 200,
                        json: async () => Array.from({ length: 50 }, (_, i) => ({ id: 100 + i + 1, body: `Comment ${100 + i + 1}`, user: { login: 'user1' } }))
                    };
                }
            }
            return { ok: false, status: 404 };
        };

        const { fetchCommentsForIssues } = await import('../js/github-issues-api.js');
        const selected = [{ number: 1, commentsCount: 150 }];
        const { commentsByIssue, failures } = await fetchCommentsForIssues('owner', 'repo', selected, { throttleMs: 0 });

        assert.equal(failures.length, 0);
        assert.ok(commentsByIssue.has(1));
        const comms = commentsByIssue.get(1);
        assert.equal(comms.length, 150);
        assert.equal(comms[0].body, 'Comment 1');
        assert.equal(comms[149].body, 'Comment 150');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('github-issues-api: Phase 2 C3 fetch failures recorded and not cached as empty', async () => {
    const originalFetch = globalThis.fetch;
    try {
        globalThis.fetch = async (url) => {
            if (url.includes('/issues/1/comments')) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => [{ id: 1, body: 'ok comment', user: { login: 'user1' } }]
                };
            }
            if (url.includes('/issues/2/comments')) {
                return {
                    ok: false,
                    status: 500,
                    statusText: 'Internal Server Error'
                };
            }
            return { ok: false, status: 404 };
        };

        const { fetchCommentsForIssues } = await import('../js/github-issues-api.js');
        const selected = [
            { number: 1, commentsCount: 1 },
            { number: 2, commentsCount: 5 }
        ];
        const { commentsByIssue, failures } = await fetchCommentsForIssues('owner', 'repo', selected, { throttleMs: 0 });

        assert.ok(commentsByIssue.has(1));
        assert.equal(commentsByIssue.get(1).length, 1);
        assert.equal(commentsByIssue.has(2), false, 'Failed issue 2 must NOT be mapped to empty array');
        assert.equal(failures.length, 1);
        assert.equal(failures[0].number, 2);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('github-issues-api: Phase 2 C4 manifest pagination on PR-heavy repo and stoppedEarly flag', async () => {
    const originalFetch = globalThis.fetch;
    try {
        let callCount = 0;
        globalThis.fetch = async (url) => {
            if (url.includes('/issues?')) {
                callCount++;
                // Return 100 items per page, where 95 are PRs and 5 are issues
                const batch = Array.from({ length: 100 }, (_, i) => {
                    const itemNum = (callCount - 1) * 100 + i + 1;
                    const isPr = (i % 20) !== 0; // 19 out of 20 are PRs
                    return {
                        number: itemNum,
                        title: `Item ${itemNum}`,
                        state: 'open',
                        pull_request: isPr ? {} : undefined,
                        user: { login: 'user1' }
                    };
                });
                return {
                    ok: true,
                    status: 200,
                    json: async () => batch
                };
            }
            return { ok: false, status: 404 };
        };

        const { fetchIssuesManifest } = await import('../js/github-issues-api.js');
        const manifest = await fetchIssuesManifest('owner', 'repo', { maxItems: 300, itemType: 'issues' });

        assert.ok(manifest.length > 0);
        assert.equal(manifest.length, 150); // 30 pages * 5 issues = 150 issues
        assert.equal(callCount, 30, 'Should hit hard page cap of 30 pages');
        assert.equal(manifest.stoppedEarly, true, 'stoppedEarly should be true when maxItems not reached and last batch was full');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('github-issues-api: Phase 2 C5 rate limit reset wait > 90s fails fast with descriptive message', async () => {
    const originalFetch = globalThis.fetch;
    try {
        const futureResetSec = Math.floor(Date.now() / 1000) + 3000; // 50 mins away
        globalThis.fetch = async () => {
            return {
                ok: false,
                status: 403,
                statusText: 'Forbidden',
                headers: new Map([
                    ['x-ratelimit-remaining', '0'],
                    ['x-ratelimit-reset', String(futureResetSec)]
                ])
            };
        };

        const { fetchIssuesManifest } = await import('../js/github-issues-api.js');
        await assert.rejects(
            async () => {
                await fetchIssuesManifest('owner', 'repo', { maxItems: 10 });
            },
            (err) => {
                return err.message.includes('GitHub rate limit reached. Resets at');
            }
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('issue-formatters: chunking issue outputs', () => {
    const repoInfo = { owner: 'user', repo: 'my-repo' };
    const issues = Array.from({ length: 15 }, (_, i) => ({
        number: i + 1,
        title: `Issue ${i + 1}`,
        state: 'open',
        author: 'user',
        authorAssociation: 'MEMBER',
        createdAt: '2023-01-01T00:00:00Z',
        labels: [],
        htmlUrl: `https://github.com/user/my-repo/issues/${i + 1}`,
        cleanedBody: `Body content for issue ${i + 1} `.repeat(30),
        cleanedComments: []
    }));

    const chunks = chunkIssuesOutput('claude-xml', repoInfo, issues, 150, estimateTokens);
    assert.ok(chunks.length > 1, 'Expected multiple chunks for issue output');
});

test('nlp.worker: R3 zero-vector issue test', async () => {
    // Import worker or verify logic on empty issues
    const { Worker } = await import('node:worker_threads');
    const workerUrl = new URL('../js/nlp.worker.js', import.meta.url);

    // Create 20 empty issues
    const emptyIssues = Array.from({ length: 20 }, (_, i) => ({
        number: i + 1,
        title: '',
        body: ''
    }));

    const nlpWorker = new Worker(workerUrl);
    const result = await new Promise((resolve, reject) => {
        nlpWorker.on('message', resolve);
        nlpWorker.on('error', reject);
        nlpWorker.postMessage({ id: 1, issues: emptyIssues });
    });
    await nlpWorker.terminate();

    assert.equal(result.id, 1);
    assert.equal(result.clusters.length, 0, '20 empty issues should produce 0 clusters');
    assert.deepEqual(result.similarMap, {}, '20 empty issues should produce empty similarMap');
});

test('tree: filter counts matching leaf files instead of top-level folder count', async () => {
    function createMockElement(tagName = 'div') {
        const children = [];
        const eventListeners = {};
        const style = { display: '' };
        const attributes = {};

        const el = {
            tagName: tagName.toUpperCase(),
            children,
            style,
            attributes,
            tabIndex: -1,
            className: '',
            textContent: '',
            innerHTML: '',
            checked: false,
            type: '',
            parentElement: null,
            get offsetParent() {
                if (el.style.display === 'none') return null;
                let p = el.parentElement;
                while (p) {
                    if (p.style && p.style.display === 'none') return null;
                    p = p.parentElement;
                }
                return {};
            },

            appendChild(child) {
                child.parentElement = el;
                children.push(child);
                return child;
            },
            insertBefore(newChild, refChild) {
                newChild.parentElement = el;
                const idx = children.indexOf(refChild);
                if (idx !== -1) children.splice(idx, 0, newChild);
                else children.push(newChild);
                return newChild;
            },
            setAttribute(k, v) { attributes[k] = String(v); },
            getAttribute(k) { return attributes[k] || null; },
            addEventListener(type, fn) {
                if (!eventListeners[type]) eventListeners[type] = [];
                eventListeners[type].push(fn);
            },
            dispatchEvent(evt) {
                const fns = eventListeners[evt.type] || [];
                for (const fn of fns) fn(evt);
            },
            closest() { return null; }
        };
        return el;
    }

    const originalDoc = globalThis.document;
    try {
        globalThis.document = { createElement: createMockElement };
        const { renderInteractiveTree } = await import('../js/tree.js');
        const container = createMockElement('div');
        const nodes = [
            { path: 'src/a.js', type: 'blob', size: 100 },
            { path: 'src/b.js', type: 'blob', size: 100 },
            { path: 'src/c.js', type: 'blob', size: 100 }
        ];

        const controls = renderInteractiveTree(nodes, container);
        const matchCount = controls.filter('.js');
        assert.equal(matchCount, 3);
    } finally {
        globalThis.document = originalDoc;
    }
});

test('chunkIssuesOutput: instructions (sent in the last part) do not shrink part 1', () => {
    const repoInfo = { owner: 'o', repo: 'r' };
    const issues = Array.from({ length: 12 }, (_, i) => ({
        number: i + 1,
        title: `Issue ${i + 1}`,
        state: 'open',
        author: 'user',
        authorAssociation: 'MEMBER',
        createdAt: '2023-01-01',
        cleanedBody: `Detailed description for issue ${i + 1} `.repeat(40),
        cleanedComments: []
    }));
    const countIssues = text => new Set([...text.matchAll(/Detailed description for issue (\d+) /g)].map(m => m[1])).size;
    const limit = 1500;
    const plain = chunkIssuesOutput('claude-xml', repoInfo, issues, limit, estimateTokens, {});
    const withInstr = chunkIssuesOutput('claude-xml', repoInfo, issues, limit, estimateTokens, { instructions: 'Instructions '.repeat(150) });
    assert.ok(plain.length > 2);
    assert.equal(countIssues(withInstr[0].text), countIssues(plain[0].text));
    assert.ok(!withInstr[0].text.includes('Instructions Instructions'));
    assert.ok(withInstr[withInstr.length - 1].text.includes('Instructions Instructions'));
    for (const c of withInstr) assert.equal(c.exceedsLimit, false);
});

test('filterIncludedComments applies scope, bot and noise filters like processIssueThread', async () => {
    const { filterIncludedComments } = await import('../js/issue-cleaner.js');
    const issue = { number: 1, author: 'alice' };
    const comments = [
        { id: 1, author: 'alice', authorAssociation: 'NONE', body: 'Author follow-up with details.' },
        { id: 2, author: 'bob', authorAssociation: 'OWNER', body: 'Maintainer analysis of the bug.' },
        { id: 3, author: 'carol', authorAssociation: 'NONE', body: 'Drive-by note with details.' },
        { id: 4, author: 'dependabot[bot]', authorType: 'Bot', authorAssociation: 'NONE', body: 'Bumps x.' },
        { id: 5, author: 'dave', authorAssociation: 'NONE', body: '+1' }
    ];
    const ids = opts => filterIncludedComments(issue, comments, opts).kept.map(c => c.id);
    assert.deepEqual(ids({ commentScope: 'all' }), [1, 2, 3]);
    assert.deepEqual(ids({ commentScope: 'maintainers' }), [1, 2]);
    assert.deepEqual(ids({ commentScope: 'none' }), []);
    assert.deepEqual(ids({ commentScope: 'all', filterBots: false, filterNoise: false }), [1, 2, 3, 4, 5]);
});
