export const DEFAULT_EXCLUDED_DIRS = [
    'test',
    'tests',
    '__tests__',
    'spec',
    'e2e',
    'docs',
    'doc',
    'examples',
    'example',
    'fixtures',
    'benchmarks'
];

const DEFAULT_EXCLUDED_SET = new Set(DEFAULT_EXCLUDED_DIRS.map(d => d.toLowerCase()));

/**
 * paths: string[] of file paths.
 * Returns { excluded: string[] (file paths), folders: string[] (matched dir prefixes) }.
 * A file is excluded when any DIRECTORY segment (not the file name) lowercased is in DEFAULT_EXCLUDED_DIRS.
 */
export function defaultExcludedPaths(paths) {
    if (!Array.isArray(paths)) {
        return { excluded: [], folders: [] };
    }

    const excluded = [];
    const folders = [];
    const folderSet = new Set();

    for (const path of paths) {
        if (typeof path !== 'string') continue;
        const parts = path.split('/');
        const dirSegments = parts.slice(0, -1);
        if (dirSegments.length === 0) continue;

        let matchedPrefix = null;
        for (let i = 0; i < dirSegments.length; i++) {
            if (DEFAULT_EXCLUDED_SET.has(dirSegments[i].toLowerCase())) {
                matchedPrefix = dirSegments.slice(0, i + 1).join('/');
                break;
            }
        }

        if (matchedPrefix !== null) {
            excluded.push(path);
            if (!folderSet.has(matchedPrefix)) {
                folderSet.add(matchedPrefix);
                folders.push(matchedPrefix);
            }
        }
    }

    return { excluded, folders };
}

/**
 * files: [{ path, tokens }]. Group by the first two path segments (or one if the file is in a top-level folder).
 * Return up to `limit` groups sorted by tokens desc, each { path, tokens, share }, keeping only share >= minShare.
 */
export function rankSuggestions(files, limit = 3, minShare = 0.05) {
    if (!Array.isArray(files) || files.length === 0) {
        return [];
    }

    let totalTokens = 0;
    for (const file of files) {
        totalTokens += (file && file.tokens) || 0;
    }

    if (totalTokens <= 0) {
        return [];
    }

    const groups = new Map();

    for (const file of files) {
        if (!file || !file.path) continue;
        const parts = file.path.split('/');
        let prefix;
        if (parts.length <= 2) {
            prefix = parts[0];
        } else {
            prefix = parts.slice(0, 2).join('/');
        }
        const tokens = file.tokens || 0;
        groups.set(prefix, (groups.get(prefix) || 0) + tokens);
    }

    const results = [];
    for (const [path, tokens] of groups.entries()) {
        const share = tokens / totalTokens;
        if (share >= minShare) {
            results.push({ path, tokens, share });
        }
    }

    results.sort((a, b) => b.tokens - a.tokens);

    return results.slice(0, limit);
}
