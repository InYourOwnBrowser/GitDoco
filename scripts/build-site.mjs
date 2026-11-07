/**
 * Copies the public site into dist/ for static hosting (Cloudflare Pages: build command
 * `node scripts/build-site.mjs`, output directory `dist`). No dependencies and no bundling:
 * the site runs as-is; this only leaves tests, docs and tooling out of what is published.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'dist');
const FILES = ['index.html', 'privacy.html', 'terms.html', '404.html', 'LICENSE', 'code.html', 'issues.html', 'discussions.html', 'deps.html', 'favicon.svg', 'robots.txt', 'sitemap.xml', '_headers'];
const DIRS = ['css', 'js', 'fonts', 'assets'];

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
for (const f of FILES) fs.copyFileSync(path.join(ROOT, f), path.join(OUT, f));
for (const d of DIRS) fs.cpSync(path.join(ROOT, d), path.join(OUT, d), { recursive: true });

let count = 0;
(function walk(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) e.isDirectory() ? walk(path.join(dir, e.name)) : count++; })(OUT);
console.log(`Built dist/ with ${count} files.`);
