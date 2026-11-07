/**
 * License policy: turns license groups into decisions a team can act on.
 *
 *   allow  - no action needed
 *   review - someone should look at it
 *   block  - not acceptable without an exception
 *
 * A policy sets an action per license group, plus licenses that are always blocked or always
 * allowed, and packages that are approved whatever their license. It can be saved in the
 * browser or committed to a repository as `.gitdoco-policy.json`.
 *
 * This applies the rules a team chooses; it is not legal advice.
 */
import { parseSpdx, classifyLicense, LICENSE_GROUPS, GROUP_LABELS } from './license-classify.js';

export const POLICY_FILE = '.gitdoco-policy.json';
export const ACTIONS = ['allow', 'review', 'block'];
const RANK = { allow: 0, review: 1, block: 2 };

export const DEFAULT_POLICY = Object.freeze({
    version: 1,
    groups: Object.freeze({ 'permissive': 'allow', 'weak-copyleft': 'review', 'strong-copyleft': 'review', 'restricted': 'block', 'unknown': 'review' }),
    blockLicenses: Object.freeze([]),
    allowLicenses: Object.freeze([]),
    allowPackages: Object.freeze([])
});

const cleanList = v => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\n]/) : [])
    .map(x => String(x).trim()).filter(x => x && x.length <= 200).slice(0, 500);

/** Validates a policy object (e.g. parsed from .gitdoco-policy.json); unknown keys are ignored. */
export function normalizePolicy(input) {
    const src = input && typeof input === 'object' ? input : {};
    const groups = {};
    for (const g of LICENSE_GROUPS) {
        const a = src.groups && typeof src.groups[g] === 'string' ? src.groups[g].toLowerCase() : null;
        groups[g] = ACTIONS.includes(a) ? a : DEFAULT_POLICY.groups[g];
    }
    return {
        version: 1,
        groups,
        blockLicenses: cleanList(src.blockLicenses),
        allowLicenses: cleanList(src.allowLicenses),
        allowPackages: cleanList(src.allowPackages)
    };
}

/** Parses .gitdoco-policy.json text; throws a readable error for invalid JSON. */
export function parsePolicyFile(text) {
    let data;
    try { data = JSON.parse(text); } catch (err) { throw new Error(`${POLICY_FILE} is not valid JSON (${err.message})`); }
    return normalizePolicy(data);
}

/** The JSON a team can commit as .gitdoco-policy.json. */
export function policyToFile(policy) {
    const p = normalizePolicy(policy);
    return JSON.stringify({
        $comment: 'GitDoco license policy: actions are allow, review or block. See https://gitdoco.timedoco.com/deps.html',
        ...p
    }, null, 2) + '\n';
}

// "GPL-3.0" in a list matches GPL-3.0, GPL-3.0-only, GPL-3.0-or-later and GPL-3.0+.
const baseOf = id => String(id).trim().replace(/(-only|-or-later|\+)$/i, '').toLowerCase();
function inList(id, list) {
    const exact = String(id).trim().toLowerCase();
    const base = baseOf(id);
    return list.some(entry => {
        const e = String(entry).trim().toLowerCase();
        return e === exact || (!/(-only|-or-later|\+)$/.test(e) && e === base);
    });
}

function packageAllowed(pkg, list) {
    const name = String(pkg.name).toLowerCase();
    const qualified = `${pkg.ecosystem}:${pkg.name}`.toLowerCase();
    return list.some(e => {
        const x = e.toLowerCase();
        return x === name || x === qualified;
    });
}

function evalNode(node, policy) {
    if (node.op) {
        const a = evalNode(node.left, policy);
        const b = evalNode(node.right, policy);
        if (node.op === 'AND') return RANK[a.verdict] >= RANK[b.verdict] ? a : b;
        return RANK[a.verdict] <= RANK[b.verdict] ? a : b; // OR: the licensee may choose
    }
    const leaf = node.exception ? `${node.id} WITH ${node.exception}` : node.id;
    if (inList(node.id, policy.blockLicenses)) return { verdict: 'block', reason: `${leaf} is on the blocked list` };
    if (inList(node.id, policy.allowLicenses)) return { verdict: 'allow', reason: `${leaf} is on the allowed list` };
    const group = classifyLicense(leaf).group;
    return { verdict: policy.groups[group], reason: `${GROUP_LABELS[group]} license (${leaf || 'none found'})`, group };
}

/**
 * Decides allow / review / block for one package.
 * @returns {{ verdict: 'allow'|'review'|'block', reason: string }}
 */
export function evaluatePolicy(pkg, policyInput) {
    const policy = normalizePolicy(policyInput);
    if (packageAllowed(pkg, policy.allowPackages)) return { verdict: 'allow', reason: 'package is on the approved list' };
    if (pkg.status === 'not-checked') return { verdict: 'review', reason: 'license not checked yet (deps.dev lookup limit)' };
    const expr = pkg.license && pkg.license.expression ? pkg.license.expression : '';
    if (!expr) {
        const v = policy.groups.unknown;
        return { verdict: v, reason: 'no license data' };
    }
    const result = evalNode(parseSpdx(expr), policy);
    return { verdict: result.verdict, reason: result.reason };
}

/** A one-line description of the policy for reports. */
export function describePolicy(policyInput, source = '') {
    const p = normalizePolicy(policyInput);
    const byAction = a => LICENSE_GROUPS.filter(g => p.groups[g] === a).map(g => GROUP_LABELS[g].toLowerCase());
    const parts = [];
    for (const a of ['block', 'review', 'allow']) {
        const gs = byAction(a);
        if (gs.length) parts.push(`${a}: ${gs.join(', ')}`);
    }
    if (p.blockLicenses.length) parts.push(`always blocked: ${p.blockLicenses.join(', ')}`);
    if (p.allowLicenses.length) parts.push(`always allowed: ${p.allowLicenses.join(', ')}`);
    if (p.allowPackages.length) parts.push(`approved packages: ${p.allowPackages.join(', ')}`);
    return `${source ? `${source}. ` : ''}${parts.join('; ')}`;
}
