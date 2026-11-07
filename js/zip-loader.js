/**
 * Zero-dependency reader for local .zip archives (e.g. GitHub's "Download ZIP").
 *
 * - Reads only the archive's central directory up front (via File.slice), so listing files
 *   costs a few small reads however large the archive is.
 * - Extracts one file at a time on demand, with Store (method 0) and Deflate (method 8)
 *   via the browser's DecompressionStream('deflate-raw').
 * - Supports ZIP64 (archives over 4 GB or with more than 65,535 entries).
 * - Strips a single shared top-level folder (e.g. "repo-main/") and macOS "__MACOSX/" metadata.
 *
 * Nothing is uploaded: all reads happen locally in the browser.
 */

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const MAX_EOCD_SEARCH = 22 + 0xffff; // fixed EOCD size + max comment length

export class ZipError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ZipError';
    }
}

async function readBytes(blob, start, end) {
    if (start < 0 || end > blob.size || start > end) {
        throw new ZipError('This .zip file is truncated or corrupted.');
    }
    return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

function getUint64(view, offset) {
    const value = view.getBigUint64(offset, true);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new ZipError('This .zip file is too large to read in the browser.');
    }
    return Number(value);
}

/** Locates the end-of-central-directory record and returns where the central directory is. */
async function readDirectoryLocation(blob) {
    if (blob.size < 22) throw new ZipError('Not a valid .zip file.');
    const tailStart = Math.max(0, blob.size - MAX_EOCD_SEARCH);
    const tail = await readBytes(blob, tailStart, blob.size);
    const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);

    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
        if (view.getUint32(i, true) === SIG_EOCD) {
            eocd = i;
            break;
        }
    }
    if (eocd === -1) throw new ZipError('Not a valid .zip file (no zip directory found).');

    let totalEntries = view.getUint16(eocd + 10, true);
    let cdSize = view.getUint32(eocd + 12, true);
    let cdOffset = view.getUint32(eocd + 16, true);

    const needsZip64 = totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff;
    const locatorPos = eocd - 20;
    if (locatorPos >= 0 && view.getUint32(locatorPos, true) === SIG_ZIP64_LOCATOR) {
        const zip64EocdOffset = getUint64(view, locatorPos + 8);
        const rec = await readBytes(blob, zip64EocdOffset, zip64EocdOffset + 56);
        const recView = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
        if (recView.getUint32(0, true) !== SIG_ZIP64_EOCD) {
            throw new ZipError('This .zip file is corrupted (bad ZIP64 directory).');
        }
        totalEntries = getUint64(recView, 32);
        cdSize = getUint64(recView, 40);
        cdOffset = getUint64(recView, 48);
    } else if (needsZip64) {
        throw new ZipError('This .zip file is corrupted (missing ZIP64 directory).');
    }

    return { totalEntries, cdSize, cdOffset };
}

/** Reads ZIP64 values from an entry's extra field for any 32-bit fields set to 0xFFFFFFFF. */
function applyZip64Extra(entry, extraView) {
    let p = 0;
    while (p + 4 <= extraView.byteLength) {
        const id = extraView.getUint16(p, true);
        const len = extraView.getUint16(p + 2, true);
        if (id === 0x0001) {
            let q = p + 4;
            const end = q + len;
            if (entry.uncompressedSize === 0xffffffff && q + 8 <= end) { entry.uncompressedSize = getUint64(extraView, q); q += 8; }
            if (entry.compressedSize === 0xffffffff && q + 8 <= end) { entry.compressedSize = getUint64(extraView, q); q += 8; }
            if (entry.localHeaderOffset === 0xffffffff && q + 8 <= end) { entry.localHeaderOffset = getUint64(extraView, q); }
            return;
        }
        p += 4 + len;
    }
}

function normalizeEntryPath(name) {
    const parts = name.replace(/\\/g, '/').split('/').filter(seg => seg && seg !== '.');
    if (parts.includes('..')) return null;
    return parts.join('/');
}

/**
 * Parses a .zip File/Blob and returns its file list plus an on-demand reader.
 *
 * @param {Blob & {name?: string}} file
 * @returns {Promise<{label: string, fileName: string, rootFolder: string|null,
 *   treeNodes: Array<{path: string, type: 'blob', mode: string, size: number}>,
 *   encryptedCount: number,
 *   readFile: (path: string, opts?: {maxBytes?: number}) => Promise<Uint8Array>,
 *   readText: (path: string, opts?: {maxBytes?: number}) => Promise<string>}>}
 */
export async function parseZipArchive(file) {
    const { totalEntries, cdSize, cdOffset } = await readDirectoryLocation(file);
    const cd = await readBytes(file, cdOffset, cdOffset + cdSize);
    const view = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
    const utf8 = new TextDecoder('utf-8');

    const rawEntries = [];
    let ptr = 0;
    for (let i = 0; i < totalEntries; i++) {
        if (ptr + 46 > cd.length || view.getUint32(ptr, true) !== SIG_CENTRAL) {
            throw new ZipError('This .zip file is corrupted (bad directory entry).');
        }
        const madeByHost = view.getUint8(ptr + 5);
        const flags = view.getUint16(ptr + 8, true);
        const nameLen = view.getUint16(ptr + 28, true);
        const extraLen = view.getUint16(ptr + 30, true);
        const commentLen = view.getUint16(ptr + 32, true);
        const externalAttr = view.getUint32(ptr + 38, true);
        const entry = {
            method: view.getUint16(ptr + 10, true),
            compressedSize: view.getUint32(ptr + 20, true),
            uncompressedSize: view.getUint32(ptr + 24, true),
            localHeaderOffset: view.getUint32(ptr + 42, true),
            encrypted: Boolean(flags & 0x0001),
            // Unix file type lives in the upper 16 bits when the archive was made on Unix (host 3).
            isSymlink: madeByHost === 3 && ((externalAttr >>> 16) & 0xf000) === 0xa000
        };
        const rawName = utf8.decode(cd.subarray(ptr + 46, ptr + 46 + nameLen));
        applyZip64Extra(entry, new DataView(cd.buffer, cd.byteOffset + ptr + 46 + nameLen, extraLen));
        ptr += 46 + nameLen + extraLen + commentLen;

        if (rawName.endsWith('/') || rawName.endsWith('\\')) continue; // directory entry
        const path = normalizeEntryPath(rawName);
        if (!path || path === '__MACOSX' || path.startsWith('__MACOSX/')) continue;
        entry.rawPath = path;
        rawEntries.push(entry);
    }

    // Strip one shared top-level folder, as produced by GitHub's "Download ZIP" and git archive.
    let rootFolder = null;
    if (rawEntries.length > 0 && rawEntries.every(e => e.rawPath.includes('/'))) {
        const first = rawEntries[0].rawPath.split('/')[0];
        if (rawEntries.every(e => e.rawPath.startsWith(first + '/'))) rootFolder = first;
    }

    const fileName = file.name || 'archive.zip';
    const label = rootFolder || fileName.replace(/\.zip$/i, '') || 'local-archive';

    const entries = new Map();
    const treeNodes = [];
    let encryptedCount = 0;
    for (const e of rawEntries) {
        const path = rootFolder ? e.rawPath.slice(rootFolder.length + 1) : e.rawPath;
        if (!path || entries.has(path)) continue;
        entries.set(path, e);
        if (e.encrypted) encryptedCount++;
        treeNodes.push({ path, type: 'blob', mode: e.isSymlink ? '120000' : '100644', size: e.uncompressedSize });
    }

    if (treeNodes.length > 0 && encryptedCount === treeNodes.length) {
        throw new ZipError('This .zip file is password-protected. Password-protected archives are not supported.');
    }

    async function readFile(path, { maxBytes = Infinity } = {}) {
        const e = entries.get(path);
        if (!e) throw new ZipError(`File not found in archive: ${path}`);
        if (e.encrypted) throw new ZipError(`${path} is password-protected.`);

        const header = await readBytes(file, e.localHeaderOffset, e.localHeaderOffset + 30);
        const hv = new DataView(header.buffer, header.byteOffset, header.byteLength);
        if (hv.getUint32(0, true) !== SIG_LOCAL) throw new ZipError(`Corrupted entry: ${path}`);
        const dataStart = e.localHeaderOffset + 30 + hv.getUint16(26, true) + hv.getUint16(28, true);
        const blob = file.slice(dataStart, dataStart + e.compressedSize);
        // Cap output at the size the directory declares (plus the caller's cap), so a
        // malformed or hostile entry cannot expand without limit.
        const limit = Math.min(maxBytes, e.uncompressedSize);

        if (e.method === 0) {
            if (e.compressedSize > limit) throw new ZipError(`${path} is larger than the size limit.`);
            return new Uint8Array(await blob.arrayBuffer());
        }
        if (e.method !== 8) {
            throw new ZipError(`${path} uses an unsupported compression method (${e.method}).`);
        }
        if (typeof DecompressionStream === 'undefined') {
            throw new ZipError('This browser cannot unzip files. Use a current version of Chrome, Edge, Firefox or Safari.');
        }

        const reader = blob.stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
        const chunks = [];
        let total = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                total += value.length;
                if (total > limit) {
                    await reader.cancel();
                    throw new ZipError(`${path} expands beyond its declared size.`);
                }
                chunks.push(value);
            }
        } catch (err) {
            if (err instanceof ZipError) throw err;
            throw new ZipError(`Could not decompress ${path}: ${err.message || err}`);
        }
        const out = new Uint8Array(total);
        let offset = 0;
        for (const c of chunks) {
            out.set(c, offset);
            offset += c.length;
        }
        return out;
    }

    async function readText(path, opts) {
        return utf8.decode(await readFile(path, opts));
    }

    return { label, fileName, rootFolder, treeNodes, encryptedCount, readFile, readText };
}
