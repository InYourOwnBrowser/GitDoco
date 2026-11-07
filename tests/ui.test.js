import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBannerItems, renderBanner } from '../js/ui-banner.js';
import { copyLabel } from '../js/ui-labels.js';
import { detectTarget, TARGETS } from '../js/targets.js';
import { buildSettingsSummary } from '../js/settings-summary.js';
import { commentCostHint } from '../js/comment-cost.js';
import { defaultExcludedPaths, rankSuggestions, DEFAULT_EXCLUDED_DIRS } from '../js/suggestions.js';
import { buildSummaryLines } from '../js/ui-summary.js';
import { buildTabHref } from '../js/nav.js';

test('targets: detectTarget identifies known targets and falls back to custom', () => {
    // 3 matches
    assert.equal(detectTarget('claude-xml', 200000), 'claude');
    assert.equal(detectTarget('markdown', 128000), 'chatgpt');
    assert.equal(detectTarget('markdown', 1000000), 'gemini');

    // Mismatches return 'custom'
    assert.equal(detectTarget('json', 200000), 'custom');
    assert.equal(detectTarget('claude-xml', 100000), 'custom');
    assert.equal(detectTarget('markdown', 500000), 'custom');
    assert.equal(detectTarget('unknown', 0), 'custom');
});

test('settings-summary: buildSettingsSummary handles target, minify, redact and chunk limits', () => {
    // Case 1: All features enabled, split chunk limit
    const case1 = buildSettingsSummary({
        targetLabel: 'Claude',
        minifyMode: 'basic',
        redactLevel: 'standard',
        chunkLimit: 200000
    });
    assert.equal(case1, 'Claude · blank lines removed · secrets hidden · split at 200k');

    // Case 2: Aggressive minify and strict secrets, split at 128k
    const case2 = buildSettingsSummary({
        targetLabel: 'ChatGPT',
        minifyMode: 'aggressive',
        redactLevel: 'strict',
        chunkLimit: 128000
    });
    assert.equal(case2, 'ChatGPT · comments removed · strict secret hiding · split at 128k');

    // Case 3: chunkLimit is 0 (no split note), secrets off, minifyMode none
    const case3 = buildSettingsSummary({
        targetLabel: 'Gemini',
        minifyMode: 'none',
        redactLevel: 'off',
        chunkLimit: 0
    });
    assert.equal(case3, 'Gemini · secrets NOT hidden');

    // Case 4: Issues page format (no minifyMode), custom target, chunkLimit 50k
    const case4 = buildSettingsSummary({
        targetLabel: 'Custom',
        minifyMode: 'none',
        redactLevel: 'standard',
        chunkLimit: 50000
    });
    assert.equal(case4, 'Custom · secrets hidden · split at 50k');
});

test('ui: buildBannerItems returns empty array when no warnings or errors apply', () => {
    const items = buildBannerItems({});
    assert.deepEqual(items, []);

    const items2 = buildBannerItems({
        failedThreads: 0,
        rateLimited: false,
        truncatedTree: false,
        skippedLarge: 0,
        redactionOff: false,
        secretCount: 0
    });
    assert.deepEqual(items2, []);
});

test('ui: buildBannerItems handles failedThreads with rate limiting', () => {
    const withReset = buildBannerItems({
        failedThreads: 4,
        rateLimited: true,
        resetTime: '12:34 PM'
    });
    assert.deepEqual(withReset, [{
        level: 'error',
        text: "GitHub's request limit was reached. Comments for 4 issue(s) weren't loaded. Add a token or retry after 12:34 PM."
    }]);

    const withoutReset = buildBannerItems({
        failedThreads: 2,
        rateLimited: true
    });
    assert.deepEqual(withoutReset, [{
        level: 'error',
        text: "GitHub's request limit was reached. Comments for 2 issue(s) weren't loaded. Add a token or retry."
    }]);
});

test('ui: buildBannerItems handles failedThreads without rate limiting', () => {
    const items = buildBannerItems({
        failedThreads: 3,
        rateLimited: false
    });
    assert.deepEqual(items, [{
        level: 'error',
        text: "Comments could not be loaded for 3 issue(s). See Details, then retry."
    }]);
});

test('ui: buildBannerItems handles truncatedTree', () => {
    const items = buildBannerItems({
        truncatedTree: true
    });
    assert.deepEqual(items, [{
        level: 'warn',
        text: 'This repository is very large, so GitHub returned a partial file list.'
    }]);
});

test('ui: buildBannerItems handles skippedLarge', () => {
    const items = buildBannerItems({
        skippedLarge: 5
    });
    assert.deepEqual(items, [{
        level: 'warn',
        text: '5 large file(s) were skipped. Raise "Max file size (KB)" to include them.'
    }]);
});

test('ui: buildBannerItems handles redactionOff with secretCount > 0', () => {
    const items = buildBannerItems({
        redactionOff: true,
        secretCount: 7
    });
    assert.deepEqual(items, [{
        level: 'warn',
        text: 'Secret hiding is off and 7 possible secret(s) were found.'
    }]);

    const itemsIgnored = buildBannerItems({
        redactionOff: false,
        secretCount: 7
    });
    assert.deepEqual(itemsIgnored, []);
});

test('ui: renderBanner creates correct DOM elements and hides when empty', () => {
    const createdElements = [];
    const mockEl = {
        _innerHTML: '',
        style: { display: '' },
        children: [],
        get innerHTML() { return this._innerHTML; },
        set innerHTML(v) { this._innerHTML = v; if (v === '') this.children = []; },
        appendChild(child) {
            this.children.push(child);
            return child;
        }
    };

    const originalDoc = globalThis.document;
    globalThis.document = {
        createElement(tag) {
            const el = { tagName: tag, className: '', textContent: '' };
            createdElements.push(el);
            return el;
        }
    };

    try {
        // Empty items hides element
        renderBanner(mockEl, []);
        assert.equal(mockEl.style.display, 'none');
        assert.equal(mockEl.children.length, 0);

        // With items renders and displays
        const items = [
            { level: 'warn', text: 'Warning message' },
            { level: 'error', text: 'Error message' }
        ];
        renderBanner(mockEl, items);
        assert.equal(mockEl.style.display, 'flex');
        assert.equal(mockEl.children.length, 2);
        assert.equal(mockEl.children[0].className, 'banner-item warn');
        assert.equal(mockEl.children[0].textContent, 'Warning message');
        assert.equal(mockEl.children[1].className, 'banner-item error');
        assert.equal(mockEl.children[1].textContent, 'Error message');

        // An item with an action gets a button that runs it
        let clicked = 0;
        globalThis.document.createElement = (tag) => {
            const el = { tagName: tag, className: '', textContent: '', children: [], listeners: {},
                appendChild(c) { this.children.push(c); return c; },
                addEventListener(type, fn) { this.listeners[type] = fn; } };
            return el;
        };
        renderBanner(mockEl, [{ level: 'warn', text: 'Some packages not checked', action: { label: 'Check the rest', onClick: () => { clicked++; } } }]);
        const btn = mockEl.children[0].children[0];
        assert.equal(btn.tagName, 'button');
        assert.equal(btn.textContent, 'Check the rest');
        btn.listeners.click();
        assert.equal(clicked, 1);
    } finally {
        globalThis.document = originalDoc;
    }
});

test('ui: copyLabel formats single-part and multi-part labels correctly', () => {
    // 1 part
    assert.equal(copyLabel(0, 1), 'Copy');
    assert.equal(copyLabel(0, 0), 'Copy');

    // 3 parts - first part
    assert.equal(copyLabel(0, 3), 'Copy part 1 of 3');

    // 3 parts - part index 1 (second part)
    assert.equal(copyLabel(1, 3), 'Copy part 2 of 3');

    // 3 parts - part index 2 (third part)
    assert.equal(copyLabel(2, 3), 'Copy part 3 of 3');
});

test('commentCostHint: scope none', () => {
    const selected = [{ number: 1, commentsCount: 5, createdAt: '2024-01-01' }];
    const hint = commentCostHint(selected, selected, new Set(), 'none');
    assert.deepEqual(hint, { requests: 0, text: 'No extra requests.' });
});

test('commentCostHint: all cached', () => {
    const selected = [
        { number: 1, commentsCount: 5, createdAt: '2024-01-01' },
        { number: 2, commentsCount: 0, createdAt: '2024-01-02' }
    ];
    const hint = commentCostHint(selected, selected, new Set([1]), 'all');
    assert.deepEqual(hint, { requests: 0, text: 'Comments already loaded.' });
});

test('commentCostHint: 3 issues (per-issue count)', () => {
    const selected = [
        { number: 1, commentsCount: 10, createdAt: '2024-01-01' },
        { number: 2, commentsCount: 15, createdAt: '2024-01-02' },
        { number: 3, commentsCount: 5, createdAt: '2024-01-03' }
    ];
    // Needs 3 issues, perIssue = 1 + 1 + 1 = 3
    // bulk condition requires perIssue >= 4, so it stays perIssue
    const hint = commentCostHint(selected, selected, new Set(), 'all');
    assert.deepEqual(hint, { requests: 3, text: 'About 3 GitHub requests.' });
});

test('commentCostHint: 60 recent issues in a 200-issue universe (bulk, small count)', () => {
    // 200 issues total; the most recent 60 have comments, but total inWindow comments is small
    const universe = [];
    for (let i = 1; i <= 200; i++) {
        universe.push({
            number: i,
            commentsCount: 1,
            createdAt: i <= 60 ? '2024-06-01' : '2023-01-01'
        });
    }
    const selected = universe.slice(0, 60);
    // needs.length = 60, perIssue = 60
    // inWindow = 60 * 1 = 60 comments -> bulkPages = Math.ceil(60/100) = 1
    // bulk = perIssue >= 4 (60 >= 4) && bulkPages (1) <= 60 * 0.3 (18) -> true!
    // n = 1
    const hint = commentCostHint(selected, universe, new Set(), 'all');
    assert.deepEqual(hint, { requests: 1, text: 'About 1 GitHub request.' });
});

test('defaultExcludedPaths: excludes matched directories but not file names or non-matching paths', () => {
    const inputPaths = [
        'tests/a.js',           // excluded: 'tests' in DEFAULT_EXCLUDED_DIRS
        'src/tests.js',         // NOT excluded: 'tests.js' is filename, 'src' not in list
        'docs/x.md',            // excluded: 'docs' in DEFAULT_EXCLUDED_DIRS
        'src/Docs/y.md',        // excluded: case-insensitive match for 'Docs'
        'test.js',              // NOT excluded: root file, not in a directory
        'lib/utils.js',         // NOT excluded
        'nested/test/deep.js'   // excluded: 'test' in DEFAULT_EXCLUDED_DIRS
    ];

    const { excluded, folders } = defaultExcludedPaths(inputPaths);

    assert.deepEqual(excluded, [
        'tests/a.js',
        'docs/x.md',
        'src/Docs/y.md',
        'nested/test/deep.js'
    ]);

    assert.deepEqual(folders, [
        'tests',
        'docs',
        'src/Docs',
        'nested/test'
    ]);
});

test('rankSuggestions: ordering, limit, minShare cutoff, and path grouping', () => {
    // files: total tokens = 1000 + 500 + 400 + 200 + 50 + 20 = 2170
    // Group src/components: 1000 + 500 = 1500 (69.1%)
    // Group src/utils: 400 (18.4%)
    // Group tests: 200 (9.2%)
    // Group root_file.js: 50 (2.3% - below default minShare 0.05)
    // Group other/tiny: 20 (0.9% - below default minShare 0.05)
    const files = [
        { path: 'src/components/Header.jsx', tokens: 1000 },
        { path: 'src/components/Footer.jsx', tokens: 500 },
        { path: 'src/utils/math.js', tokens: 400 },
        { path: 'tests/app.test.js', tokens: 200 },
        { path: 'root_file.js', tokens: 50 },
        { path: 'other/tiny/file.js', tokens: 20 }
    ];

    // Default limit = 3, minShare = 0.05
    const suggestions = rankSuggestions(files);
    assert.equal(suggestions.length, 3);
    assert.equal(suggestions[0].path, 'src/components');
    assert.equal(suggestions[0].tokens, 1500);
    assert.equal(Math.round(suggestions[0].share * 100), 69);

    assert.equal(suggestions[1].path, 'src/utils');
    assert.equal(suggestions[1].tokens, 400);

    assert.equal(suggestions[2].path, 'tests');
    assert.equal(suggestions[2].tokens, 200);

    // Test custom limit = 2
    const top2 = rankSuggestions(files, 2);
    assert.equal(top2.length, 2);
    assert.equal(top2[0].path, 'src/components');
    assert.equal(top2[1].path, 'src/utils');

    // Test higher minShare cut-off
    const highCutoff = rankSuggestions(files, 5, 0.20);
    assert.equal(highCutoff.length, 1);
    assert.equal(highCutoff[0].path, 'src/components');

    // Test single-segment paths and top-level folder grouping
    const singleFolderFiles = [
        { path: 'main.js', tokens: 600 },
        { path: 'docs/index.md', tokens: 400 }
    ];
    // total = 1000
    // main.js: 600 (60%)
    // docs: 400 (40%)
    const singleRes = rankSuggestions(singleFolderFiles);
    assert.equal(singleRes.length, 2);
    assert.equal(singleRes[0].path, 'main.js');
    assert.equal(singleRes[0].tokens, 600);
    assert.equal(singleRes[0].share, 0.6);
    assert.equal(singleRes[1].path, 'docs');
    assert.equal(singleRes[1].tokens, 400);
    assert.equal(singleRes[1].share, 0.4);
});

test('ui-summary: buildSummaryLines formats code build correctly', () => {
    const lines = buildSummaryLines({
        kind: 'files',
        items: 12,
        tokens: 45000,
        parts: 1,
        secretsHidden: 0,
        warnings: 0
    });
    assert.deepEqual(lines, [
        '12 files included',
        'About 45,000 tokens (estimated)'
    ]);
});

test('ui-summary: buildSummaryLines formats issues build with comments', () => {
    const lines = buildSummaryLines({
        kind: 'issues',
        items: 5,
        comments: 23,
        tokens: 12500,
        parts: 1,
        secretsHidden: 0,
        warnings: 0
    });
    assert.deepEqual(lines, [
        '5 issues included · 23 comments',
        'About 12,500 tokens (estimated)'
    ]);
});

test('ui-summary: buildSummaryLines formats multi-part builds', () => {
    const lines = buildSummaryLines({
        kind: 'files',
        items: 50,
        tokens: 250000,
        parts: 3,
        secretsHidden: 0,
        warnings: 0
    });
    assert.deepEqual(lines, [
        '50 files included',
        'About 250,000 tokens (estimated) · 3 parts'
    ]);
});

test('ui-summary: buildSummaryLines includes secrets and warnings lines when present', () => {
    const linesWithSecretsAndWarnings = buildSummaryLines({
        kind: 'issues',
        items: 8,
        comments: 14,
        tokens: 82000,
        parts: 2,
        secretsHidden: 4,
        warnings: 2
    });
    assert.deepEqual(linesWithSecretsAndWarnings, [
        '8 issues included · 14 comments',
        'About 82,000 tokens (estimated) · 2 parts',
        '4 possible secret(s) hidden',
        '2 warning(s) above'
    ]);

    const linesWithOnlySecrets = buildSummaryLines({
        kind: 'files',
        items: 3,
        tokens: 1200,
        parts: 1,
        secretsHidden: 1,
        warnings: 0
    });
    assert.deepEqual(linesWithOnlySecrets, [
        '3 files included',
        'About 1,200 tokens (estimated)',
        '1 possible secret(s) hidden'
    ]);

    const linesWithOnlyWarnings = buildSummaryLines({
        kind: 'files',
        items: 3,
        tokens: 1200,
        parts: 1,
        secretsHidden: 0,
        warnings: 1
    });
    assert.deepEqual(linesWithOnlyWarnings, [
        '3 files included',
        'About 1,200 tokens (estimated)',
        '1 warning(s) above'
    ]);
});

test('nav: buildTabHref returns base URL when repoText is empty or whitespace', () => {
    assert.equal(buildTabHref('code', ''), 'code.html');
    assert.equal(buildTabHref('code', '   '), 'code.html');
    assert.equal(buildTabHref('code', undefined), 'code.html');
    assert.equal(buildTabHref('code', null), 'code.html');

    assert.equal(buildTabHref('issues', ''), 'issues.html');
    assert.equal(buildTabHref('issues', '   '), 'issues.html');
    assert.equal(buildTabHref('issues', undefined), 'issues.html');
    assert.equal(buildTabHref('issues', null), 'issues.html');
});

test('nav: buildTabHref handles simple repo input', () => {
    assert.equal(buildTabHref('code', 'owner/repo'), 'code.html?repo=owner%2Frepo');
    assert.equal(buildTabHref('issues', 'owner/repo'), 'issues.html?repo=owner%2Frepo');
    assert.equal(buildTabHref('code', '  facebook/react  '), 'code.html?repo=facebook%2Freact');
});

test('nav: buildTabHref encodes URLs and special characters without including tokens', () => {
    const fullUrl = 'https://github.com/owner/repo-name_v1.0';
    assert.equal(buildTabHref('issues', fullUrl), `issues.html?repo=${encodeURIComponent(fullUrl)}`);

    const specialRepo = 'owner/repo with spaces & symbols#tag';
    const target = buildTabHref('code', specialRepo);
    assert.equal(target, `code.html?repo=${encodeURIComponent(specialRepo)}`);
    assert.ok(!target.includes('token') && !target.includes('ghp_'));
});
