/**
 * Exports for the Dependencies tab: CSV for spreadsheets and a CycloneDX 1.5 JSON SBOM
 * (software bill of materials) with licenses and known vulnerabilities.
 */

const CSV_COLUMNS = [
    'ecosystem', 'name', 'version', 'version_source', 'relation', 'dev', 'license', 'license_group',
    'policy', 'policy_reason', 'advisories', 'max_severity', 'advisory_ids', 'latest', 'outdated',
    'upgrade_clears', 'health', 'path', 'manifests'
];

/**
 * One CSV cell. Values that a spreadsheet would run as a formula (= + - @, tab, CR) get a leading
 * apostrophe: package names and licenses come from repositories and registries, so they are
 * untrusted (CSV injection).
 */
export function csvCell(value) {
    let s = value === null || value === undefined ? '' : String(value);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(packages) {
    const rows = [CSV_COLUMNS.join(',')];
    for (const p of packages) {
        const details = p.advisoryDetails || [];
        rows.push([
            p.ecosystem, p.name, p.version || '', p.versionKind || '', p.relation, p.dev ? 'yes' : 'no',
            p.license && p.license.expression ? p.license.expression : '', p.license ? p.license.group : '',
            p.policy ? p.policy.verdict : '', p.policy ? p.policy.reason : '',
            (p.advisories || []).length, p.maxSeverity || '', (details.length ? details.map(a => a.id) : (p.advisories || [])).join(' '),
            p.latest || '', p.outdated ? 'yes' : '', p.upgradeClears || '', (p.healthFlags || []).join('; '),
            p.path && p.path.length > 1 ? p.path.join(' > ') : '', (p.manifests || []).join(' ')
        ].map(csvCell).join(','));
    }
    return rows.join('\r\n') + '\r\n';
}

// ------------------------------------------------------------------ CycloneDX

/** Package URL (https://github.com/package-url/purl-spec) for a package. */
export function purlOf(p) {
    const v = p.version ? `@${encodeURIComponent(p.version)}` : '';
    const seg = s => encodeURIComponent(s);
    switch (p.ecosystem) {
        case 'npm': {
            const m = /^(@[^/]+)\/(.+)$/.exec(p.name);
            return m ? `pkg:npm/${seg(m[1])}/${seg(m[2])}${v}` : `pkg:npm/${seg(p.name)}${v}`;
        }
        case 'pypi': return `pkg:pypi/${seg(String(p.name).toLowerCase().replace(/[-_.]+/g, '-'))}${v}`;
        case 'go': {
            const parts = String(p.name).split('/');
            return `pkg:golang/${parts.map(seg).join('/')}${v}`;
        }
        case 'cargo': return `pkg:cargo/${seg(p.name)}${v}`;
        default: return `pkg:generic/${seg(p.name)}${v}`;
    }
}

const CDX_SEVERITY = { critical: 'critical', high: 'high', medium: 'medium', low: 'low', unknown: 'unknown' };

function uuid() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
    const b = new Uint8Array(16);
    globalThis.crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * CycloneDX 1.5 JSON. Licenses are given as SPDX expressions; vulnerabilities carry their CVSS
 * score and severity and point at the affected components.
 * @param {{ repoName: string, packages: object[], timestamp?: string, serial?: string }} ctx
 */
export function toCycloneDx({ repoName, packages, timestamp, serial }) {
    const refs = new Map();
    const components = packages.map(p => {
        const purl = purlOf(p);
        refs.set(p, purl);
        const c = {
            type: 'library',
            'bom-ref': purl,
            name: p.name,
            ...(p.version ? { version: String(p.version) } : {}),
            purl,
            scope: p.dev ? 'optional' : 'required'
        };
        if (p.license && p.license.expression) c.licenses = [{ expression: p.license.expression }];
        const props = [{ name: 'gitdoco:relation', value: p.relation }];
        if (p.license) props.push({ name: 'gitdoco:license_group', value: p.license.group });
        if (p.policy) props.push({ name: 'gitdoco:policy', value: p.policy.verdict });
        if (p.path && p.path.length > 1) props.push({ name: 'gitdoco:path', value: p.path.join(' > ') });
        c.properties = props;
        return c;
    });

    const vulns = new Map();
    for (const p of packages) {
        const details = p.advisoryDetails && p.advisoryDetails.length ? p.advisoryDetails : (p.advisories || []).map(id => ({ id, severity: 'unknown' }));
        for (const a of details) {
            if (!vulns.has(a.id)) {
                const ghsa = /^GHSA-/i.test(a.id);
                vulns.set(a.id, {
                    'bom-ref': `vuln-${a.id}`,
                    id: a.id,
                    source: ghsa
                        ? { name: 'GitHub Advisory Database', url: `https://github.com/advisories/${a.id}` }
                        : { name: 'OSV', url: `https://osv.dev/vulnerability/${a.id}` },
                    ratings: [{
                        ...(typeof a.score === 'number' && a.score > 0 ? { score: a.score, method: 'CVSSv31' } : {}),
                        severity: CDX_SEVERITY[a.severity] || 'unknown'
                    }],
                    ...(a.title ? { description: a.title } : {}),
                    ...(a.aliases && a.aliases.length ? { references: a.aliases.map(id => ({ id, source: { name: /^CVE-/.test(id) ? 'NVD' : 'OSV', url: /^CVE-/.test(id) ? `https://nvd.nist.gov/vuln/detail/${id}` : `https://osv.dev/vulnerability/${id}` } })) } : {}),
                    affects: []
                });
            }
            const ref = refs.get(p);
            const affects = vulns.get(a.id).affects;
            if (!affects.some(x => x.ref === ref)) affects.push({ ref });
        }
    }

    const rootRef = 'root-component';
    return {
        bomFormat: 'CycloneDX',
        specVersion: '1.5',
        serialNumber: `urn:uuid:${serial || uuid()}`,
        version: 1,
        metadata: {
            timestamp: timestamp || new Date().toISOString(),
            tools: { components: [{ type: 'application', name: 'GitDoco', description: 'Dependency report generated in the browser from manifests, lockfiles and deps.dev' }] },
            component: { type: 'application', 'bom-ref': rootRef, name: repoName || 'repository' }
        },
        components,
        dependencies: [{ ref: rootRef, dependsOn: packages.filter(p => p.relation === 'direct').map(p => refs.get(p)) }],
        ...(vulns.size ? { vulnerabilities: [...vulns.values()] } : {})
    };
}
