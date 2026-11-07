import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, crc32 } from 'node:zlib';
import { parseZipArchive, ZipError } from '../js/zip-loader.js';
import { buildContextOutput } from '../js/formatters.js';
import { redactSecrets } from '../js/secrets.js';

/**
 * Builds a .zip in memory. Each entry: { name, data, method = 8, symlink = false,
 * encrypted = false, declaredSize } (declaredSize overrides the stored uncompressed size).
 */
function makeZip(entries, { name = 'test.zip' } = {}) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const e of entries) {
        const nameBuf = Buffer.from(e.name, 'utf8');
        const raw = Buffer.from(e.data ?? '', 'utf8');
        const method = e.method ?? 8;
        const body = method === 8 ? deflateRawSync(raw) : raw;
        const size = e.declaredSize ?? raw.length;
        const flags = (e.encrypted ? 0x0001 : 0) | 0x0800;
        const crc = crc32(raw);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(flags, 6);
        local.writeUInt16LE(method, 8);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(body.length, 18);
        local.writeUInt32LE(size, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        locals.push(local, nameBuf, body);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE((3 << 8) | 20, 4); // made by Unix
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(flags, 8);
        central.writeUInt16LE(method, 10);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(body.length, 20);
        central.writeUInt32LE(size, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        const unixMode = e.name.endsWith('/') ? 0o040755 : e.symlink ? 0o120777 : 0o100644;
        central.writeUInt32LE((unixMode << 16) >>> 0, 38);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, nameBuf);

        offset += local.length + nameBuf.length + body.length;
    }
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(offset, 16);
    const bytes = Buffer.concat([...locals, cd, eocd]);
    return new File([bytes], name, { type: 'application/zip' });
}

test('zip: lists files, strips the shared root folder and reads stored and deflated entries', async () => {
    const zip = makeZip([
        { name: 'my-repo-main/', data: '' },
        { name: 'my-repo-main/README.md', data: '# Hello\n', method: 0 },
        { name: 'my-repo-main/src/index.js', data: 'export const x = 1;\n'.repeat(50) }
    ], { name: 'my-repo-main.zip' });
    const z = await parseZipArchive(zip);
    assert.equal(z.rootFolder, 'my-repo-main');
    assert.equal(z.label, 'my-repo-main');
    assert.deepEqual(z.treeNodes.map(n => [n.path, n.type, n.mode, n.size]), [
        ['README.md', 'blob', '100644', 8],
        ['src/index.js', 'blob', '100644', 20 * 50]
    ]);
    assert.equal(await z.readText('README.md'), '# Hello\n');
    assert.equal(await z.readText('src/index.js'), 'export const x = 1;\n'.repeat(50));
});

test('zip: keeps paths as-is without a single root folder and labels by file name', async () => {
    const z = await parseZipArchive(makeZip([
        { name: 'a.txt', data: 'a' },
        { name: 'lib/b.txt', data: 'b' }
    ], { name: 'project-v2.zip' }));
    assert.equal(z.rootFolder, null);
    assert.equal(z.label, 'project-v2');
    assert.deepEqual(z.treeNodes.map(n => n.path), ['a.txt', 'lib/b.txt']);
});

test('zip: skips macOS metadata and marks symlinks so the app filters them', async () => {
    const z = await parseZipArchive(makeZip([
        { name: 'repo/src/a.js', data: 'a' },
        { name: 'repo/link', data: 'src/a.js', symlink: true },
        { name: '__MACOSX/repo/._a.js', data: 'junk' }
    ]));
    assert.equal(z.rootFolder, 'repo');
    assert.deepEqual(z.treeNodes.map(n => [n.path, n.mode]), [['src/a.js', '100644'], ['link', '120000']]);
});

test('zip: rejects non-zip, truncated and password-protected files with a ZipError', async () => {
    await assert.rejects(parseZipArchive(new File(['not a zip'], 'x.zip')), e => e instanceof ZipError && /Not a valid/.test(e.message));
    await assert.rejects(parseZipArchive(new File([new Uint8Array(0)], 'empty.zip')), ZipError);

    const good = new Uint8Array(await makeZip([{ name: 'a.txt', data: 'hello' }]).arrayBuffer());
    await assert.rejects(parseZipArchive(new File([good.slice(0, good.length - 30)], 'cut.zip')), ZipError);

    await assert.rejects(
        parseZipArchive(makeZip([{ name: 'a.txt', data: 'x', encrypted: true }])),
        e => e instanceof ZipError && /password-protected/.test(e.message)
    );
});

test('zip: an entry that expands past its declared size is refused', async () => {
    const z = await parseZipArchive(makeZip([{ name: 'bomb.txt', data: 'A'.repeat(100000), declaredSize: 10 }]));
    assert.equal(z.treeNodes[0].size, 10);
    await assert.rejects(z.readText('bomb.txt'), e => e instanceof ZipError && /declared size/.test(e.message));
});

test('zip: unknown path and unsupported compression method give clear errors', async () => {
    const z = await parseZipArchive(makeZip([{ name: 'a.bin', data: 'xyz', method: 12 }]));
    await assert.rejects(z.readText('missing.txt'), /not found/);
    await assert.rejects(z.readText('a.bin'), /unsupported compression method \(12\)/);
});

test('zip: file contents go through secret redaction like GitHub files', async () => {
    const token = 'ghp_aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3z5A';
    const z = await parseZipArchive(makeZip([{ name: 'repo/config.js', data: `const token = "${token}";\n` }]));
    const text = await z.readText('config.js');
    assert.ok(text.includes(token));
    assert.ok(!redactSecrets(text, 'config.js').includes(token));
});

test('formatters: a local archive is named without an owner and shows its source, not a branch', () => {
    const repoInfo = { owner: '', repo: 'my-repo-main', isZip: true, source: 'local archive my-repo-main.zip' };
    const files = [{ path: 'a.js', content: 'x' }];
    const xml = buildContextOutput('claude-xml', repoInfo, '', 'a.js\n', files).text;
    assert.match(xml, /<repository>my-repo-main<\/repository>/);
    assert.match(xml, /<source>local archive my-repo-main\.zip<\/source>/);
    assert.doesNotMatch(xml, /<branch>/);

    const md = buildContextOutput('markdown', repoInfo, '', 'a.js\n', files).text;
    assert.match(md, /^# Repository: my-repo-main$/m);
    assert.doesNotMatch(md, /Branch:/);

    const json = JSON.parse(buildContextOutput('json', repoInfo, '', 'a.js\n', files).text);
    assert.equal(json.repository, 'my-repo-main');
    assert.equal(json.branch, undefined);
    assert.equal(json.source, 'local archive my-repo-main.zip');

    const gx = buildContextOutput('generic-xml', repoInfo, '', 'a.js\n', files).text;
    assert.match(gx, /<repository name="my-repo-main" source="local archive my-repo-main\.zip">/);

    // GitHub repos are unchanged.
    const gh = buildContextOutput('claude-xml', { owner: 'o', repo: 'r' }, 'main', 'a.js\n', files).text;
    assert.match(gh, /<repository>o\/r<\/repository>\n {4}<branch>main<\/branch>/);
});
