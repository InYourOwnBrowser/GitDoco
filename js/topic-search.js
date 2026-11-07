/**
 * "Your own topic": finds the threads (issues or discussions) about a topic the user types.
 *
 * 1. Direct matches: threads whose title or body contain every word of the query (word variants
 *    count: "leak" matches "leaks", "leaking", "leakage") and every "quoted phrase" exactly.
 * 2. Related threads: threads whose wording is close to the direct matches (TF-IDF cosine
 *    similarity to their centroid), even if they never use the query words, e.g. "OOM" or
 *    "heap keeps growing" for a "memory leak" query.
 *
 * Runs on the main thread; a few hundred threads take a few milliseconds.
 */
import { cleanAndTokenize } from './nlp-text.js';

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Light stemmer so word variants share a stem ("leaks", "leaking" -> "leak"). */
export function stem(word) {
    let w = String(word).toLowerCase();
    if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
    else if (w.length > 4 && w.endsWith('ied')) w = w.slice(0, -3) + 'y';
    else if (w.length > 4 && w.endsWith('ies')) w = w.slice(0, -3) + 'y';
    else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
    else if (w.length > 4 && w.endsWith('es') && !w.endsWith('ses')) w = w.slice(0, -2);
    else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
    return w;
}

/** Splits a query into exact "phrases" and words (stemmed). */
export function parseTopicQuery(query) {
    const phrases = [];
    const rest = String(query || '').replace(/"([^"]+)"/g, (_, p) => { if (p.trim()) phrases.push(p.trim().toLowerCase()); return ' '; });
    const words = (rest.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_.+#-]*/gu) || [])
        .filter(w => w.length >= 2)
        .map(stem);
    return { phrases, words: [...new Set(words)] };
}

const docText = d => `${d.title || ''}\n${d.body || ''}`.toLowerCase();

/**
 * @param {Array<{number:number,title:string,body:string}>} docs
 * @param {string} query
 * @param {{ relatedThreshold?: number, maxRelated?: number }} [opts]
 * @returns {{ query: string, terms: string[], matches: number[], related: number[], scores: Map<number, number> } | null}
 *   null when the query has no usable words.
 */
export function searchTopic(docs, query, opts = {}) {
    const { relatedThreshold = 0.18, maxRelated = 50 } = opts;
    const { phrases, words } = parseTopicQuery(query);
    if (phrases.length === 0 && words.length === 0) return null;

    const texts = docs.map(docText);
    // A word matches at a word start, so "leak" matches "leaks" but not "bleak".
    const wordRes = words.map(w => new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRe(w)}`, 'gu'));
    const N = docs.length || 1;
    const df = wordRes.map(re => texts.reduce((n, t) => n + (t.search(re) >= 0 ? 1 : 0), 0));
    const idf = df.map(d => Math.log(1 + N / Math.max(1, d)));

    const scores = new Map();
    const matches = [];
    docs.forEach((d, i) => {
        const t = texts[i];
        if (!phrases.every(p => t.includes(p))) return;
        let score = phrases.length * 2;
        for (let k = 0; k < wordRes.length; k++) {
            const count = (t.match(wordRes[k]) || []).length;
            if (count === 0) return; // every word must appear
            score += (1 + Math.log(count)) * idf[k];
        }
        // Title hits count double.
        const title = (d.title || '').toLowerCase();
        for (const re of wordRes) if (title.search(re) >= 0) score += 1;
        for (const p of phrases) if (title.includes(p)) score += 2;
        scores.set(d.number, score);
        matches.push(d.number);
    });
    matches.sort((a, b) => scores.get(b) - scores.get(a));

    const related = findRelated(docs, new Set(matches), { relatedThreshold, maxRelated, scores });
    return { query: String(query).trim(), terms: [...phrases.map(p => `"${p}"`), ...words], matches, related, scores };
}

/** Threads similar to the matched ones (cosine similarity to the centroid of their TF-IDF vectors). */
function findRelated(docs, matched, { relatedThreshold, maxRelated, scores }) {
    if (matched.size === 0 || docs.length < 4) return [];
    const tokenLists = docs.map(d => cleanAndTokenize(d.title, d.body).map(stem));
    const df = new Map();
    for (const toks of tokenLists) for (const t of new Set(toks)) df.set(t, (df.get(t) || 0) + 1);
    const N = docs.length;
    const maxDf = Math.max(2, Math.floor(N * 0.5));
    const vectors = tokenLists.map(toks => {
        const tf = new Map();
        for (const t of toks) {
            const n = df.get(t);
            if (n >= 1 && n <= maxDf) tf.set(t, (tf.get(t) || 0) + 1);
        }
        let norm = 0;
        for (const [t, c] of tf) {
            const w = (1 + Math.log(c)) * Math.log(1 + N / df.get(t));
            tf.set(t, w);
            norm += w * w;
        }
        norm = Math.sqrt(norm) || 1;
        for (const [t, w] of tf) tf.set(t, w / norm);
        return tf;
    });

    // Centroid of the strongest direct matches.
    const top = [...matched].sort((a, b) => scores.get(b) - scores.get(a)).slice(0, 25);
    const index = new Map(docs.map((d, i) => [d.number, i]));
    const centroid = new Map();
    for (const num of top) for (const [t, w] of vectors[index.get(num)]) centroid.set(t, (centroid.get(t) || 0) + w / top.length);
    let cNorm = 0;
    for (const w of centroid.values()) cNorm += w * w;
    cNorm = Math.sqrt(cNorm) || 1;

    const related = [];
    docs.forEach((d, i) => {
        if (matched.has(d.number)) return;
        let dot = 0;
        for (const [t, w] of vectors[i]) {
            const c = centroid.get(t);
            if (c) dot += w * c;
        }
        const sim = dot / cNorm;
        if (sim >= relatedThreshold) related.push({ number: d.number, sim });
    });
    related.sort((a, b) => b.sim - a.sim);
    for (const r of related) scores.set(r.number, r.sim);
    return related.slice(0, maxRelated).map(r => r.number);
}
