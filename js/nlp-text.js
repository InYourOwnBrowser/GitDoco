/**
 * Text cleaning and tokenizing shared by the NLP worker (topic clusters) and topic search.
 */

export const STOPWORDS = new Set([
    'the', 'and', 'for', 'that', 'this', 'with', 'from', 'are', 'was', 'were', 'have', 'has', 'had',
    'not', 'but', 'what', 'all', 'when', 'can', 'there', 'use', 'used', 'using', 'an', 'each', 'which',
    'she', 'do', 'how', 'their', 'if', 'will', 'up', 'other', 'about', 'out', 'many', 'then', 'them',
    'these', 'so', 'some', 'her', 'would', 'make', 'like', 'him', 'into', 'time', 'look', 'two', 'more',
    'write', 'go', 'see', 'no', 'way', 'could', 'my', 'than', 'first', 'been', 'call', 'who', 'its',
    'now', 'find', 'long', 'down', 'day', 'did', 'get', 'come', 'made', 'may', 'part', 'over', 'new',
    'after', 'also', 'only', 'work', 'works', 'working', 'does', 'doesn', 'don', 'should', 'ried',
    'trying', 'tried', 'just', 'still', 'even', 'when', 'where', 'why', 'while', 'here', 'very',
    'any', 'same', 'able', 'need', 'want', 'know', 'think', 'seem', 'seems', 'getting', 'got',
    'bug', 'issue', 'feature', 'request', 'describe', 'description', 'expected', 'behavior', 'behaviour',
    'actual', 'steps', 'reproduce', 'reproduction', 'environment', 'version', 'operating', 'system',
    'additional', 'context', 'screenshots', 'screenshot', 'code', 'example', 'problem', 'solution',
    'please', 'thanks', 'thank', 'hello', 'hi', 'hey', 'summary', 'checklist', 'search', 'searched',
    'existing', 'issues', 'current', 'currently', 'running', 'follow', 'following', 'below', 'above',
    'file', 'files', 'line', 'http', 'https', 'com', 'github', 'org', 'www', 'html', 'true', 'false'
]);

export function cleanAndTokenize(title, body) {
    const cleanText = (str) => (str || '')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`[^`\n]+`/g, ' ')
        .replace(/!\[[^\]]*\]\([^)]+\)/g, ' ')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/https?:\/\/\S+/g, ' ')
        .toLowerCase();

    const getTokens = (str) => {
        const raw = cleanText(str).match(/(?:[\p{L}\p{N}][\p{L}\p{N}_.-]{1,24}|[a-z0-9_.-]{2,25})/gu) || [];
        const res = [];
        for (let tok of raw) {
            tok = tok.replace(/^[._-]+|[._-]+$/g, '');
            if (tok.length < 3) continue;
            if (STOPWORDS.has(tok)) continue;
            if (/^\d+$/.test(tok)) continue;
            res.push(tok);
        }
        return res;
    };

    const titleTokens = getTokens(title);
    const bodyTokens = getTokens(body);

    return [...titleTokens, ...titleTokens, ...bodyTokens];
}
