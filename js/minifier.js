/**
 * Lightweight Client-Side Code Minifier & Whitespace Compressor for LLM Context
 */

const minifyCache = new Map();
const MAX_CACHE_SIZE = 500;

function simpleHash(str) {
    // FNV-1a over the whole string: a prefix-only hash returned stale output
    // for same-length edits that appear after the sampled prefix.
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

function stripJsComments(code, ext = '') {
    const lines = [];
    let currentLine = '';
    let i = 0;
    const len = code.length;
    let state = 'normal';
    const isCss = ['css', 'scss', 'less'].includes(ext);
    const isRust = ext === 'rs';
    const templateStack = [];

    function pushNewline() {
        const trimmed = currentLine.trimEnd();
        if (trimmed.length > 0) {
            lines.push(trimmed);
        }
        currentLine = '';
    }

    function getPrevTrimmed() {
        const trimmed = currentLine.trimEnd();
        if (trimmed.length > 0) {
            return trimmed;
        }
        for (let idx = lines.length - 1; idx >= 0; idx--) {
            if (lines[idx].length > 0) return lines[idx];
        }
        return '';
    }

    function getPrevTrimmedInfo() {
        const prev = getPrevTrimmed();
        if (!prev) return { lastChar: '', endsWithArrow: false, isUrl: false, isKeyword: false };
        const lastChar = prev[prev.length - 1];
        const endsWithArrow = prev.endsWith('=>');
        const sampleStart = Math.max(0, prev.length - 15);
        const tail = prev.slice(sampleStart);
        const isUrl = /(?:https?|ftp|file):$/i.test(tail);
        const isKeyword = /\b(?:return|case|typeof|throw|delete|void|in|of|instanceof|new|yield|await)$/.test(tail);
        return { lastChar, endsWithArrow, isUrl, isKeyword };
    }

    while (i < len) {
        const char = code[i];
        const next = code[i + 1];

        if (state === 'normal') {
            if (!isCss && char === '/' && next === '/') {
                const info = getPrevTrimmedInfo();
                if (info.isUrl) {
                    currentLine += char;
                    i++;
                    continue;
                }
                state = 'line_comment';
                i += 2;
                continue;
            } else if (char === '/' && next === '*') {
                state = 'block_comment';
                i += 2;
                continue;
            } else if (char === '/') {
                const info = getPrevTrimmedInfo();
                const isRegexp = !isCss && !info.isUrl && info.lastChar !== '<' && (!info.lastChar || info.endsWithArrow || '=(:[{},;!&|?+*^%~'.includes(info.lastChar) || info.isKeyword);

                if (isRegexp) {
                    state = 'regex';
                    currentLine += char;
                    i++;
                } else {
                    currentLine += char;
                    i++;
                }
            } else if (char === "'") {
                if (isRust) {
                    const remainder = code.slice(i);
                    const lifetimeMatch = remainder.match(/^'([a-zA-Z_][a-zA-Z0-9_]*)/);
                    if (lifetimeMatch) {
                        const name = lifetimeMatch[1];
                        const after = code[i + 1 + name.length];
                        if (after !== "'") {
                            currentLine += char;
                            i++;
                            continue;
                        }
                    }
                }
                state = 'single_string';
                currentLine += char;
                i++;
            } else if (char === '"') {
                state = 'double_string';
                currentLine += char;
                i++;
            } else if (char === '`') {
                state = 'template_string';
                currentLine += char;
                i++;
            } else if (char === '{' && templateStack.length > 0) {
                templateStack[templateStack.length - 1].braceDepth++;
                currentLine += char;
                i++;
            } else if (char === '}' && templateStack.length > 0) {
                const top = templateStack[templateStack.length - 1];
                top.braceDepth--;
                if (top.braceDepth === 0) {
                    templateStack.pop();
                    state = top.returnState;
                }
                currentLine += char;
                i++;
            } else if (char === '\n') {
                pushNewline();
                i++;
            } else {
                currentLine += char;
                i++;
            }
        } else if (state === 'regex') {
            if (char === '\n') {
                state = 'normal';
                pushNewline();
                i++;
                continue;
            }
            currentLine += char;
            if (char === '\\') {
                if (i + 1 < len) {
                    currentLine += code[i + 1];
                    i += 2;
                    continue;
                }
            } else if (char === '[') {
                state = 'regex_class';
            } else if (char === '/') {
                state = 'normal';
            }
            i++;
        } else if (state === 'regex_class') {
            if (char === '\n') {
                state = 'normal';
                pushNewline();
                i++;
                continue;
            }
            currentLine += char;
            if (char === '\\') {
                if (i + 1 < len) {
                    currentLine += code[i + 1];
                    i += 2;
                    continue;
                }
            } else if (char === ']') {
                state = 'regex';
            }
            i++;
        } else if (state === 'single_string') {
            currentLine += char;
            if (char === '\\') {
                if (i + 1 < len) {
                    currentLine += code[i + 1];
                    i += 2;
                    continue;
                }
            } else if (char === "'") {
                state = 'normal';
            } else if (char === '\n') {
                state = 'normal';
                pushNewline();
            }
            i++;
        } else if (state === 'double_string') {
            currentLine += char;
            if (char === '\\') {
                if (i + 1 < len) {
                    currentLine += code[i + 1];
                    i += 2;
                    continue;
                }
            } else if (char === '"') {
                state = 'normal';
            } else if (char === '\n') {
                state = 'normal';
                pushNewline();
            }
            i++;
        } else if (state === 'template_string') {
            if (char === '\\') {
                currentLine += char;
                if (i + 1 < len) {
                    currentLine += code[i + 1];
                    i += 2;
                    continue;
                }
            } else if (char === '`') {
                currentLine += char;
                state = 'normal';
            } else if (char === '$' && next === '{') {
                currentLine += '${';
                i += 2;
                templateStack.push({ returnState: 'template_string', braceDepth: 1 });
                state = 'normal';
                continue;
            } else if (char === '\n') {
                lines.push(currentLine);
                currentLine = '';
                i++;
                continue;
            } else {
                currentLine += char;
            }
            i++;
        } else if (state === 'line_comment') {
            if (char === '\n') {
                state = 'normal';
                pushNewline();
            }
            i++;
        } else if (state === 'block_comment') {
            if (char === '*' && next === '/') {
                state = 'normal';
                i += 2;
                const prev = getPrevTrimmed();
                const prevChar = prev ? prev[prev.length - 1] : '';
                const nextChar = code[i];
                if (prevChar && nextChar && /[a-zA-Z0-9_$]/.test(prevChar) && /[a-zA-Z0-9_$]/.test(nextChar)) {
                    currentLine += ' ';
                }
                continue;
            }
            if (char === '\n') {
                pushNewline();
            }
            i++;
        }
    }
    const finalTrim = currentLine.trimEnd();
    if (finalTrim.length > 0) {
        lines.push(finalTrim);
    }
    return lines.join('\n').trim();
}

function stripHashComments(code, ext = '') {
    const lines = [];
    let currentLine = '';
    let i = 0;
    const len = code.length;
    let state = 'normal';
    const isShell = ['sh', 'bash'].includes(ext);
    const isRuby = ext === 'rb';

    function pushNewline() {
        const trimmed = currentLine.trimEnd();
        if (trimmed.length > 0) {
            lines.push(trimmed);
        }
        currentLine = '';
    }

    if (code.startsWith('#!')) {
        const firstLineEnd = code.indexOf('\n');
        if (firstLineEnd === -1) return code;
        lines.push(code.slice(0, firstLineEnd));
        i = firstLineEnd + 1;
    }

    while (i < len) {
        const char = code[i];
        const next = code[i + 1];
        const next2 = code[i + 2];

        if (state === 'normal') {
            let isCommentStart = false;
            if (isShell) {
                isCommentStart = (i === 0 || /[\s;&|()]/.test(code[i - 1]));
            } else if (isRuby) {
                isCommentStart = (currentLine.trim().length === 0);
            } else {
                isCommentStart = (i === 0 || code[i - 1] !== '\\');
            }

            if (char === '#' && isCommentStart) {
                state = 'line_comment';
                i++;
                continue;
            } else if (char === "'" && next === "'" && next2 === "'") {
                state = 'triple_single';
                currentLine += "'''";
                i += 3;
            } else if (char === '"' && next === '"' && next2 === '"') {
                state = 'triple_double';
                currentLine += '"""';
                i += 3;
            } else if (char === "'") {
                state = 'single_string';
                currentLine += char;
                i++;
            } else if (char === '"') {
                state = 'double_string';
                currentLine += char;
                i++;
            } else if (char === '\n') {
                pushNewline();
                i++;
            } else {
                currentLine += char;
                i++;
            }
        } else if (state === 'single_string') {
            currentLine += char;
            if (char === '\\') {
                if (i + 1 < len) {
                    currentLine += code[i + 1];
                    i += 2;
                    continue;
                }
            } else if (char === "'") {
                state = 'normal';
            } else if (char === '\n') {
                state = 'normal';
                pushNewline();
            }
            i++;
        } else if (state === 'double_string') {
            currentLine += char;
            if (char === '\\') {
                if (i + 1 < len) {
                    currentLine += code[i + 1];
                    i += 2;
                    continue;
                }
            } else if (char === '"') {
                state = 'normal';
            } else if (char === '\n') {
                state = 'normal';
                pushNewline();
            }
            i++;
        } else if (state === 'triple_single') {
            if (char === '\\') {
                currentLine += char;
                if (i + 1 < len) {
                    currentLine += code[i + 1];
                    i += 2;
                    continue;
                }
            } else if (char === "'" && next === "'" && next2 === "'") {
                currentLine += "'''";
                i += 3;
                state = 'normal';
                continue;
            } else if (char === '\n') {
                lines.push(currentLine);
                currentLine = '';
                i++;
                continue;
            } else {
                currentLine += char;
            }
            i++;
        } else if (state === 'triple_double') {
            if (char === '\\') {
                currentLine += char;
                if (i + 1 < len) {
                    currentLine += code[i + 1];
                    i += 2;
                    continue;
                }
            } else if (char === '"' && next === '"' && next2 === '"') {
                currentLine += '"""';
                i += 3;
                state = 'normal';
                continue;
            } else if (char === '\n') {
                lines.push(currentLine);
                currentLine = '';
                i++;
                continue;
            } else {
                currentLine += char;
            }
            i++;
        } else if (state === 'line_comment') {
            if (char === '\n') {
                state = 'normal';
                pushNewline();
            }
            i++;
        }
    }
    const finalTrim = currentLine.trimEnd();
    if (finalTrim.length > 0) {
        lines.push(finalTrim);
    }
    return lines.join('\n').trim();
}

function minifyHtml(code) {
    const rawBlocks = [];
    const nonce = '___PRE_TEXTAREA_' + Math.random().toString(36).substring(2, 9) + '_';
    let preserved = code.replace(/<(pre|textarea|script|style)\b[\s\S]*?<\/\1>/gi, (match) => {
        rawBlocks.push(match);
        return `${nonce}${rawBlocks.length - 1}___`;
    });

    preserved = preserved.replace(/<!--[\s\S]*?-->/g, '');
    let lines = preserved.split('\n').map(l => l.trimEnd()).filter(l => l.trim().length > 0);
    let result = lines.join('\n');

    const re = new RegExp(`${nonce}(\\d+)___`, 'g');
    result = result.replace(re, (_, idx) => rawBlocks[parseInt(idx, 10)]);
    return result;
}

export function minifyCode(content, filename = '', mode = 'none') {
    if (!content || mode === 'none') return content;

    const ext = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';
    if (['diff', 'patch'].includes(ext)) return content;

    const cacheKey = `${filename}:${mode}:${content.length}:${simpleHash(content)}`;
    if (minifyCache.has(cacheKey)) {
        return minifyCache.get(cacheKey);
    }

    const textExts = ['md', 'markdown', 'txt', 'json', 'yaml', 'yml', 'toml', 'ini', 'csv', 'log', 'env'];

    let result = content;
    if (mode === 'basic' || textExts.includes(ext)) {
        result = content.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trimEnd().replace(/^\n+/, '');
    } else if (mode === 'aggressive') {
        result = content.replace(/\r\n/g, '\n');

        if (['js', 'mjs', 'cjs', 'ts', 'mts', 'cts', 'jsx', 'tsx', 'css', 'scss', 'c', 'cpp', 'h', 'java', 'go', 'rs', 'swift', 'php', 'cs', 'kt', 'dart', 'scala'].includes(ext)) {
            result = stripJsComments(result, ext);
        } else if (['py', 'sh', 'bash', 'rb'].includes(ext)) {
            result = stripHashComments(result, ext);
        } else if (['html', 'xml', 'svg'].includes(ext)) {
            result = minifyHtml(result);
        } else {
            result = result.split('\n').map(l => l.trimEnd()).filter(l => l.trim().length > 0).join('\n');
        }
        result = result.trim();
    }

    if (minifyCache.size >= MAX_CACHE_SIZE) {
        const firstKey = minifyCache.keys().next().value;
        minifyCache.delete(firstKey);
    }
    minifyCache.set(cacheKey, result);
    return result;
}
