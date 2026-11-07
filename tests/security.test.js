import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { scanForSecrets, redactSecrets } from '../js/secrets.js';
import { parseRepoInput, isSafeBranchName, fetchFileContent, fetchRepoTree } from '../js/github-api.js';

const ROOT = new URL('../', import.meta.url).pathname;

// ------------------------------------------------------------------ finding 1: regex cost

test('secret scan stays fast on adversarial keyword runs (no quadratic backtracking)', () => {
    const inputs = [
        'password'.repeat(50000),
        'aws_secret_key'.repeat(28000),
        'token'.repeat(80000),
        'x_password_'.repeat(30000) + '= "abc"'
    ];
    for (const input of inputs) {
        const t0 = performance.now();
        scanForSecrets('config.yml', input);
        redactSecrets(input, 'config.yml', { aggressiveRedact: true });
        const ms = performance.now() - t0;
        assert.ok(ms < 200, `${input.slice(0, 20)}… took ${ms.toFixed(0)} ms`);
    }
});

test('bounded keyword regexes still catch normal secrets', () => {
    const aws = 'aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYzABCDEFKEY"';
    assert.ok(scanForSecrets('a.py', aws).some(f => f.type === 'aws-key'));
    const generic = 'DATABASE_PASSWORD = "Xk9#mQ2!vL7pRt4z"';
    assert.ok(scanForSecrets('a.py', generic).some(f => f.type === 'generic-secret'));
    assert.ok(!redactSecrets(generic, 'a.py', { aggressiveRedact: true }).includes('Xk9#mQ2!vL7pRt4z'));
});

// ------------------------------------------------------------------ finding 2: coverage

const hex = n => Array.from({ length: n }, (_, i) => '0123456789abcdef'[(i * 7 + 3) % 16]).join('');
const mixed = n => Array.from({ length: n }, (_, i) => 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3z5A0'[(i * 5 + 1) % 37]).join('');

test('new token formats are detected and redacted by default', () => {
    const cases = {
        'webhook-url': [
            `const hook = "https://hooks.slack.com/services/T0123ABCD/B0456EFGH/${mixed(24)}";`,
            `https://discord.com/api/webhooks/123456789012345678/${mixed(68)}`
        ],
        'provider-token': [`twilio = SK${hex(32)}`, `shpat_${hex(32)}`, `whsec_${mixed(32)}`, `mailgun: key-${hex(32)}`],
        'azure-key': [
            `DefaultEndpointsProtocol=https;AccountName=x;AccountKey=${mixed(86)}==;EndpointSuffix=core.windows.net`,
            `Endpoint=sb://x/;SharedAccessKeyName=root;SharedAccessKey=${mixed(44)}=`,
            `BlobEndpoint=https://x/;SharedAccessSignature=sv=2022-11-02&sig=${mixed(40)}`
        ]
    };
    for (const [type, samples] of Object.entries(cases)) {
        for (const sample of samples) {
            assert.ok(scanForSecrets('app.js', sample).some(f => f.type === type), `${type}: ${sample.slice(0, 50)}`);
            assert.match(redactSecrets(sample, 'app.js'), new RegExp(`\\[REDACTED:${type}\\]`), `redacted by default: ${sample.slice(0, 50)}`);
        }
    }
});

test('look-alike text is not flagged by the new patterns', () => {
    const text = 'const SKILL = "SKILLS"; // key-value pairs\nconst whsec = 1; skeleton(); shpat_ is a prefix\nAccountKey=short';
    assert.deepEqual(scanForSecrets('app.js', text), []);
});

test('sensitive filenames: keys, key stores, credentials files, Terraform', () => {
    for (const f of ['id_ed25519', 'id_ecdsa', 'id_dsa', 'cert.p12', 'cert.pfx', 'app.jks', 'release.keystore', '.npmrc', '.pypirc',
        '.netrc', '.git-credentials', '.htpasswd', 'prod.tfvars', 'terraform.tfstate', 'kubeconfig', 'service-account.json',
        'service_account-prod.json', '.envrc', 'prod.env', 'deploy/secrets/.env']) {
        assert.ok(scanForSecrets(f, 'x').some(x => x.type === 'sensitive-file'), f);
        assert.equal(redactSecrets('anything', f), '[REDACTED:sensitive-file]', f);
    }
    for (const f of ['.env.example', 'package.json', 'keys.md', 'id_rsa.pub', 'environment.ts']) {
        assert.ok(!scanForSecrets(f, 'x').some(x => x.type === 'sensitive-file'), f);
    }
});

test('unquoted key=value secrets are scanned in more config files', () => {
    const line = 'auth_token=abc123XYZ789secretvalue';
    assert.ok(scanForSecrets('deploy/prod.tfvars', line).some(f => f.type === 'generic-secret'));
    assert.ok(scanForSecrets('.envrc', `export ${line}`).some(f => f.type === 'generic-secret'));
    assert.ok(!scanForSecrets('src/app.js', line).some(f => f.type === 'generic-secret'), 'not in ordinary code');
});

test('the Code page says generic secrets are only hidden with Strict', () => {
    const html = fs.readFileSync(ROOT + 'code.html', 'utf8');
    assert.match(html, /Generic passwords and tokens in code are flagged in the output panel but only hidden with Strict\./);
});

// ------------------------------------------------------------------ finding 3: CSP

test('every page has a CSP and no inline scripts or event handlers', () => {
    for (const page of ['index.html', 'privacy.html', 'terms.html', 'code.html', 'issues.html', 'discussions.html', 'deps.html']) {
        const html = fs.readFileSync(ROOT + page, 'utf8');
        const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html);
        assert.ok(csp, `${page}: CSP meta tag`);
        assert.match(csp[1], /script-src 'self';/);
        assert.match(csp[1], /connect-src 'self' https:\/\/api\.github\.com https:\/\/raw\.githubusercontent\.com https:\/\/api\.deps\.dev;/);
        assert.match(csp[1], /object-src 'none'/);
        assert.doesNotMatch(html, /\son[a-z]+\s*=\s*["']/i, `${page}: inline event handler`);
        assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, `${page}: inline script`);
        assert.match(html, /<meta name="referrer" content="no-referrer">/);
    }
});

// ------------------------------------------------------------------ finding 4: branch names

test('branch names that could escape the repository path are rejected', () => {
    for (const ok of ['main', 'release/1.2', 'feature/x-y_z', 'v1.0.0', 'dependabot/npm_and_yarn/foo-1.2.3']) {
        assert.ok(isSafeBranchName(ok), ok);
    }
    for (const bad of ['../../evil/repo/main', 'a/../b', './x', 'a//b', '/main', 'main/', 'x\\y', 'a?b', 'a#b', 'a%2e%2e',
        'a b', 'a\tb', '.hidden', 'x.lock', 'a@{1}', 'HEAD~1', 'refs:x', '', 'end.']) {
        assert.ok(!isSafeBranchName(bad), JSON.stringify(bad));
    }
    assert.equal(parseRepoInput('o/r', '../../x/y/main'), null);
    assert.equal(parseRepoInput('o/r/tree/../../x'), null);
    assert.equal(parseRepoInput('o/r/tree/main/../secret'), null);
    assert.deepEqual(parseRepoInput('https://github.com/o/r/tree/main/src'), { owner: 'o', repo: 'r', branch: 'main', subpath: 'src', treeTail: 'main/src' });
});

test('fetch helpers refuse unsafe branch names without making a request', async () => {
    let calls = 0;
    const saved = globalThis.fetch;
    globalThis.fetch = async () => { calls++; return new Response('x'); };
    try {
        const r = await fetchFileContent('trusted', 'repo', '../../evil/repo/main', 'README.md', '');
        assert.equal(r.success, false);
        await assert.rejects(fetchRepoTree('trusted', 'repo', 'x/../../../../../evil/repo/git/trees/main', ''), /Invalid branch name/);
        assert.equal(calls, 0);
    } finally {
        globalThis.fetch = saved;
    }
});
