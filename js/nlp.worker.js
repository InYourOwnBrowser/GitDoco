/**
 * Background Web Worker for Deterministic Issue NLP:
 * 1. GitHub/Markdown boilerplate removal & technical tokenization
 * 2. Bigram & Trigram extraction
 * 3. TF-IDF + Spherical K-Means Topic Clustering
 * 4. Near-Duplicate Issue Detection via Cosine Similarity
 */

import { cleanAndTokenize } from './nlp-text.js';

function extractTopNGrams(docsTokens, totalDocs, topLimit = 14) {
    const ngramDocMap = new Map();

    for (const doc of docsTokens) {
        const seenInDoc = new Set();
        const toks = doc.tokens;
        for (let i = 0; i < toks.length - 1; i++) {
            const w1 = toks[i];
            const w2 = toks[i + 1];
            if (w1 === w2) continue;
            const bigram = `${w1} ${w2}`;
            seenInDoc.add(bigram);

            if (i < toks.length - 2) {
                const w3 = toks[i + 2];
                if (w2 !== w3 && w1 !== w3) {
                    seenInDoc.add(`${w1} ${w2} ${w3}`);
                }
            }
        }
        for (const ng of seenInDoc) {
            if (!ngramDocMap.has(ng)) ngramDocMap.set(ng, []);
            ngramDocMap.get(ng).push(doc.number);
        }
    }

    const minSupport = totalDocs >= 30 ? 3 : 2;
    const candidates = [];
    for (const [phrase, issueNums] of ngramDocMap.entries()) {
        if (issueNums.length >= minSupport) {
            const wordCount = phrase.split(' ').length;
            const score = issueNums.length * (wordCount === 3 ? 1.15 : 1.0);
            candidates.push({ phrase, count: issueNums.length, issueNumbers: issueNums, score });
        }
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, topLimit);
}

function clusterIssuesAndDuplicates(docsTokens) {
    const N = docsTokens.length;
    if (N < 4) {
        return { clusters: [], similarMap: {} };
    }

    const tf = new Map();
    const df = new Map();
    for (const doc of docsTokens) {
        const docTf = new Map();
        for (const t of doc.tokens) {
            docTf.set(t, (docTf.get(t) || 0) + 1);
        }
        for (const [t, count] of docTf.entries()) {
            df.set(t, (df.get(t) || 0) + 1);
            tf.set(t, (tf.get(t) || 0) + count);
        }
    }

    const minDf = N >= 20 ? 2 : 1;
    const maxDf = Math.max(2, Math.floor(N * 0.75));

    const termScores = [];
    for (const [t, count] of df.entries()) {
        if (count >= minDf && count <= maxDf) {
            const idfVal = Math.log(1 + N / count);
            const score = (tf.get(t) || 1) * idfVal;
            termScores.push({ term: t, score });
        }
    }

    termScores.sort((a, b) => b.score - a.score);
    const vocabList = termScores.slice(0, 1000).map(s => s.term);

    if (vocabList.length < 3) {
        return { clusters: [], similarMap: {} };
    }

    const vocabIndex = new Map(vocabList.map((t, i) => [t, i]));
    const V = vocabList.length;
    const idf = new Float32Array(V);
    for (let j = 0; j < V; j++) {
        idf[j] = Math.log(1 + N / (df.get(vocabList[j]) || 1));
    }

    const vectors = new Array(N);
    const nonZeroDocIndices = [];

    for (let i = 0; i < N; i++) {
        const vec = new Float32Array(V);
        const toks = docsTokens[i].tokens;
        for (const t of toks) {
            const idx = vocabIndex.get(t);
            if (idx !== undefined) vec[idx] += 1;
        }
        let norm = 0;
        for (let j = 0; j < V; j++) {
            if (vec[j] > 0) {
                vec[j] = (1 + Math.log(vec[j])) * idf[j];
                norm += vec[j] * vec[j];
            }
        }
        norm = Math.sqrt(norm);
        if (norm > 0) {
            for (let j = 0; j < V; j++) vec[j] /= norm;
            nonZeroDocIndices.push(i);
        }
        vectors[i] = vec;
    }

    if (nonZeroDocIndices.length < 3) {
        return { clusters: [], similarMap: {} };
    }

    const similarMap = {};
    for (const i of nonZeroDocIndices) {
        const sims = [];
        const vA = vectors[i];
        for (const j of nonZeroDocIndices) {
            if (i === j) continue;
            const vB = vectors[j];
            let dot = 0;
            for (let k = 0; k < V; k++) dot += vA[k] * vB[k];
            if (dot >= 0.52) {
                sims.push({ number: docsTokens[j].number, score: dot });
            }
        }
        if (sims.length > 0) {
            sims.sort((a, b) => b.score - a.score);
            similarMap[docsTokens[i].number] = sims.slice(0, 5).map(s => s.number);
        }
    }

    const K = Math.min(8, Math.max(3, Math.round(Math.sqrt(nonZeroDocIndices.length / 3))));
    const centroids = [];

    let firstIdx = nonZeroDocIndices[0];
    centroids.push(new Float32Array(vectors[firstIdx]));

    for (let c = 1; c < K; c++) {
        let bestIdx = nonZeroDocIndices[0];
        let minMaxSim = Infinity;
        for (const i of nonZeroDocIndices) {
            let maxSimToExisting = -1;
            for (const cent of centroids) {
                let dot = 0;
                for (let k = 0; k < V; k++) dot += vectors[i][k] * cent[k];
                if (dot > maxSimToExisting) maxSimToExisting = dot;
            }
            if (maxSimToExisting < minMaxSim) {
                minMaxSim = maxSimToExisting;
                bestIdx = i;
            }
        }
        centroids.push(new Float32Array(vectors[bestIdx]));
    }

    const nonZeroSet = new Set(nonZeroDocIndices);
    const assignments = new Int32Array(N).fill(-1);

    for (let iter = 0; iter < 12; iter++) {
        for (let i = 0; i < N; i++) {
            if (!nonZeroSet.has(i)) {
                assignments[i] = -1;
                continue;
            }
            let bestCluster = 0;
            let bestSim = -1;
            for (let c = 0; c < K; c++) {
                let dot = 0;
                for (let k = 0; k < V; k++) dot += vectors[i][k] * centroids[c][k];
                if (dot > bestSim) {
                    bestSim = dot;
                    bestCluster = c;
                }
            }
            assignments[i] = bestCluster;
        }

        for (let c = 0; c < K; c++) {
            const nextCent = new Float32Array(V);
            let count = 0;
            for (let i = 0; i < N; i++) {
                if (assignments[i] === c) {
                    count++;
                    for (let k = 0; k < V; k++) nextCent[k] += vectors[i][k];
                }
            }
            if (count > 0) {
                let norm = 0;
                for (let k = 0; k < V; k++) norm += nextCent[k] * nextCent[k];
                norm = Math.sqrt(norm);
                if (norm > 0) {
                    for (let k = 0; k < V; k++) nextCent[k] /= norm;
                }
                centroids[c] = nextCent;
            }
        }
    }

    const clusters = [];
    for (let c = 0; c < K; c++) {
        const memberNumbers = [];
        for (let i = 0; i < N; i++) {
            if (assignments[i] === c) memberNumbers.push(docsTokens[i].number);
        }
        if (memberNumbers.length < 2) continue;

        const termWeights = [];
        for (let k = 0; k < V; k++) {
            if (centroids[c][k] > 0) {
                termWeights.push({ term: vocabList[k], w: centroids[c][k] });
            }
        }
        termWeights.sort((a, b) => b.w - a.w);
        const topTerms = termWeights.slice(0, 3).map(t => t.term);
        if (topTerms.length === 0) continue;

        clusters.push({
            id: `cluster_${c}`,
            label: topTerms.join(' / '),
            terms: topTerms,
            count: memberNumbers.length,
            issueNumbers: memberNumbers
        });
    }

    clusters.sort((a, b) => b.count - a.count);
    return { clusters, similarMap };
}

function handleNlpRequest(data) {
    const { id, issues } = data || {};
    if (!Array.isArray(issues) || issues.length === 0) {
        return { id, clusters: [], ngrams: [], similarMap: {} };
    }

    const docsTokens = issues.map(iss => ({
        number: iss.number,
        tokens: cleanAndTokenize(iss.title, iss.body)
    }));

    const ngrams = extractTopNGrams(docsTokens, issues.length, 14);
    const { clusters, similarMap } = clusterIssuesAndDuplicates(docsTokens);

    return { id, clusters, ngrams, similarMap };
}

if (typeof self !== 'undefined') {
    self.onmessage = function (e) {
        self.postMessage(handleNlpRequest(e.data));
    };
} else if (typeof globalThis !== 'undefined') {
    globalThis.self = globalThis;
    globalThis.onmessage = function (e) {
        if (globalThis.postMessage) globalThis.postMessage(handleNlpRequest(e.data));
    };
}

if (typeof process !== 'undefined' && process.versions && process.versions.node) {
    import('node:worker_threads').then(({ parentPort }) => {
        if (parentPort) {
            parentPort.on('message', (data) => {
                parentPort.postMessage(handleNlpRequest(data));
            });
        }
    }).catch(() => {});
}
