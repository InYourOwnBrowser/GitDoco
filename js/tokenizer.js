/**
 * Client-Side BPE Token Estimator
 * Calibrated against Tiktoken (cl100k_base / o200k_base) and Anthropic Claude Tokenizer
 */
let worker = null;
let msgId = 0;
const callbacks = new Map();

export function estimateTokensAsync(text) {
    return new Promise((resolve) => {
        if (typeof Worker === 'undefined') {
            resolve(estimateTokens(text));
            return;
        }
        if (!worker) {
            try {
                worker = new Worker(new URL('./tokenizer.worker.js', import.meta.url), { type: 'module' });
                worker.onmessage = (e) => {
                    const { id, tokens } = e.data;
                    const req = callbacks.get(id);
                    if (req) {
                        req.resolve(tokens);
                        callbacks.delete(id);
                    }
                };
                worker.onerror = () => {
                    for (const [, req] of callbacks.entries()) {
                        req.resolve(estimateTokens(req.text));
                    }
                    callbacks.clear();
                    if (worker) {
                        worker.terminate();
                        worker = null;
                    }
                };
            } catch (_) {
                resolve(estimateTokens(text));
                return;
            }
        }
        const currentId = ++msgId;
        callbacks.set(currentId, { resolve, text });
        try {
            worker.postMessage({ id: currentId, text });
        } catch (_) {
            callbacks.delete(currentId);
            resolve(estimateTokens(text));
        }
    });
}

export function estimateTokens(text) {
    if (!text) return 0;

    // BPE regex pattern capturing word chunks, numbers, punctuation blocks, and whitespace runs
    const tokenRegex = /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;
    const matches = text.match(tokenRegex);
    if (!matches) return Math.ceil(text.length / 3.3);

    let tokenCount = 0;
    for (let i = 0; i < matches.length; i++) {
        const m = matches[i];
        if (m.length <= 4) {
            tokenCount += 1;
        } else if (/^\s+$/.test(m)) {
            // In source code, indentation blocks cost ~1 token per 4 spaces or single tab
            tokenCount += Math.ceil(m.length / 4);
        } else {
            // Complex identifiers (camelCase, snake_case, hashes)
            tokenCount += Math.ceil(m.length / 3.4);
        }
    }
    return tokenCount;
}
