import test from 'node:test';
import assert from 'node:assert/strict';
import { toCsv, csvCell, toCycloneDx, purlOf } from '../js/deps-export.js';
import { classifyLicense } from '../js/license-classify.js';

const pkg = (over = {}) => ({
    ecosystem: 'npm', name: 'express', version: '4.21.2', versionKind: 'locked', relation: 'direct', dev: false,
    license: classifyLicense('MIT'), advisories: ['GHSA-a'], advisoryDetails: [{ id: 'GHSA-a', title: 'Open redirect', score: 7.5, severity: 'high', aliases: ['CVE-2024-1'] }],
    maxSeverity: 'high', latest: '5.1.0', outdated: true, upgradeClears: 1, healthFlags: [], manifests: ['package.json'],
    policy: { verdict: 'allow', reason: 'Permissive license (MIT)' }, ...over
});

test('CSV: header, values, quoting, and protection against formula injection', () => {
    assert.equal(csvCell('a,b'), '"a,b"');
    assert.equal(csvCell('say "hi"'), '"say ""hi"""');
    assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
    assert.equal(csvCell('+1'), "'+1");
    assert.equal(csvCell('-cmd'), "'-cmd");
    assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
    assert.equal(csvCell(null), '');
    const csv = toCsv([pkg(), pkg({ name: '=evil', relation: 'transitive', path: ['express', '=evil'], advisories: [], advisoryDetails: [], maxSeverity: null, latest: undefined, outdated: false, upgradeClears: undefined })]);
    const lines = csv.trim().split('\r\n');
    assert.equal(lines.length, 3);
    assert.match(lines[0], /^ecosystem,name,version,version_source,relation,dev,license,license_group,policy,policy_reason,advisories,max_severity,advisory_ids,latest,outdated,upgrade_clears,health,path,manifests$/);
    assert.equal(lines[1], 'npm,express,4.21.2,locked,direct,no,MIT,permissive,allow,Permissive license (MIT),1,high,GHSA-a,5.1.0,yes,1,,,package.json');
    assert.match(lines[2], /^npm,'=evil,/);
    assert.match(lines[2], /,express > '?=evil,/);
});

test('package URLs follow the purl spec', () => {
    assert.equal(purlOf({ ecosystem: 'npm', name: '@babel/core', version: '7.24.0' }), 'pkg:npm/%40babel/core@7.24.0');
    assert.equal(purlOf({ ecosystem: 'npm', name: 'express', version: '4.21.2' }), 'pkg:npm/express@4.21.2');
    assert.equal(purlOf({ ecosystem: 'pypi', name: 'Zope_Interface', version: '5.4' }), 'pkg:pypi/zope-interface@5.4');
    assert.equal(purlOf({ ecosystem: 'go', name: 'github.com/spf13/cobra', version: 'v1.8.0' }), 'pkg:golang/github.com/spf13/cobra@v1.8.0');
    assert.equal(purlOf({ ecosystem: 'cargo', name: 'serde', version: '1.0.200+build' }), 'pkg:cargo/serde@1.0.200%2Bbuild');
    assert.equal(purlOf({ ecosystem: 'npm', name: 'x', version: null }), 'pkg:npm/x');
});

test('CycloneDX 1.5: components, licenses, direct dependencies and vulnerabilities', () => {
    const packages = [
        pkg(),
        pkg({ name: 'qs', version: '6.13.0', relation: 'transitive', path: ['express', 'qs'], license: classifyLicense('BSD-3-Clause'),
            advisories: ['GHSA-a', 'RUSTSEC-x'], advisoryDetails: [{ id: 'GHSA-a', title: 'Open redirect', score: 7.5, severity: 'high', aliases: [] }, { id: 'RUSTSEC-x', title: '', score: null, severity: 'unknown', aliases: [] }] }),
        pkg({ name: 'jest', version: '29.0.0', dev: true, license: classifyLicense(''), advisories: [], advisoryDetails: [] })
    ];
    const bom = toCycloneDx({ repoName: 'o/r', packages, timestamp: '2026-11-06T00:00:00Z', serial: '00000000-0000-4000-8000-000000000000' });
    assert.equal(bom.bomFormat, 'CycloneDX');
    assert.equal(bom.specVersion, '1.5');
    assert.equal(bom.serialNumber, 'urn:uuid:00000000-0000-4000-8000-000000000000');
    assert.equal(bom.metadata.component.name, 'o/r');
    assert.deepEqual(bom.components.map(c => [c.purl, c.scope, c.licenses ? c.licenses[0].expression : null]), [
        ['pkg:npm/express@4.21.2', 'required', 'MIT'], ['pkg:npm/qs@6.13.0', 'required', 'BSD-3-Clause'], ['pkg:npm/jest@29.0.0', 'optional', null]
    ]);
    assert.ok(bom.components[1].properties.some(p => p.name === 'gitdoco:path' && p.value === 'express > qs'));
    assert.deepEqual(bom.dependencies, [{ ref: 'root-component', dependsOn: ['pkg:npm/express@4.21.2', 'pkg:npm/jest@29.0.0'] }]);
    const ghsa = bom.vulnerabilities.find(v => v.id === 'GHSA-a');
    assert.deepEqual(ghsa.ratings, [{ score: 7.5, method: 'CVSSv31', severity: 'high' }]);
    assert.deepEqual(ghsa.affects.map(a => a.ref), ['pkg:npm/express@4.21.2', 'pkg:npm/qs@6.13.0'], 'one entry per advisory, all affected components');
    assert.equal(ghsa.source.url, 'https://github.com/advisories/GHSA-a');
    const rust = bom.vulnerabilities.find(v => v.id === 'RUSTSEC-x');
    assert.deepEqual(rust.ratings, [{ severity: 'unknown' }]);
    assert.equal(rust.source.name, 'OSV');
    assert.match(toCycloneDx({ repoName: 'x', packages: [] }).serialNumber, /^urn:uuid:[0-9a-f-]{36}$/);
});
