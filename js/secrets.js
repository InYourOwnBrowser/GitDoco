/**
 * Pure module for secret detection and output redaction.
 * Zero DOM dependencies for Node unit testing compatibility.
 */

const SENSITIVE_FILENAME_EXACT = new Set([
    '.env',
    '.envrc',
    'id_rsa',
    'id_dsa',
    'id_ecdsa',
    'id_ed25519',
    'credentials.json',
    '.npmrc',
    '.pypirc',
    '.netrc',
    '_netrc',
    '.git-credentials',
    '.htpasswd',
    'kubeconfig'
]);

// Key stores, certificates with private keys, Terraform variables and state.
const SENSITIVE_FILENAME_SUFFIXES = ['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.tfvars', '.tfstate', '.tfstate.backup', '.env'];

const SENSITIVE_FILENAME_EXCEPTIONS = new Set([
    '.env.example',
    '.env.sample',
    '.env.template',
    '.env.dist'
]);

// Files where unquoted `key=value` secrets are common (.json needs no entry: its values are quoted).
const CONFIG_LIKE_EXACT = new Set(['.npmrc', '.pypirc', '.netrc', '_netrc', '.envrc', '.git-credentials']);

function isConfigLikeFile(path) {
    if (!path) return false;
    const filename = path.split('/').pop().toLowerCase();
    if (CONFIG_LIKE_EXACT.has(filename) || filename.endsWith('.tfvars') || filename.endsWith('.env')) {
        return true;
    }
    if (filename.startsWith('.env') || filename.endsWith('.ini') || filename.endsWith('.cfg') || filename.endsWith('.conf') || filename.endsWith('.properties') || filename.endsWith('.yml') || filename.endsWith('.yaml') || filename.endsWith('.toml') || filename.endsWith('.sh') || filename === 'dockerfile' || filename.startsWith('docker-compose')) {
        return true;
    }
    return false;
}

function isSensitiveFilename(path) {
    if (!path) return false;
    const filename = path.split('/').pop().toLowerCase();

    if (SENSITIVE_FILENAME_EXCEPTIONS.has(filename)) {
        return false;
    }

    if (SENSITIVE_FILENAME_EXACT.has(filename)) {
        return true;
    }

    if (filename.startsWith('.env.')) {
        return true;
    }

    if (SENSITIVE_FILENAME_SUFFIXES.some(suffix => filename.endsWith(suffix))) {
        return true;
    }

    // Cloud service-account key files, e.g. service-account.json, service_account-prod.json.
    if (/^service[-_]?account.*\.json$/.test(filename)) {
        return true;
    }

    return false;
}

function calculateEntropy(str) {
    if (!str) return 0;
    const len = str.length;
    const freqs = {};
    for (let i = 0; i < len; i++) {
        const char = str[i];
        freqs[char] = (freqs[char] || 0) + 1;
    }
    let entropy = 0;
    for (const char in freqs) {
        const p = freqs[char] / len;
        entropy -= p * Math.log2(p);
    }
    return entropy;
}

function getCharacterClassCount(str) {
    let classes = 0;
    if (/[a-z]/.test(str)) classes++;
    if (/[A-Z]/.test(str)) classes++;
    if (/[0-9]/.test(str)) classes++;
    if (/[^a-zA-Z0-9]/.test(str)) classes++;
    return classes;
}

function isRepeatedPattern(str) {
    if (!str || str.length < 6) return false;
    const freqs = {};
    let maxFreq = 0;
    for (let i = 0; i < str.length; i++) {
        const c = str[i];
        freqs[c] = (freqs[c] || 0) + 1;
        if (freqs[c] > maxFreq) maxFreq = freqs[c];
    }
    if (maxFreq / str.length >= 0.6) return true;

    const pat2 = str.slice(0, 2);
    if (pat2.repeat(Math.floor(str.length / 2)) === str.slice(0, pat2.length * Math.floor(str.length / 2))) {
        return true;
    }

    return false;
}

function isPlaceholder(val) {
    if (!val) return true;
    const lower = val.toLowerCase();

    if (
        lower.includes('example') ||
        lower.includes('your_') ||
        lower.includes('xxxx') ||
        lower.includes('changeme') ||
        lower.includes('process.env') ||
        lower.includes('os.environ')
    ) {
        return true;
    }

    if (val.includes('${') || val.includes('<') && val.includes('>')) {
        return true;
    }

    if (isRepeatedPattern(val)) {
        return true;
    }

    return false;
}

function createMaskedPreview(val) {
    if (!val) return '…';
    const head = val.slice(0, 4);
    return `${head}…`;
}

function getLineNumber(content, index) {
    if (index <= 0) return 1;
    let line = 1;
    for (let i = 0; i < index; i++) {
        if (content.charCodeAt(i) === 10) { // '\n'
            line++;
        }
    }
    return line;
}

/**
 * Helper returning matches with raw values, ranges, types, and line numbers.
 * Internal only - raw values are NOT exposed in scanForSecrets findings.
 */
function findMatchesInternal(path, content, opts = {}) {
    const specificResults = [];
    const genericResults = [];

    const filename = path ? path.split('/').pop().toLowerCase() : '';
    if (path && isSensitiveFilename(path)) {
        specificResults.push({
            type: 'sensitive-file',
            line: 1,
            value: filename,
            index: 0,
            length: filename.length
        });
    }

    if (!content) return specificResults;

    const scanContent = content;

    const PATTERNS = [
        {
            type: 'aws-key',
            regex: /(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
            check: (m) => !isPlaceholder(m[0])
        },
        {
            type: 'aws-key',
            regex: /(?:(?:["']?\b|\b["'])[A-Za-z0-9_]{0,40}(?:aws_secret_access_key|secret_access_key|aws_secret_key|aws_sec_key)[A-Za-z0-9_]{0,40}["']?)\s*[:=]\s*(["']?)([A-Za-z0-9/+=]{40})\1/gi,
            check: (m) => !isPlaceholder(m[2]),
            getValue: (m) => m[2],
            getIndex: (m) => m.index + m[0].lastIndexOf(m[2]),
            getLength: (m) => m[2].length
        },
        {
            type: 'github-token',
            regex: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,255}\b|github_pat_[A-Za-z0-9_]{22,255}\b/g,
            check: (m) => !isPlaceholder(m[0])
        },
        {
            type: 'slack-token',
            regex: /xox[baprs]-[0-9a-zA-Z]{10,48}(?:-[0-9a-zA-Z]{10,48})?\b/g,
            check: (m) => !isPlaceholder(m[0])
        },
        {
            type: 'stripe-key',
            regex: /(?:sk|rk)_live_[0-9a-zA-Z]{24,99}\b/g,
            check: (m) => !isPlaceholder(m[0])
        },
        {
            type: 'google-key',
            regex: /AIza[0-9A-Za-z\-_]{35}(?![0-9A-Za-z\-_])/g,
            check: (m) => !isPlaceholder(m[0])
        },
        {
            type: 'pem-key',
            regex: /-----BEGIN [A-Z0-9_ ]*PRIVATE KEY-----(?:(?!-----BEGIN)[\s\S])*?-----END [A-Z0-9_ ]*PRIVATE KEY-----/g,
            check: (m) => !isPlaceholder(m[0])
        },
        {
            type: 'jwt',
            regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
            check: (m) => !isPlaceholder(m[0])
        },
        {
            type: 'anthropic-key',
            regex: /(?<![A-Za-z0-9])sk-ant-[a-zA-Z0-9_\-]{20,}(?![A-Za-z0-9_-])/g,
            check: (m) => !isPlaceholder(m[0])
        },
        {
            type: 'openai-key',
            regex: /(?<![A-Za-z0-9])sk-(?!ant-)(?:proj-|svcacct-|admin-)?[a-zA-Z0-9_\-]{20,}(?![A-Za-z0-9_-])/g,
            check: (m) => {
                if (isPlaceholder(m[0])) return false;
                if (m[0].length < 32) return false;
                if (/^sk-(?:proj-|svcacct-|admin-)?[a-z0-9-]+$/.test(m[0]) && !/[0-9_]/.test(m[0]) && getCharacterClassCount(m[0]) < 2) return false;
                if (calculateEntropy(m[0]) < 3.0) return false;
                return true;
            }
        },
        {
            type: 'provider-token',
            regex: /(?<![A-Za-z0-9])(?:glpat-[A-Za-z0-9_\-]{20,}|npm_[A-Za-z0-9]{36}|hf_[A-Za-z0-9]{34,}|SG\.[A-Za-z0-9_\-]{22}\.[A-Za-z0-9_\-]{43}|pypi-AgEIcHlwaS5vcmc[A-Za-z0-9_\-]{50,}|dop_v1_[a-f0-9]{64})(?![A-Za-z0-9_-])/g,
            check: (m) => !isPlaceholder(m[0])
        },
        {
            type: 'webhook-url',
            regex: /https:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9_\/-]{20,}|https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{50,}/g,
            check: (m) => !isPlaceholder(m[0])
        },
        {
            type: 'provider-token',
            // Twilio API key, Shopify tokens, Stripe webhook secret, Mailgun API key.
            regex: /(?<![A-Za-z0-9])(?:SK[0-9a-f]{32}|shp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}|whsec_[A-Za-z0-9]{32,}|key-[0-9a-f]{32})(?![A-Za-z0-9_-])/g,
            check: (m) => !isPlaceholder(m[0]) && !isRepeatedPattern(m[0].replace(/^(SK|shp\w\w_|whsec_|key-)/, ''))
        },
        {
            type: 'azure-key',
            // Storage / Service Bus connection strings and SAS tokens.
            regex: /\b(?:AccountKey|SharedAccessKey)=([A-Za-z0-9+/]{30,}={0,2})|\bSharedAccessSignature=([^;\s"']{20,})/g,
            check: (m) => !isPlaceholder(m[1] || m[2]),
            getValue: (m) => m[1] || m[2],
            getIndex: (m) => m.index + m[0].lastIndexOf(m[1] || m[2]),
            getLength: (m) => (m[1] || m[2]).length
        },
        {
            type: 'url-credentials',
            regex: /\b[a-zA-Z][a-zA-Z0-9+.-]{0,15}:\/\/[^\s:@/]+:([^\s@/]{8,})@/gi,
            check: (m) => !isPlaceholder(m[1]),
            getValue: (m) => m[1],
            getIndex: (m) => m.index + m[0].lastIndexOf(m[1]),
            getLength: (m) => m[1].length
        },
        {
            type: 'authorization-header',
            regex: /\bAuthorization\s*:\s*(?:Bearer|Basic)\s+([A-Za-z0-9_.\-~/+=]{10,})/gi,
            check: (m) => !isPlaceholder(m[1]),
            getValue: (m) => m[1],
            getIndex: (m) => m.index + m[0].lastIndexOf(m[1]),
            getLength: (m) => m[1].length
        },
        {
            type: 'generic-secret',
            regex: /(?:(?:["']?\b|\b["'])[A-Za-z0-9_]{0,40}(?:password|passwd|secret|token|api_key|apikey|auth_key|auth_token|authorization)[A-Za-z0-9_]{0,40}["']?)\s*[:=]\s*(["'])([^"'\r\n]{8,})\1/gi,
            check: (m) => {
                const val = m[2];
                if (isPlaceholder(val)) return false;
                if (val.includes('\\') || val.includes('://')) return false;
                if (val.includes(' ')) return false;

                if (/[/+=]/.test(val)) {
                    if (val.length < 32) return false;
                    if (val.startsWith('/') || val.startsWith('./') || val.startsWith('../')) return false;
                    if (/\.[a-zA-Z0-9]{1,4}$/i.test(val)) return false;
                    if (calculateEntropy(val) < 4.0) return false;
                }

                const keyName = m[0].slice(0, m[0].indexOf(val)).toLowerCase();
                const isExplicitKey = keyName.includes('password') || keyName.includes('passwd') || keyName.includes('secret');

                if (!/[0-9]/.test(val)) {
                    if (/^[a-zA-Z0-9_\-.]+\.[a-zA-Z0-9_\-]+$/.test(val)) return false;
                    if (!(isExplicitKey && val.length >= 12 && calculateEntropy(val) >= 3.2)) {
                        return false;
                    }
                }

                if (getCharacterClassCount(val) < 2) return false;
                if (calculateEntropy(val) < 3.0) return false;
                return true;
            },
            getValue: (m) => m[2],
            getIndex: (m) => m.index + m[0].lastIndexOf(m[2]),
            getLength: (m) => m[2].length
        },
        {
            type: 'generic-secret',
            regex: /(?:(?:["']?\b|\b["'])[A-Za-z0-9_]{0,40}(?:password|passwd|secret|token|api_key|apikey|auth_key|auth_token|authorization)[A-Za-z0-9_]{0,40}["']?)\s*[:=]\s*([^\s"'#;\r\n]{8,})/gi,
            check: (m, p) => {
                if (!opts.assumeConfig && !isConfigLikeFile(p)) return false;
                const val = m[1];
                if (isPlaceholder(val)) return false;
                if (/[()\[\]{},$]/.test(val)) return false;
                if (val.includes('`') || val.includes(';') || val.includes('.')) return false;
                if (!/[0-9]/.test(val)) return false;
                if (getCharacterClassCount(val) < 2) return false;
                if (calculateEntropy(val) < 3.0) return false;
                return true;
            },
            getValue: (m) => m[1],
            getIndex: (m) => m.index + m[0].lastIndexOf(m[1]),
            getLength: (m) => m[1].length
        }
    ];

    for (const p of PATTERNS) {
        p.regex.lastIndex = 0;
        let match;
        while ((match = p.regex.exec(scanContent)) !== null) {
            if (p.check(match, path)) {
                const val = p.getValue ? p.getValue(match) : match[0];
                const matchIdx = p.getIndex ? p.getIndex(match) : match.index;
                const matchLen = p.getLength ? p.getLength(match) : match[0].length;
                const item = {
                    type: p.type,
                    line: getLineNumber(scanContent, matchIdx),
                    value: val,
                    index: matchIdx,
                    length: matchLen
                };
                if (p.type === 'generic-secret') {
                    genericResults.push(item);
                } else {
                    specificResults.push(item);
                }
            }
        }
    }

    for (const gen of genericResults) {
        const overlaps = specificResults.some(spec => {
            return (gen.index < spec.index + spec.length) && (gen.index + gen.length > spec.index);
        });
        if (!overlaps) {
            specificResults.push(gen);
        }
    }

    return specificResults;
}

/**
 * Scans path and file content for sensitive patterns and flags findings.
 * @param {string} path - Relative file path.
 * @param {string} content - Raw content of the file.
 * @returns {Array<{ type: string, line: number, preview: string }>} Array of secret findings.
 */
export function scanForSecrets(path, content, opts = {}) {
    const rawMatches = findMatchesInternal(path, content, opts);
    return rawMatches.map(m => ({
        type: m.type,
        line: m.line,
        preview: createMaskedPreview(m.value)
    }));
}

/**
 * Replaces matched secret values in content with [REDACTED:<type>].
 * @param {string} content - Raw content of the file.
 * @param {string} path - Relative file path.
 * @returns {string} Content with secrets redacted.
 */
export function redactSecrets(content, path, options = {}) {
    if (path && isSensitiveFilename(path)) {
        return '[REDACTED:sensitive-file]';
    }

    if (!content) return content || '';

    let matches = findMatchesInternal(path, content, options).filter(m => m.type !== 'sensitive-file');
    if (!options.aggressiveRedact) {
        matches = matches.filter(m => m.type !== 'generic-secret');
    }

    if (matches.length === 0) return content;

    const sorted = [...matches].sort((a, b) => b.index - a.index);
    let redacted = content;
    let lastStart = Infinity;

    for (const m of sorted) {
        if (m.index >= 0 && m.index + m.length <= lastStart && m.index + m.length <= redacted.length) {
            const before = redacted.slice(0, m.index);
            const after = redacted.slice(m.index + m.length);
            redacted = before + `[REDACTED:${m.type}]` + after;
            lastStart = m.index;
        }
    }

    return redacted;
}
