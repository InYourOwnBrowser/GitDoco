/**
 * Groups SPDX license expressions for review. This is a heuristic to decide what a person (or
 * an AI, with the packed context) should look at; it is not a compatibility verdict and not
 * legal advice. Whether a license matters depends on how a package is used (linking,
 * distribution, hosted service), which this tool cannot know.
 *
 * Groups, from least to most attention needed:
 *   permissive      MIT, BSD, Apache-2.0, ISC, ...
 *   weak-copyleft   LGPL, MPL, EPL, CDDL, ... (file- or library-level obligations)
 *   strong-copyleft GPL, AGPL, EUPL, ... (obligations can extend to the whole work)
 *   restricted      source-available or non-commercial terms (SSPL, BUSL, Elastic, CC-BY-NC, ...)
 *   unknown         no license data, NOASSERTION, custom LicenseRef-*, or unrecognised IDs
 */

export const LICENSE_GROUPS = ['restricted', 'strong-copyleft', 'weak-copyleft', 'unknown', 'permissive'];

export const GROUP_LABELS = {
    'permissive': 'Permissive',
    'weak-copyleft': 'Weak copyleft',
    'strong-copyleft': 'Strong copyleft',
    'restricted': 'Restricted',
    'unknown': 'Unknown'
};

export const GROUP_HINTS = {
    'permissive': 'Usually only needs attribution and the license text.',
    'weak-copyleft': 'Review: changes to these files or libraries may need to be shared.',
    'strong-copyleft': 'Review: distributing a work that includes these may require releasing its source under the same license.',
    'restricted': 'Review: source-available or non-commercial terms may limit use.',
    'unknown': 'Check: no recognised license data.'
};

const PERMISSIVE = new Set([
    '0BSD', 'AFL-3.0', 'Apache-1.1', 'Apache-2.0', 'Artistic-2.0', 'BlueOak-1.0.0', 'BSD-1-Clause',
    'BSD-2-Clause', 'BSD-2-Clause-Patent', 'BSD-3-Clause', 'BSD-3-Clause-Clear', 'BSD-4-Clause',
    'BSL-1.0', 'CC-BY-3.0', 'CC-BY-4.0', 'CC0-1.0', 'curl', 'ECL-2.0', 'EFL-2.0', 'HPND', 'ICU',
    'IJG', 'ISC', 'libpng', 'libpng-2.0', 'MirOS', 'MIT', 'MIT-0', 'MIT-CMU', 'MulanPSL-2.0',
    'NCSA', 'OpenSSL', 'PostgreSQL', 'PSF-2.0', 'Python-2.0', 'Python-2.0.1', 'Ruby', 'Unicode-3.0',
    'Unicode-DFS-2015', 'Unicode-DFS-2016', 'Unlicense', 'UPL-1.0', 'W3C', 'W3C-20150513', 'WTFPL',
    'X11', 'Zlib', 'zlib-acknowledgement', 'ZPL-2.0', 'ZPL-2.1', 'BSD-Source-Code', 'AML', 'Beerware',
    'CNRI-Python', 'NTP', 'OLDAP-2.8', 'Info-ZIP', 'bzip2-1.0.6', 'FSFAP', 'FSFUL', 'FSFULLR', 'JSON-free'
]);
const WEAK = new Set([
    'CDDL-1.0', 'CDDL-1.1', 'CECILL-C', 'CPL-1.0', 'EPL-1.0', 'EPL-2.0', 'ErlPL-1.1', 'IPL-1.0',
    'LGPL-2.0', 'LGPL-2.1', 'LGPL-3.0', 'LGPLLR', 'MPL-1.0', 'MPL-1.1', 'MPL-2.0',
    'MPL-2.0-no-copyleft-exception', 'MS-RL', 'OFL-1.0', 'OFL-1.1', 'Artistic-1.0', 'Artistic-1.0-Perl',
    'CECILL-B', 'APSL-2.0', 'SPL-1.0', 'NPL-1.1'
]);
const STRONG = new Set([
    'AGPL-1.0', 'AGPL-3.0', 'CC-BY-SA-3.0', 'CC-BY-SA-4.0', 'CECILL-2.0', 'CECILL-2.1', 'EUPL-1.0',
    'EUPL-1.1', 'EUPL-1.2', 'GPL-1.0', 'GPL-2.0', 'GPL-3.0', 'ODbL-1.0', 'OSL-1.0', 'OSL-2.0',
    'OSL-2.1', 'OSL-3.0', 'RPL-1.1', 'RPL-1.5', 'Sleepycat', 'QPL-1.0', 'CC-BY-SA-2.0', 'CC-BY-SA-2.5'
]);
const RESTRICTED = new Set(['BUSL-1.1', 'Elastic-2.0', 'SSPL-1.0', 'JSON', 'Commons-Clause', 'CC-BY-NC-4.0', 'CC-BY-ND-4.0', 'Parity-7.0.0']);
const RESTRICTED_PREFIXES = ['CC-BY-NC', 'CC-BY-ND', 'PolyForm-', 'BUSL', 'SSPL', 'Elastic-'];
// Exceptions that allow linking without the copyleft reaching the linking program.
const LINKING_EXCEPTIONS = new Set([
    'Classpath-exception-2.0', 'GCC-exception-2.0', 'GCC-exception-3.1', 'LLVM-exception',
    'Autoconf-exception-2.0', 'Autoconf-exception-3.0', 'Bison-exception-2.2', 'Font-exception-2.0',
    'OpenJDK-assembly-exception-1.0', 'Linux-syscall-note', 'Libtool-exception', 'LGPL-3.0-linking-exception',
    'Universal-FOSS-exception-1.0', 'WxWindows-exception-3.1', 'mif-exception', 'freertos-exception-2.0'
]);
// Licenses whose obligations can be triggered by offering the software over a network.
const NETWORK = /^(AGPL|SSPL|OSL|RPL)-/;

const RANK = { 'permissive': 0, 'weak-copyleft': 1, 'strong-copyleft': 2, 'restricted': 3, 'unknown': 4 };
// For OR: a known option is preferable to an unknown one.
const OR_RANK = { 'permissive': 0, 'weak-copyleft': 1, 'strong-copyleft': 2, 'restricted': 3, 'unknown': 5 };

// Common non-SPDX names found in package metadata.
const ALIASES = {
    'APACHE 2.0': 'Apache-2.0', 'APACHE-2': 'Apache-2.0', 'APACHE 2': 'Apache-2.0', 'APACHE LICENSE 2.0': 'Apache-2.0',
    'APACHE SOFTWARE LICENSE': 'Apache-2.0', 'APACHE LICENSE, VERSION 2.0': 'Apache-2.0', 'ASL 2.0': 'Apache-2.0',
    'BSD': 'BSD-3-Clause', 'NEW BSD': 'BSD-3-Clause', 'BSD LICENSE': 'BSD-3-Clause', '3-CLAUSE BSD': 'BSD-3-Clause',
    'SIMPLIFIED BSD': 'BSD-2-Clause', '2-CLAUSE BSD': 'BSD-2-Clause', 'MIT LICENSE': 'MIT', 'THE MIT LICENSE': 'MIT', 'EXPAT': 'MIT',
    'GPL': 'GPL-2.0-or-later', 'GPLV2': 'GPL-2.0-only', 'GPLV3': 'GPL-3.0-only', 'LGPL': 'LGPL-2.1-or-later',
    'LGPLV2': 'LGPL-2.1-only', 'LGPLV3': 'LGPL-3.0-only', 'MPL 2.0': 'MPL-2.0', 'PUBLIC DOMAIN': 'Unlicense',
    'PSF': 'PSF-2.0', 'PSFL': 'PSF-2.0', 'PYTHON SOFTWARE FOUNDATION LICENSE': 'PSF-2.0', 'ISC LICENSE': 'ISC'
};

/** Splits an ID like "GPL-2.0-or-later" into its base ID and variant. */
function baseId(id) {
    const m = /^(.*?)(-only|-or-later|\+)?$/.exec(id);
    return { base: m[1], variant: m[2] === '+' ? '-or-later' : (m[2] || '') };
}

function classifyId(rawId) {
    const id = String(rawId || '').trim();
    if (!id || id === 'NOASSERTION' || id === 'NONE' || /^(Licen[cs]eRef|DocumentRef)-/i.test(id)) return 'unknown';
    const alias = ALIASES[id.toUpperCase()];
    const { base } = baseId(alias || id);
    if (PERMISSIVE.has(base)) return 'permissive';
    if (WEAK.has(base)) return 'weak-copyleft';
    if (STRONG.has(base)) return 'strong-copyleft';
    if (RESTRICTED.has(base) || RESTRICTED_PREFIXES.some(p => base.startsWith(p))) return 'restricted';
    // Case-insensitive retry for loosely written IDs (e.g. "mit", "apache-2.0").
    const lower = base.toLowerCase();
    for (const [set, group] of [[PERMISSIVE, 'permissive'], [WEAK, 'weak-copyleft'], [STRONG, 'strong-copyleft'], [RESTRICTED, 'restricted']]) {
        for (const k of set) if (k.toLowerCase() === lower) return group;
    }
    return 'unknown';
}

function tokenize(expr) {
    return String(expr).replace(/\(/g, ' ( ').replace(/\)/g, ' ) ').trim().split(/\s+/).filter(Boolean);
}

/** Parses an SPDX expression into a small tree. Falls back to a single ID if it does not parse. */
export function parseSpdx(expr) {
    const tokens = tokenize(expr);
    let i = 0;
    const peek = () => tokens[i];
    const isOp = (t, op) => t && t.toUpperCase() === op;

    function primary() {
        const t = tokens[i++];
        if (t === undefined) throw new Error('unexpected end');
        if (t === '(') {
            const node = orExpr();
            if (tokens[i++] !== ')') throw new Error('missing )');
            return node;
        }
        let node = { id: t };
        if (isOp(peek(), 'WITH')) {
            i++;
            const exc = tokens[i++];
            if (!exc) throw new Error('missing exception');
            node = { id: t, exception: exc };
        }
        return node;
    }
    function andExpr() {
        let node = primary();
        while (isOp(peek(), 'AND')) { i++; node = { op: 'AND', left: node, right: primary() }; }
        return node;
    }
    function orExpr() {
        let node = andExpr();
        while (isOp(peek(), 'OR')) { i++; node = { op: 'OR', left: node, right: andExpr() }; }
        return node;
    }
    try {
        if (tokens.length === 0) return { id: '' };
        const tree = orExpr();
        if (i !== tokens.length) throw new Error('trailing tokens');
        return tree;
    } catch (_) {
        return { id: String(expr).trim() };
    }
}

/** Returns { group, notes } for a parsed expression; for OR, only the chosen option's notes count. */
function evaluate(node) {
    if (node.op) {
        const a = evaluate(node.left);
        const b = evaluate(node.right);
        if (node.op === 'AND') {
            return { group: RANK[a.group] >= RANK[b.group] ? a.group : b.group, notes: [...a.notes, ...b.notes] };
        }
        // OR: the licensee may choose the easier option.
        return OR_RANK[a.group] <= OR_RANK[b.group] ? a : b;
    }
    const notes = [];
    let group = classifyId(node.id);
    const { variant } = baseId(ALIASES[String(node.id).toUpperCase()] || node.id);
    if (node.exception && group === 'strong-copyleft' && LINKING_EXCEPTIONS.has(node.exception)) {
        group = 'weak-copyleft';
        notes.push(`${node.exception} limits the copyleft for linked code`);
    }
    if (NETWORK.test(node.id)) notes.push(`${node.id} has obligations for software offered over a network`);
    if (variant === '-or-later' && group !== 'permissive') notes.push(`${node.id} allows later versions of the license`);
    return { group, notes };
}

/**
 * Classifies one package's license data.
 * @param {string|string[]} licenses SPDX expression(s); several entries are combined with AND.
 * @returns {{ expression: string, group: string, notes: string[] }}
 */
export function classifyLicense(licenses) {
    const list = (Array.isArray(licenses) ? licenses : [licenses]).map(l => String(l || '').trim()).filter(Boolean);
    if (list.length === 0) return { expression: '', group: 'unknown', notes: [] };
    const expression = list.length === 1 ? list[0] : list.map(l => (/\s(OR|AND)\s/i.test(l) ? `(${l})` : l)).join(' AND ');
    const { group, notes } = evaluate(parseSpdx(expression));
    return { expression, group, notes: [...new Set(notes)] };
}

/** Best-effort repository license from a LICENSE file's opening text (zip sources only). */
export function guessLicenseFromText(text) {
    const t = String(text).slice(0, 2000);
    const rules = [
        [/GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3/i, 'AGPL-3.0'],
        [/GNU LESSER GENERAL PUBLIC LICENSE\s+Version 3/i, 'LGPL-3.0'],
        [/GNU LESSER GENERAL PUBLIC LICENSE\s+Version 2\.1/i, 'LGPL-2.1'],
        [/GNU GENERAL PUBLIC LICENSE\s+Version 3/i, 'GPL-3.0'],
        [/GNU GENERAL PUBLIC LICENSE\s+Version 2/i, 'GPL-2.0'],
        [/Mozilla Public License,? (Version|v\.?) 2\.0/i, 'MPL-2.0'],
        [/Apache License,?\s+Version 2\.0/i, 'Apache-2.0'],
        [/Permission is hereby granted, free of charge/i, 'MIT'],
        [/Redistribution and use in source and binary forms/i, /Neither the name/i.test(t) ? 'BSD-3-Clause' : 'BSD-2-Clause'],
        [/Permission to use, copy, modify, and\/or distribute this software/i, 'ISC'],
        [/This is free and unencumbered software released into the public domain/i, 'Unlicense']
    ];
    for (const [re, id] of rules) if (re.test(t)) return classifyLicense(id);
    return null;
}
