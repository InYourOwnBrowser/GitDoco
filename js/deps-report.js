/**
 * Dependency reports for people rather than AI:
 *
 *   toHtmlReport        a self-contained, printable HTML page (no scripts, no outside resources)
 *                       to send to a manager, client or lawyer
 *   toThirdPartyNotices a THIRD_PARTY_NOTICES.md attribution file, grouped by license
 *
 * Package names, versions, licenses and advisory titles come from repositories and registries,
 * so they are untrusted: everything is HTML-escaped, and links are only built by js/links.js.
 */
import { collectAdvisories, policyFindings, lockText, sortPackages, groupCounts, pathText, REPORT_NOTE } from './deps-formatters.js';
import { summarizeDiff } from './deps-compare.js';
import { LICENSE_GROUPS, GROUP_LABELS } from './license-classify.js';
import { registryUrl, advisoryUrl } from './links.js';

const esc = s => String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const link = (href, text) => (href ? `<a href="${esc(href)}">${esc(text)}</a>` : esc(text));
const SEVERITY_LABEL = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', unknown: 'Unrated' };
const pkgName = p => `${p.name}@${p.version || '?'}`;

/** SPDX IDs in a license expression ("MIT OR Apache-2.0" -> ["MIT", "Apache-2.0"]). */
export function spdxIds(expression) {
    return [...new Set(String(expression || '')
        .split(/\s+(?:AND|OR|WITH)\s+|[()]/i)
        .map(s => s.trim().replace(/\+$/, ''))
        .filter(s => /^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(s) && !/^LicenseRef-/i.test(s)))];
}

const spdxUrl = id => `https://spdx.org/licenses/${encodeURIComponent(id)}.html`;
// Package names and versions are untrusted: keep them from breaking out of Markdown link syntax.
const mdText = s => String(s || '').replace(/[\\`*_[\]()<>#|]/g, '\\$&');

const STYLE = `
:root { color-scheme: light; --ink:#16202B; --soft:#5A6877; --line:#D5DBE2; --page:#F6F7F9; --blue:#2A4BD7; --red:#B93A2B; --amber:#975A16; --green:#1E7F57; }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: var(--ink); background: #fff; }
main { max-width: 1040px; margin: 0 auto; padding: 32px 24px 48px; }
h1 { font-size: 26px; margin: 0 0 4px; } h2 { font-size: 18px; margin: 32px 0 10px; padding-top: 8px; border-top: 1px solid var(--line); }
.meta { color: var(--soft); margin: 0 0 20px; } .meta div { margin: 2px 0; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin: 16px 0; }
.card { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; background: var(--page); }
.card b { display: block; font-size: 22px; } .card span { color: var(--soft); font-size: 12px; }
.card.bad b { color: var(--red); } .card.warn b { color: var(--amber); } .card.ok b { color: var(--green); }
table { width: 100%; border-collapse: collapse; margin: 6px 0 12px; font-size: 13px; }
th, td { text-align: left; vertical-align: top; padding: 6px 8px; border-bottom: 1px solid var(--line); }
th { background: var(--page); font-weight: 600; }
td.mono, .mono { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; word-break: break-word; }
.pill { display: inline-block; padding: 0 6px; border-radius: 4px; font-size: 11px; font-weight: 700; border: 1px solid currentColor; white-space: nowrap; }
.sev-critical, .sev-high, .v-block { color: var(--red); } .sev-medium, .v-review { color: var(--amber); } .sev-low, .sev-unknown { color: var(--soft); }
.note { color: var(--soft); font-size: 12px; border-left: 3px solid var(--line); padding: 4px 10px; margin: 16px 0; }
.warn-box { border: 1px solid var(--amber); background: #FFF8EC; border-radius: 6px; padding: 8px 12px; margin: 12px 0; }
a { color: var(--blue); }
footer { margin-top: 32px; color: var(--soft); font-size: 12px; }
@media print { main { padding: 0; } h2 { break-after: avoid; } tr { break-inside: avoid; } a { color: inherit; } }
`;

/**
 * A printable HTML report of the dependency check.
 * @param {{ repoName: string, source?: string, repoLicense?: object, packages: object[],
 *   includeTransitive?: boolean, includeDev?: boolean, lockfiles?: string[],
 *   policy?: { description: string }, comparison?: { base, head, diff }, warnings?: string[],
 *   generatedAt?: string }} ctx
 */
export function toHtmlReport(ctx) {
    const packages = ctx.packages || [];
    const counts = groupCounts(packages);
    const advisories = collectAdvisories(packages);
    const findings = policyFindings(packages);
    const sevCount = s => advisories.filter(r => r.a.severity === s).length;
    const affected = new Set(advisories.map(r => r.p)).size;
    const outdated = packages.filter(p => p.relation === 'direct' && p.outdated).length;
    const blocked = findings.filter(p => p.policy.verdict === 'block').length;
    const review = findings.length - blocked;
    const when = ctx.generatedAt || new Date().toISOString();
    const scope = `${ctx.includeTransitive ? 'Direct and transitive' : 'Direct'} dependencies, ${ctx.includeDev ? 'including' : 'excluding'} development and test dependencies`;

    let h = `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n`;
    h += `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">\n`;
    h += `<title>Dependency report: ${esc(ctx.repoName)}</title>\n<style>${STYLE}</style>\n</head>\n<body>\n<main>\n`;
    h += `<h1>Dependency report: ${esc(ctx.repoName)}</h1>\n<div class="meta">`;
    h += `<div>${esc(ctx.source || '')}</div>`;
    h += `<div>Generated ${esc(when.replace('T', ' ').slice(0, 16))} UTC by GitDoco &middot; ${esc(scope)}</div>`;
    h += `<div>Repository license: ${esc(ctx.repoLicense && ctx.repoLicense.expression ? ctx.repoLicense.expression : 'not detected')}</div>`;
    h += `<div>${esc(lockText(ctx))}</div>`;
    if (ctx.policy && ctx.policy.description) h += `<div>License policy: ${esc(ctx.policy.description)}</div>`;
    h += `</div>\n`;

    h += `<div class="cards">`;
    h += `<div class="card"><b>${packages.length}</b><span>packages</span></div>`;
    h += `<div class="card ${blocked ? 'bad' : 'ok'}"><b>${blocked}</b><span>blocked by policy</span></div>`;
    h += `<div class="card ${review ? 'warn' : 'ok'}"><b>${review}</b><span>to review under policy</span></div>`;
    h += `<div class="card ${sevCount('critical') + sevCount('high') ? 'bad' : 'ok'}"><b>${sevCount('critical') + sevCount('high')}</b><span>critical or high advisories</span></div>`;
    h += `<div class="card ${advisories.length ? 'warn' : 'ok'}"><b>${advisories.length}</b><span>advisories in ${affected} package${affected === 1 ? '' : 's'}</span></div>`;
    h += `<div class="card ${outdated ? 'warn' : 'ok'}"><b>${outdated}</b><span>direct dependencies outdated</span></div>`;
    h += `</div>\n`;

    for (const w of ctx.warnings || []) h += `<div class="warn-box">${esc(w)}</div>\n`;

    const cmp = ctx.comparison;
    if (cmp && cmp.diff) {
        const d = cmp.diff;
        h += `<h2>Changes: ${esc(cmp.head)} compared with ${esc(cmp.base)}</h2>\n<p>${esc(summarizeDiff(d))}.</p>\n`;
        if (d.added.length) h += `<p><b>Added:</b> ${d.added.map(p => `<span class="mono">${esc(pkgName(p))}</span>`).join(', ')}</p>\n`;
        if (d.updated.length) h += `<p><b>Updated:</b> ${d.updated.map(u => `<span class="mono">${esc(u.pkg.name)} ${esc(u.from.join(', '))} &rarr; ${esc(u.to.join(', '))}</span>`).join('; ')}</p>\n`;
        if (d.removed.length) h += `<p><b>Removed:</b> ${d.removed.map(p => `<span class="mono">${esc(pkgName(p))}</span>`).join(', ')}</p>\n`;
    }

    if (findings.length) {
        h += `<h2>License policy findings (${findings.length})</h2>\n<table><thead><tr><th>Verdict</th><th>Package</th><th>License</th><th>Reason</th></tr></thead><tbody>\n`;
        for (const p of findings) {
            h += `<tr><td><span class="pill v-${p.policy.verdict}">${p.policy.verdict === 'block' ? 'Blocked' : 'Review'}</span></td><td class="mono">${link(registryUrl(p.ecosystem, p.name, p.version), pkgName(p))}</td><td class="mono">${esc(p.license.expression || 'none found')}</td><td>${esc(p.policy.reason)}</td></tr>\n`;
        }
        h += `</tbody></table>\n`;
    }

    h += `<h2>Security advisories (${advisories.length})</h2>\n`;
    if (!advisories.length) {
        h += `<p>None known to deps.dev for these versions. That does not prove the packages are free of vulnerabilities.</p>\n`;
    } else {
        h += `<table><thead><tr><th>Severity</th><th>Advisory</th><th>Package</th><th>Title</th><th>Fix</th></tr></thead><tbody>\n`;
        for (const { p, a } of advisories) {
            const fix = p.relation === 'direct' && p.latest && p.outdated ? `latest ${p.latest}${p.upgradeClears ? ` clears ${p.upgradeClears}` : ''}` : '';
            h += `<tr><td><span class="pill sev-${esc(a.severity)}">${SEVERITY_LABEL[a.severity] || 'Unrated'}${a.score ? ` ${esc(a.score)}` : ''}</span></td><td class="mono">${link(advisoryUrl(a.id), a.id)}</td><td class="mono">${esc(pkgName(p))}</td><td>${esc(a.title || '')}</td><td>${esc(fix)}</td></tr>\n`;
        }
        h += `</tbody></table>\n`;
    }

    h += `<h2>Licenses</h2>\n<table><thead><tr><th>Group</th><th>Packages</th></tr></thead><tbody>\n`;
    for (const g of LICENSE_GROUPS) h += `<tr><td>${esc(GROUP_LABELS[g])}</td><td>${counts[g]}</td></tr>\n`;
    h += `</tbody></table>\n`;

    h += `<h2>All packages (${packages.length})</h2>\n<table><thead><tr><th>Package</th><th>Relation</th><th>License</th><th>Group</th><th>Policy</th><th>Advisories</th></tr></thead><tbody>\n`;
    for (const p of sortPackages(packages)) {
        const via = pathText(p);
        const rel = `${p.relation}${p.dev ? ' (dev)' : ''}${via ? `<br><span class="mono">via ${esc(via)}</span>` : ''}`;
        const pol = p.policy && p.policy.verdict !== 'allow' ? `<span class="pill v-${p.policy.verdict}">${p.policy.verdict}</span>` : '';
        h += `<tr><td class="mono">${link(registryUrl(p.ecosystem, p.name, p.version), pkgName(p))}<br><span style="color:var(--soft)">${esc(p.ecosystem)}</span></td><td>${rel}</td><td class="mono">${esc(p.license.expression || (p.status === 'not-checked' ? 'not checked yet' : 'none found'))}</td><td>${esc(GROUP_LABELS[p.license.group])}</td><td>${pol}</td><td>${(p.advisories || []).length || ''}</td></tr>\n`;
    }
    h += `</tbody></table>\n`;

    h += `<p class="note">${esc(REPORT_NOTE)}</p>\n`;
    h += `<footer>Generated in the browser by GitDoco from manifests, lockfiles and deps.dev. Nothing about this repository was stored by GitDoco.</footer>\n`;
    h += `</main>\n</body>\n</html>\n`;
    return h;
}

/**
 * THIRD_PARTY_NOTICES.md: the third-party packages this project ships, grouped by license.
 * Development-only packages are left out (they are not distributed). It lists each package and
 * links its license; it cannot add the copyright lines or full license texts that many licenses
 * require, which come from each package's own LICENSE file.
 */
export function toThirdPartyNotices({ repoName, packages, generatedAt }) {
    const runtime = (packages || []).filter(p => !p.dev);
    const byLicense = new Map();
    for (const p of runtime) {
        const key = p.license && p.license.expression ? p.license.expression : (p.status === 'not-checked' ? 'Not checked yet' : 'License not found');
        if (!byLicense.has(key)) byLicense.set(key, []);
        byLicense.get(key).push(p);
    }
    const unknownKeys = new Set(['Not checked yet', 'License not found']);
    const keys = [...byLicense.keys()].sort((a, b) =>
        (unknownKeys.has(a) ? 1 : 0) - (unknownKeys.has(b) ? 1 : 0) || byLicense.get(b).length - byLicense.get(a).length || a.localeCompare(b));
    const date = (generatedAt || new Date().toISOString()).slice(0, 10);

    let md = `# Third-party notices\n\n`;
    md += `${repoName || 'This project'} uses the following third-party packages (${runtime.length}, runtime dependencies only). `;
    md += `Generated by GitDoco on ${date} from the project's manifests and lockfiles, with license data from deps.dev.\n\n`;
    md += `> **Before you publish this file:** many licenses (for example MIT, BSD and Apache-2.0) require you to include each package's copyright notice and full license text, which come from the package's own LICENSE file and are not included here. Check the packages under "License not found" by hand. This file is not legal advice.\n\n`;
    md += `## Contents\n\n`;
    for (const k of keys) md += `- ${mdText(k)} (${byLicense.get(k).length})\n`;
    md += '\n';
    for (const k of keys) {
        const list = byLicense.get(k).sort((a, b) => a.ecosystem.localeCompare(b.ecosystem) || a.name.localeCompare(b.name) || String(a.version).localeCompare(String(b.version)));
        md += `## ${mdText(k)}\n\n`;
        // Licenses GitDoco can't classify (e.g. deps.dev's "non-standard") get no SPDX link.
        const ids = unknownKeys.has(k) || list.every(p => p.license && p.license.group === 'unknown') ? [] : spdxIds(k);
        if (ids.length) md += `License text: ${ids.map(id => `[${id}](${spdxUrl(id)})`).join(', ')}\n\n`;
        for (const p of list) {
            const url = registryUrl(p.ecosystem, p.name, p.version);
            md += `- ${url ? `[${mdText(p.name)}](${url})` : mdText(p.name)}${p.version ? ` ${mdText(p.version)}` : ''} (${p.ecosystem})\n`;
        }
        md += '\n';
    }
    return md;
}
