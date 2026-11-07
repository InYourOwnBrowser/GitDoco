/**
 * Comparing dependencies between two refs (branches, tags, commits) or a pull request: what was
 * added, removed or changed version, and which advisories and policy findings are new.
 */
import { isSafeBranchName } from './github-api.js';

/**
 * Parses the "Compare with" field.
 * @returns {{ kind: 'pr', number: number } | { kind: 'ref', ref: string } | { error: string } | null}
 *   null for an empty field.
 */
export function parseCompareInput(text, repo = null) {
    const t = String(text || '').trim();
    if (!t) return null;
    let m = /^(?:#|pr\s*#?|pull\/)?(\d{1,7})$/i.exec(t);
    if (m) return { kind: 'pr', number: Number(m[1]) };
    m = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/pull\/(\d{1,7})(?:[/?#].*)?$/i.exec(t);
    if (m) {
        if (repo && (m[1].toLowerCase() !== repo.owner.toLowerCase() || m[2].toLowerCase() !== repo.repo.toLowerCase())) {
            return { error: `That pull request belongs to ${m[1]}/${m[2]}, not ${repo.owner}/${repo.repo}.` };
        }
        return { kind: 'pr', number: Number(m[3]) };
    }
    m = /^https?:\/\/(?:www\.)?github\.com\/[^/]+\/[^/]+\/(?:tree|commit)\/(.+)$/i.exec(t);
    const ref = m ? decodeURIComponent(m[1]).replace(/\/$/, '') : t;
    if (/^[0-9a-f]{7,40}$/i.test(ref) || isSafeBranchName(ref)) return { kind: 'ref', ref };
    return { error: 'Enter a branch, tag, commit SHA, or pull request (#123 or its URL).' };
}

const keyOf = p => `${p.ecosystem}|${p.name}`;

function versionsByName(packages) {
    const map = new Map();
    for (const p of packages) {
        if (!map.has(keyOf(p))) map.set(keyOf(p), []);
        map.get(keyOf(p)).push(p);
    }
    return map;
}

const versionList = list => [...new Set(list.map(p => p.version || '?'))].sort();

/**
 * Differences between base and head package lists (by ecosystem + name; a package present in
 * both with different versions is "updated"). Marks each head package with `change`.
 * @returns {{ added: object[], updated: {pkg, from: string[], to: string[]}[], removed: object[],
 *   newAdvisories: {pkg, id}[], newPolicyFindings: object[] }}
 */
export function diffPackages(basePackages, headPackages) {
    const base = versionsByName(basePackages);
    const head = versionsByName(headPackages);
    const added = [];
    const updated = [];
    const removed = [];
    for (const [key, list] of head) {
        const before = base.get(key);
        if (!before) {
            for (const p of list) { p.change = 'added'; added.push(p); }
            continue;
        }
        const from = versionList(before);
        const to = versionList(list);
        if (from.join(',') !== to.join(',')) {
            // Only the versions the base didn't have are marked (debug 2.6.9 + 4.3.4 -> 4.3.4 + 4.4.0 marks 4.4.0).
            for (const p of list) {
                if (from.includes(p.version || '?')) { p.change = null; continue; }
                p.change = 'updated';
                p.changedFrom = from;
            }
            updated.push({ pkg: list[0], from, to });
        } else {
            for (const p of list) p.change = null;
        }
    }
    for (const [key, list] of base) if (!head.has(key)) removed.push(...list);

    const baseAdvisories = new Map([...base].map(([k, list]) => [k, new Set(list.flatMap(p => p.advisories || []))]));
    const newAdvisories = [];
    for (const p of headPackages) {
        const before = baseAdvisories.get(keyOf(p)) || new Set();
        for (const id of p.advisories || []) if (!before.has(id)) newAdvisories.push({ pkg: p, id });
    }

    const basePolicy = new Map(basePackages.map(p => [keyOf(p), p.policy ? p.policy.verdict : 'allow']));
    const rank = { allow: 0, review: 1, block: 2 };
    const newPolicyFindings = headPackages.filter(p => p.policy && p.policy.verdict !== 'allow'
        && rank[p.policy.verdict] > rank[basePolicy.get(keyOf(p)) || 'allow']);

    const sortByName = (a, b) => a.name.localeCompare(b.name);
    return {
        added: added.sort(sortByName),
        updated: updated.sort((a, b) => sortByName(a.pkg, b.pkg)),
        removed: removed.sort(sortByName),
        newAdvisories,
        newPolicyFindings: newPolicyFindings.sort(sortByName)
    };
}

export function summarizeDiff(diff) {
    return `${diff.added.length} added, ${diff.updated.length} updated, ${diff.removed.length} removed; `
        + `${diff.newAdvisories.length} new advisor${diff.newAdvisories.length === 1 ? 'y' : 'ies'}; `
        + `${diff.newPolicyFindings.length} new policy finding${diff.newPolicyFindings.length === 1 ? '' : 's'}`;
}

