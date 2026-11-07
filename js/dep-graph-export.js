/**
 * Sharing the dependency graph outside GitDoco:
 *
 *   toStandaloneGraphHtml  one self-contained, interactive HTML page (the graph engine and the
 *                          data inlined; it loads nothing and cannot connect anywhere)
 *   readmeSnippets         Markdown for a README: a link to the live graph on GitDoco, and the
 *                          same link around a committed SVG picture
 *
 * The page's Content-Security-Policy allows exactly one script, by its SHA-256 hash, and no
 * network access at all, so even a package name crafted to look like markup could not run code
 * or send anything. Names are also only ever inserted as text (see js/dep-graph.js).
 */

export const SITE = 'https://gitdoco.timedoco.com';

const esc = s => String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** JSON that is safe inside a <script type="application/json"> element. */
export function scriptSafeJson(value) {
    return JSON.stringify(value)
        .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
        .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** The graph engine's source with its ES module exports turned into plain declarations. */
export function inlineEngine(source) {
    const body = String(source).replace(/^export\s+(?=(?:async\s+)?function\b|const\b|let\b|class\b)/gm, '');
    if (/^\s*(import|export)\b/m.test(body)) throw new Error('The graph engine must not import or export anything else.');
    if (/<\/script|<!--/i.test(body)) throw new Error('The graph engine must not contain "</script" or "<!--".');
    return body;
}

async function sha256Base64(text) {
    const bytes = new TextEncoder().encode(text);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    let bin = '';
    for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b);
    return btoa(bin);
}

const DARK = `@media (prefers-color-scheme: dark) {
    :root { --page: #0F141A; --sheet: #171E26; --ink: #E8ECF1; --ink-soft: #9AA7B4; --line: #2A343F; --cobalt: #7C93FF; }
}`;

/**
 * @param {object} args
 * @param {object} args.data          from toGraphData
 * @param {string} args.engineSource  the text of js/dep-graph.js
 * @param {string} args.css           the text of css/dep-graph.css
 * @param {string} [args.generated]   a date for the footer, e.g. "7 November 2026"
 * @returns {Promise<string>}
 */
export async function toStandaloneGraphHtml({ data, engineSource, css, generated = '' }) {
    const script = `(function () {\n'use strict';\n${inlineEngine(engineSource)}\nmountGraph(document.getElementById('graph'), JSON.parse(document.getElementById('graph-data').textContent));\n})();`;
    const hash = await sha256Base64(script);
    const title = `Dependency graph: ${data.label}`;
    const csp = `default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title>
<style>
:root { color-scheme: light dark; }
${DARK}
html, body { height: 100%; margin: 0; }
body { display: flex; flex-direction: column; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; background: var(--page, #F2F4F7); color: var(--ink, #16202B); }
header, footer { padding: 0.6rem 0.9rem; background: var(--sheet, #fff); border-bottom: 1px solid var(--line, #D5DBE2); }
header h1 { margin: 0; font-size: 1rem; }
footer { border-top: 1px solid var(--line, #D5DBE2); border-bottom: 0; font-size: 12px; color: var(--ink-soft, #5A6877); }
footer a { color: inherit; }
#graph { flex: 1; min-height: 0; }
${css}
</style>
</head>
<body>
<header><h1>${esc(title)}</h1></header>
<main id="graph"></main>
<footer>${generated ? `Generated ${esc(generated)} with ` : 'Made with '}<a href="${SITE}/" rel="noopener noreferrer">GitDoco</a>. Licenses and advisories come from deps.dev and are not legal advice. This page loads nothing from the internet.</footer>
<script type="application/json" id="graph-data">${scriptSafeJson(data)}</script>
<script>${script}</script>
</body>
</html>
`;
}

/**
 * README Markdown for a GitHub repository.
 * @param {string} repo  "owner/name"
 * @param {string} [imagePath]  where the SVG picture is committed
 * @returns {{ link: string, image: string, url: string } | null}  null when `repo` is not owner/name
 */
export function readmeSnippets(repo, imagePath = 'docs/dependency-graph.svg') {
    const m = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(String(repo || '').trim());
    if (!m) return null;
    const url = `${SITE}/${m[1]}/${m[2]}/graph`;
    const alt = `Dependency graph of ${m[1]}/${m[2]}`;
    return {
        url,
        link: `[View the interactive dependency graph](${url})`,
        image: `[![${alt}](${imagePath})](${url})`
    };
}
