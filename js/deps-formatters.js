/**
 * Formats a dependency + license report as AI context: Claude XML, Markdown, generic XML or JSON.
 *
 * Packages are grouped by license group, most attention first (restricted, strong copyleft,
 * weak copyleft, unknown, permissive). With `compactPermissive`, permissive packages are listed
 * as one line each to save tokens.
 */
import { summarizeDiff } from './deps-compare.js';
import { escapeXml, escapeCdata, stripXmlInvalidChars, getMarkdownFence } from './formatters.js';
import { LICENSE_GROUPS, GROUP_LABELS, GROUP_HINTS } from './license-classify.js';

export const REPORT_NOTE = 'License groups are a heuristic to guide review, not legal advice and not a compatibility verdict: '
    + 'obligations depend on how each package is used (linking, distribution, hosted service). '
    + 'License, advisory and project health data come from deps.dev (health: OpenSSF Scorecard). Versions come from lockfiles '
    + 'where present; otherwise, where a manifest gives a range, the lowest version in the range (or the latest release when '
    + 'none is given) was checked, so installed versions may differ. Only advisories known to deps.dev are listed, so a package '
    + 'without advisories is not proven safe; licenses come from registry metadata and can differ from a package\'s own license '
    + 'file. Only npm, PyPI, Go and Cargo dependencies declared in manifests are covered: code copied into the repository, git '
    + 'submodules, and system or container packages are not checked.';

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3, unknown: 4 };
const SEVERITY_LABEL = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', unknown: 'Unrated' };

/** "GHSA-x (high 7.5)" for each advisory, worst first. */
function advisoryList(p) {
    const details = p.advisoryDetails && p.advisoryDetails.length ? p.advisoryDetails : (p.advisories || []).map(id => ({ id, severity: 'unknown', score: null }));
    return details.map(a => `${a.id} (${a.severity === 'unknown' ? 'unrated' : `${a.severity}${a.score ? ` ${a.score}` : ''}`})`);
}

/** Every advisory across the packages, worst first: { package, advisory }. */
export function collectAdvisories(packages) {
    const rows = [];
    for (const p of packages) {
        const details = p.advisoryDetails && p.advisoryDetails.length ? p.advisoryDetails : (p.advisories || []).map(id => ({ id, severity: 'unknown', score: null, title: '', aliases: [] }));
        for (const a of details) rows.push({ p, a });
    }
    return rows.sort((x, y) => SEVERITY_RANK[x.a.severity] - SEVERITY_RANK[y.a.severity] || (y.a.score || 0) - (x.a.score || 0) || x.p.name.localeCompare(y.p.name));
}

function fixText(p) {
    if (p.relation !== 'direct' || !p.latest || !p.outdated) return '';
    return p.upgradeClears ? `latest ${p.latest} clears ${p.upgradeClears} of ${p.advisories.length}` : `latest ${p.latest}`;
}

/** Packages the policy blocks or sends to review, blocked first. */
export function policyFindings(packages) {
    const rank = { block: 0, review: 1 };
    return packages.filter(p => p.policy && p.policy.verdict !== 'allow')
        .sort((a, b) => rank[a.policy.verdict] - rank[b.policy.verdict] || a.name.localeCompare(b.name));
}
const policyAttr = p => (p.policy && p.policy.verdict !== 'allow' ? `${p.policy.verdict}: ${p.policy.reason}` : '');

const pkgLabel = p => `${p.ecosystem}:${p.name}@${p.version || '?'}`;
const advIds = p => advisoryList(p).join(', ');

export function lockText(ctx) {
    if (!ctx.lockfiles || !ctx.lockfiles.length) return 'No lockfile found: versions estimated from manifest ranges';
    const partial = (ctx.packages || []).some(p => p.versionKind && p.versionKind !== 'locked');
    return `Exact versions from lockfiles: ${ctx.lockfiles.join(', ')}${partial ? '; packages not in a lockfile have estimated versions' : ''}`;
}

const ORDER = Object.fromEntries(LICENSE_GROUPS.map((g, i) => [g, i]));

export function sortPackages(packages) {
    return [...packages].sort((a, b) =>
        ORDER[a.license.group] - ORDER[b.license.group]
        || (a.relation === b.relation ? 0 : a.relation === 'direct' ? -1 : 1)
        || a.ecosystem.localeCompare(b.ecosystem)
        || a.name.localeCompare(b.name));
}

export function groupCounts(packages) {
    const counts = Object.fromEntries(LICENSE_GROUPS.map(g => [g, 0]));
    for (const p of packages) counts[p.license.group]++;
    return counts;
}

function versionBasis(p) {
    if (p.versionKind === 'range-min') return 'lowest version in range';
    if (p.versionKind === 'latest') return 'latest release (no version pinned)';
    return '';
}

function packageNotes(p) {
    const notes = [...(p.license.notes || [])];
    if (p.status === 'not-found') notes.push('not found on deps.dev');
    if (p.status === 'not-checked') notes.push('not looked up on deps.dev (lookup limit), so license and advisories are unknown');
    if (p.status === 'error') notes.push(`lookup failed: ${p.error || 'error'}`);
    if (p.healthFlags && p.healthFlags.length) notes.push(...p.healthFlags);
    else if (p.deprecated) notes.push('deprecated or yanked');
    if (p.relation === 'direct' && p.outdated && p.latest) {
        notes.push(p.upgradeClears ? `outdated: latest ${p.latest} clears ${p.upgradeClears} advisor${p.upgradeClears === 1 ? 'y' : 'ies'}` : `outdated: latest ${p.latest}`);
    }
    const basis = versionBasis(p);
    if (basis) notes.push(`version: ${basis}`);
    return notes;
}

const relationText = p => `${p.relation}${p.dev ? ' (dev)' : ''}`;
const viaText = p => (p.via && p.via.length ? p.via.slice(0, 3).join(', ') + (p.via.length > 3 ? ` +${p.via.length - 3} more` : '') : '');
/** "express → body-parser → qs": how a transitive package is pulled in (shortest chain found). */
export const pathText = p => (p.path && p.path.length > 1 ? p.path.join(' → ') : '');
const licenseText = p => p.license.expression || 'none found';
// Brief lines still carry advisories: a permissive license says nothing about security.
const briefLine = p => `${p.ecosystem}:${p.name}@${p.version || '?'} (${licenseText(p)})${p.dev ? ' [dev]' : ''}${p.advisories && p.advisories.length ? ` [advisories: ${advisoryList(p).join(', ')}]` : ''}${policyAttr(p) ? ` [policy ${policyAttr(p)}]` : ''}`;

function scopeText(ctx) {
    return `${ctx.includeTransitive ? 'Direct and transitive' : 'Direct'} dependencies${ctx.includeDev ? ', including development/test dependencies' : ', runtime only (development/test dependencies excluded)'}`;
}

function summaryText(counts) {
    return LICENSE_GROUPS.map(g => `${GROUP_LABELS[g]}: ${counts[g]}`).join(', ');
}

function byGroup(packages) {
    const groups = new Map(LICENSE_GROUPS.map(g => [g, []]));
    for (const p of sortPackages(packages)) groups.get(p.license.group).push(p);
    return [...groups.entries()].filter(([, list]) => list.length > 0);
}

function repoLicenseText(ctx) {
    if (!ctx.repoLicense || !ctx.repoLicense.expression) return 'not detected';
    return `${ctx.repoLicense.expression} (${GROUP_LABELS[ctx.repoLicense.group]})`;
}

// ------------------------------------------------------------------ Claude XML

function formatClaudeXml(ctx) {
    const counts = groupCounts(ctx.packages);
    let doc = '<documents>\n  <!-- Dependency License Report -->\n  <context>\n';
    doc += `    <repository>${escapeXml(ctx.repoName)}</repository>\n`;
    if (ctx.source) doc += `    <source>${escapeXml(ctx.source)}</source>\n`;
    doc += `    <repository_license>${escapeXml(repoLicenseText(ctx))}</repository_license>\n`;
    doc += `    <scope>${escapeXml(scopeText(ctx))}</scope>\n`;
    if (ctx.manifests && ctx.manifests.length) doc += `    <manifests>${escapeXml(ctx.manifests.join(', '))}</manifests>\n`;
    doc += `    <versions>${escapeXml(lockText(ctx))}</versions>\n`;
    if (ctx.policy && ctx.policy.description) doc += `    <policy>${escapeXml(ctx.policy.description)}</policy>\n`;
    doc += `    <package_count>${ctx.packages.length}</package_count>\n`;
    doc += `    <summary>${escapeXml(summaryText(counts))}</summary>\n`;
    if (ctx.warnings && ctx.warnings.length) doc += `    <warnings>${escapeXml(ctx.warnings.join(' '))}</warnings>\n`;
    doc += `    <note>${escapeXml(REPORT_NOTE)}</note>\n  </context>\n\n`;

    let index = 1;
    const cmp = ctx.comparison;
    if (cmp && cmp.diff) {
        const d = cmp.diff;
        doc += `  <document index="${index++}">\n    <source>Dependency changes: ${escapeXml(cmp.head)} compared with ${escapeXml(cmp.base)}</source>\n    <document_content>\n`;
        doc += `      <comparison base="${escapeXml(cmp.base)}" head="${escapeXml(cmp.head)}" added="${d.added.length}" updated="${d.updated.length}" removed="${d.removed.length}" new_advisories="${d.newAdvisories.length}" new_policy_findings="${d.newPolicyFindings.length}">\n`;
        for (const p of d.added) {
            doc += `        <added package="${escapeXml(pkgLabel(p))}" relation="${relationText(p)}" license="${escapeXml(licenseText(p))}" group="${p.license.group}"${pathText(p) ? ` path="${escapeXml(pathText(p))}"` : ''}${p.advisories && p.advisories.length ? ` advisories="${escapeXml(advIds(p))}"` : ''}${policyAttr(p) ? ` policy="${escapeXml(policyAttr(p))}"` : ''} />\n`;
        }
        for (const u of d.updated) {
            doc += `        <updated package="${escapeXml(`${u.pkg.ecosystem}:${u.pkg.name}`)}" from="${escapeXml(u.from.join(', '))}" to="${escapeXml(u.to.join(', '))}" relation="${relationText(u.pkg)}" license="${escapeXml(licenseText(u.pkg))}" />\n`;
        }
        for (const p of d.removed) doc += `        <removed package="${escapeXml(pkgLabel(p))}" relation="${relationText(p)}" />\n`;
        for (const { pkg, id } of d.newAdvisories) {
            const a = (pkg.advisoryDetails || []).find(x => x.id === id) || { severity: 'unknown' };
            doc += `        <new_advisory id="${escapeXml(id)}" severity="${a.severity}" package="${escapeXml(pkgLabel(pkg))}">${escapeXml(a.title || '')}</new_advisory>\n`;
        }
        for (const p of d.newPolicyFindings) doc += `        <new_policy_finding verdict="${p.policy.verdict}" package="${escapeXml(pkgLabel(p))}">${escapeXml(p.policy.reason)}</new_policy_finding>\n`;
        doc += '      </comparison>\n    </document_content>\n  </document>\n';
    }
    for (const [group, list] of byGroup(ctx.packages)) {
        doc += `  <document index="${index++}">\n    <source>${escapeXml(GROUP_LABELS[group])} licenses (${list.length})</source>\n`;
        doc += `    <document_content>\n      <license_group name="${group}" hint="${escapeXml(GROUP_HINTS[group])}">\n`;
        if (group === 'permissive' && ctx.compactPermissive) {
            doc += `        <packages format="ecosystem:name@version (license)">\n${escapeXml(list.map(briefLine).join('\n'))}\n        </packages>\n`;
        } else {
            for (const p of list) {
                const notes = packageNotes(p);
                doc += `        <package ecosystem="${p.ecosystem}" name="${escapeXml(p.name)}" version="${escapeXml(p.version || '?')}" relation="${relationText(p)}" license="${escapeXml(licenseText(p))}"`;
                if (viaText(p)) doc += ` via="${escapeXml(viaText(p))}"`;
                if (pathText(p)) doc += ` path="${escapeXml(pathText(p))}"`;
                if (policyAttr(p)) doc += ` policy="${escapeXml(policyAttr(p))}"`;
                if (p.advisories && p.advisories.length) doc += ` advisories="${escapeXml(advisoryList(p).join(', '))}"`;
                if (notes.length) doc += ` notes="${escapeXml(notes.join('; '))}"`;
                doc += ' />\n';
            }
        }
        doc += '      </license_group>\n    </document_content>\n  </document>\n';
    }
    const findings = policyFindings(ctx.packages);
    if (findings.length) {
        doc += `  <document index="${index++}">\n    <source>Policy results (${findings.length})</source>\n    <document_content>\n`;
        for (const p of findings) {
            doc += `      <policy_result verdict="${p.policy.verdict}" package="${escapeXml(`${p.ecosystem}:${p.name}@${p.version || '?'}`)}" license="${escapeXml(licenseText(p))}" relation="${relationText(p)}"${pathText(p) ? ` path="${escapeXml(pathText(p))}"` : ''}>${escapeXml(p.policy.reason)}</policy_result>\n`;
        }
        doc += '    </document_content>\n  </document>\n';
    }
    const advisories = collectAdvisories(ctx.packages);
    if (advisories.length) {
        doc += `  <document index="${index++}">\n    <source>Security advisories (${advisories.length})</source>\n    <document_content>\n`;
        for (const { p, a } of advisories) {
            doc += `      <advisory id="${escapeXml(a.id)}" severity="${a.severity}"${a.score ? ` cvss="${a.score}"` : ''} package="${escapeXml(`${p.name}@${p.version || '?'}`)}" relation="${relationText(p)}"${pathText(p) ? ` path="${escapeXml(pathText(p))}"` : ''}`
                + `${a.aliases && a.aliases.length ? ` aliases="${escapeXml(a.aliases.join(' '))}"` : ''}${fixText(p) ? ` fix="${escapeXml(fixText(p))}"` : ''}>${escapeXml(a.title || '')}</advisory>\n`;
        }
        doc += '    </document_content>\n  </document>\n';
    }
    if (ctx.instructions && ctx.instructions.trim()) {
        doc += `  <instructions>\n<![CDATA[\n${escapeCdata(stripXmlInvalidChars(ctx.instructions.trim()))}\n]]>\n  </instructions>\n`;
    }
    doc += '</documents>';
    return { text: doc, ext: 'xml', mime: 'application/xml' };
}

// ------------------------------------------------------------------ Markdown

const mdCell = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

function formatMarkdown(ctx) {
    const counts = groupCounts(ctx.packages);
    let md = `# Dependency License Report: ${ctx.repoName}\n\n`;
    if (ctx.source) md += `- **Source:** ${ctx.source}\n`;
    md += `- **Repository license:** ${repoLicenseText(ctx)}\n`;
    md += `- **Scope:** ${scopeText(ctx)}\n`;
    if (ctx.manifests && ctx.manifests.length) md += `- **Manifests:** ${ctx.manifests.join(', ')}\n`;
    md += `- **Versions:** ${lockText(ctx)}\n`;
    if (ctx.policy && ctx.policy.description) md += `- **Policy:** ${ctx.policy.description}\n`;
    md += `- **Packages:** ${ctx.packages.length} (${summaryText(counts)})\n\n`;
    if (ctx.warnings && ctx.warnings.length) md += `> **Warning:** ${ctx.warnings.join(' ')}\n\n`;
    md += `> **Note:** ${REPORT_NOTE}\n\n`;
    const cmp = ctx.comparison;
    if (cmp && cmp.diff) {
        const d = cmp.diff;
        md += `## Changes: ${cmp.head} compared with ${cmp.base}\n\n`;
        md += `${summarizeDiff(d)}.\n\n`;
        if (d.newPolicyFindings.length) {
            md += '### New policy findings\n\n| Verdict | Package | Reason |\n| --- | --- | --- |\n';
            for (const p of d.newPolicyFindings) md += `| ${p.policy.verdict === 'block' ? 'Blocked' : 'Review'} | ${mdCell(pkgLabel(p))} | ${mdCell(p.policy.reason)} |\n`;
            md += '\n';
        }
        if (d.newAdvisories.length) {
            md += '### New advisories\n\n| Severity | Advisory | Package | Title |\n| --- | --- | --- | --- |\n';
            for (const { pkg, id } of d.newAdvisories) {
                const a = (pkg.advisoryDetails || []).find(x => x.id === id) || { severity: 'unknown' };
                md += `| ${SEVERITY_LABEL[a.severity]}${a.score ? ` (${a.score})` : ''} | ${mdCell(id)} | ${mdCell(pkgLabel(pkg))} | ${mdCell(a.title || '')} |\n`;
            }
            md += '\n';
        }
        if (d.added.length) {
            md += '### Added\n\n| Package | Relation | License | Pulled in by |\n| --- | --- | --- | --- |\n';
            for (const p of d.added) md += `| ${mdCell(pkgLabel(p))} | ${relationText(p)} | ${mdCell(licenseText(p))} | ${mdCell(pathText(p))} |\n`;
            md += '\n';
        }
        if (d.updated.length) {
            md += '### Updated\n\n| Package | From | To |\n| --- | --- | --- |\n';
            for (const u of d.updated) md += `| ${mdCell(`${u.pkg.ecosystem}:${u.pkg.name}`)} | ${mdCell(u.from.join(', '))} | ${mdCell(u.to.join(', '))} |\n`;
            md += '\n';
        }
        if (d.removed.length) md += `### Removed\n\n${d.removed.map(p => `- ${pkgLabel(p)}`).join('\n')}\n\n`;
    }

    for (const [group, list] of byGroup(ctx.packages)) {
        md += `## ${GROUP_LABELS[group]} (${list.length})\n\n${GROUP_HINTS[group]}\n\n`;
        if (group === 'permissive' && ctx.compactPermissive) {
            const body = list.map(briefLine).join('\n');
            const fence = getMarkdownFence(body);
            md += `${fence}text\n${body}\n${fence}\n\n`;
            continue;
        }
        md += '| Package | Version | Ecosystem | Relation | License | Pulled in by | Advisories | Notes |\n';
        md += '| --- | --- | --- | --- | --- | --- | --- | --- |\n';
        for (const p of list) {
            md += `| ${mdCell(p.name)} | ${mdCell(p.version || '?')} | ${p.ecosystem} | ${relationText(p)} | ${mdCell(licenseText(p))} | ${mdCell(pathText(p) || viaText(p))} | ${mdCell(advisoryList(p).join(', '))} | ${mdCell([policyAttr(p) && `policy ${policyAttr(p)}`, ...packageNotes(p)].filter(Boolean).join('; '))} |\n`;
        }
        md += '\n';
    }
    const findings = policyFindings(ctx.packages);
    if (findings.length) {
        md += `## Policy results (${findings.length})\n\n| Verdict | Package | License | Relation | Reason |\n| --- | --- | --- | --- | --- |\n`;
        for (const p of findings) {
            md += `| ${p.policy.verdict === 'block' ? 'Blocked' : 'Review'} | ${mdCell(`${p.name}@${p.version || '?'}`)} | ${mdCell(licenseText(p))} | ${relationText(p)}${pathText(p) ? ` (${mdCell(pathText(p))})` : ''} | ${mdCell(p.policy.reason)} |\n`;
        }
        md += '\n';
    }
    const advisories = collectAdvisories(ctx.packages);
    if (advisories.length) {
        md += `## Security advisories (${advisories.length})\n\n`;
        md += '| Severity | Advisory | Package | Relation | Title | Fix |\n| --- | --- | --- | --- | --- | --- |\n';
        for (const { p, a } of advisories) {
            md += `| ${SEVERITY_LABEL[a.severity]}${a.score ? ` (${a.score})` : ''} | ${mdCell([a.id, ...(a.aliases || [])].join(', '))} | ${mdCell(`${p.name}@${p.version || '?'}`)} | ${relationText(p)} | ${mdCell(a.title || '')} | ${mdCell(fixText(p))} |\n`;
        }
        md += '\n';
    }
    if (ctx.instructions && ctx.instructions.trim()) md += `## Instructions\n\n${ctx.instructions.trim()}\n`;
    return { text: md, ext: 'md', mime: 'text/markdown' };
}

// ------------------------------------------------------------------ Generic XML

function formatGenericXml(ctx) {
    const counts = groupCounts(ctx.packages);
    let xml = `<dependency_report repository="${escapeXml(ctx.repoName)}" repository_license="${escapeXml(repoLicenseText(ctx))}" count="${ctx.packages.length}">\n`;
    if (ctx.source) xml += `  <source>${escapeXml(ctx.source)}</source>\n`;
    xml += `  <scope>${escapeXml(scopeText(ctx))}</scope>\n`;
    if (ctx.manifests && ctx.manifests.length) xml += `  <manifests>${escapeXml(ctx.manifests.join(', '))}</manifests>\n`;
    xml += `  <versions>${escapeXml(lockText(ctx))}</versions>\n`;
    if (ctx.policy && ctx.policy.description) xml += `  <policy>${escapeXml(ctx.policy.description)}</policy>\n`;
    xml += `  <summary>${escapeXml(summaryText(counts))}</summary>\n`;
    if (ctx.warnings && ctx.warnings.length) xml += `  <warnings>${escapeXml(ctx.warnings.join(' '))}</warnings>\n`;
    xml += `  <note>${escapeXml(REPORT_NOTE)}</note>\n`;
    if (ctx.comparison && ctx.comparison.diff) {
        const d = ctx.comparison.diff;
        xml += `  <comparison base="${escapeXml(ctx.comparison.base)}" head="${escapeXml(ctx.comparison.head)}">\n`;
        for (const p of d.added) xml += `    <added package="${escapeXml(pkgLabel(p))}" license="${escapeXml(licenseText(p))}" />\n`;
        for (const u of d.updated) xml += `    <updated package="${escapeXml(`${u.pkg.ecosystem}:${u.pkg.name}`)}" from="${escapeXml(u.from.join(', '))}" to="${escapeXml(u.to.join(', '))}" />\n`;
        for (const p of d.removed) xml += `    <removed package="${escapeXml(pkgLabel(p))}" />\n`;
        for (const { pkg, id } of d.newAdvisories) xml += `    <new_advisory id="${escapeXml(id)}" package="${escapeXml(pkgLabel(pkg))}" />\n`;
        for (const p of d.newPolicyFindings) xml += `    <new_policy_finding verdict="${p.policy.verdict}" package="${escapeXml(pkgLabel(p))}">${escapeXml(p.policy.reason)}</new_policy_finding>\n`;
        xml += '  </comparison>\n';
    }
    for (const [group, list] of byGroup(ctx.packages)) {
        xml += `  <group name="${group}" count="${list.length}">\n`;
        for (const p of list) {
            const notes = packageNotes(p);
            xml += `    <package ecosystem="${p.ecosystem}" name="${escapeXml(p.name)}" version="${escapeXml(p.version || '?')}" relation="${relationText(p)}" license="${escapeXml(licenseText(p))}"`
                + `${viaText(p) ? ` via="${escapeXml(viaText(p))}"` : ''}${pathText(p) ? ` path="${escapeXml(pathText(p))}"` : ''}${policyAttr(p) ? ` policy="${escapeXml(policyAttr(p))}"` : ''}${p.advisories && p.advisories.length ? ` advisories="${escapeXml(advisoryList(p).join(', '))}"` : ''}${notes.length ? ` notes="${escapeXml(notes.join('; '))}"` : ''} />\n`;
        }
        xml += '  </group>\n';
    }
    const advisories = collectAdvisories(ctx.packages);
    if (advisories.length) {
        xml += `  <advisories count="${advisories.length}">\n`;
        for (const { p, a } of advisories) {
            xml += `    <advisory id="${escapeXml(a.id)}" severity="${a.severity}"${a.score ? ` cvss="${a.score}"` : ''} package="${escapeXml(`${p.name}@${p.version || '?'}`)}"${fixText(p) ? ` fix="${escapeXml(fixText(p))}"` : ''}>${escapeXml(a.title || '')}</advisory>\n`;
        }
        xml += '  </advisories>\n';
    }
    if (ctx.instructions && ctx.instructions.trim()) xml += `  <instructions><![CDATA[\n${escapeCdata(stripXmlInvalidChars(ctx.instructions.trim()))}\n]]></instructions>\n`;
    xml += '</dependency_report>';
    return { text: xml, ext: 'xml', mime: 'application/xml' };
}

// ------------------------------------------------------------------ JSON

function formatJson(ctx) {
    const payload = {
        repository: ctx.repoName,
        ...(ctx.source ? { source: ctx.source } : {}),
        repository_license: ctx.repoLicense && ctx.repoLicense.expression ? { expression: ctx.repoLicense.expression, group: ctx.repoLicense.group } : null,
        scope: scopeText(ctx),
        manifests: ctx.manifests || [],
        versions: lockText(ctx),
        ...(ctx.policy && ctx.policy.description ? { policy: ctx.policy.description } : {}),
        summary: groupCounts(ctx.packages),
        ...(ctx.comparison && ctx.comparison.diff ? { comparison: {
            base: ctx.comparison.base,
            head: ctx.comparison.head,
            added: ctx.comparison.diff.added.map(pkgLabel),
            updated: ctx.comparison.diff.updated.map(u => ({ package: `${u.pkg.ecosystem}:${u.pkg.name}`, from: u.from, to: u.to })),
            removed: ctx.comparison.diff.removed.map(pkgLabel),
            new_advisories: ctx.comparison.diff.newAdvisories.map(({ pkg, id }) => ({ id, package: pkgLabel(pkg) })),
            new_policy_findings: ctx.comparison.diff.newPolicyFindings.map(p => ({ package: pkgLabel(p), ...p.policy }))
        } } : {}),
        ...(ctx.warnings && ctx.warnings.length ? { warnings: ctx.warnings } : {}),
        note: REPORT_NOTE,
        packages: sortPackages(ctx.packages).map(p => ({
            ecosystem: p.ecosystem,
            name: p.name,
            version: p.version,
            relation: p.relation,
            dev: p.dev,
            license: p.license.expression || null,
            license_group: p.license.group,
            ...(p.via && p.via.length ? { via: p.via } : {}),
            ...(p.path && p.path.length > 1 ? { path: p.path } : {}),
            ...(p.policy ? { policy: p.policy } : {}),
            ...(p.advisories && p.advisories.length ? {
                advisories: (p.advisoryDetails && p.advisoryDetails.length ? p.advisoryDetails : p.advisories.map(id => ({ id, severity: 'unknown' })))
                    .map(a => ({ id: a.id, severity: a.severity, ...(a.score ? { cvss: a.score } : {}), ...(a.title ? { title: a.title } : {}), ...(a.aliases && a.aliases.length ? { aliases: a.aliases } : {}) }))
            } : {}),
            ...(p.relation === 'direct' && p.latest ? { latest: p.latest, outdated: Boolean(p.outdated), ...(p.upgradeClears ? { upgrade_clears_advisories: p.upgradeClears } : {}) } : {}),
            ...(p.health ? { health: { scorecard: p.health.scorecard, project: p.health.project } } : {}),
            ...(packageNotes(p).length ? { notes: packageNotes(p) } : {}),
            manifests: p.manifests
        })),
        ...(ctx.instructions && ctx.instructions.trim() ? { instructions: ctx.instructions.trim() } : {})
    };
    return { text: JSON.stringify(payload, null, 2), ext: 'json', mime: 'application/json' };
}

/**
 * @param {'claude-xml'|'markdown'|'generic-xml'|'json'} format
 * @param {{ repoName: string, source?: string, repoLicense?: {expression, group}, packages: object[],
 *   manifests?: string[], includeTransitive?: boolean, includeDev?: boolean, compactPermissive?: boolean,
 *   lockfiles?: string[], policy?: { description: string }, comparison?: { base, head, diff },
 *   warnings?: string[], instructions?: string }} ctx
 */
export function buildDepsOutput(format, ctx) {
    switch (format) {
        case 'markdown': return formatMarkdown(ctx);
        case 'generic-xml': return formatGenericXml(ctx);
        case 'json': return formatJson(ctx);
        case 'claude-xml':
        default: return formatClaudeXml(ctx);
    }
}
