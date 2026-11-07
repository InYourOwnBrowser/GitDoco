import { estimateTokens } from './tokenizer.js';

self.onmessage = function(e) {
    const { id, text } = e.data;
    const tokens = estimateTokens(text);
    self.postMessage({ id, tokens });
};
