import test from 'node:test';
import assert from 'node:assert/strict';
import { routeFor, toolLinks } from '../js/repo-route.js';

const q = r => Object.fromEntries(new URL(r.href, 'https://x.test').searchParams);
const page = r => new URL(r.href, 'https://x.test').pathname;

test('GitHub repository paths open the matching tool and start loading', () => {
    let r = routeFor('/facebook/react/issues');
    assert.equal(page(r), '/issues.html');
    assert.deepEqual(q(r), { repo: 'facebook/react', includePrs: 'issues', go: '1' });
    assert.equal(page(routeFor('/facebook/react/issues/123')), '/issues.html');

    r = routeFor('/facebook/react/pulls');
    assert.deepEqual(q(r), { repo: 'facebook/react', includePrs: 'prs', go: '1' });

    r = routeFor('/facebook/react/pull/31502/files');
    assert.equal(page(r), '/deps.html');
    assert.deepEqual(q(r), { repo: 'facebook/react', compare: '#31502', go: '1' }, 'a pull request opens its dependency changes');

    r = routeFor('/o/r/compare/main...feature/login');
    assert.deepEqual(q(r), { repo: 'o/r', compare: 'feature/login', base: 'main', go: '1' }, 'the base is kept');
    assert.deepEqual(q(routeFor('/o/r/compare/release/1.x..fix')), { repo: 'o/r', compare: 'fix', base: 'release/1.x', go: '1' });
    assert.deepEqual(q(routeFor('/o/r/compare/feature')), { repo: 'o/r', compare: 'feature', go: '1' }, 'a lone ref is compared with the default branch');

    assert.deepEqual(q(routeFor('/o/r/discussions/42')), { repo: 'o/r', go: '1' });
    assert.equal(page(routeFor('/o/r/discussions')), '/discussions.html');
    assert.equal(page(routeFor('/o/r/network/dependencies')), '/deps.html');
    assert.equal(page(routeFor('/o/r/security/advisories')), '/deps.html');
});

test('branch, file and commit paths open the Code tool at that place', () => {
    assert.deepEqual(q(routeFor('/o/r/tree/main/src/lib')), { repo: 'https://github.com/o/r/tree/main/src/lib', go: '1' });
    assert.deepEqual(q(routeFor('/o/r/blob/main/src/lib/index.js')), { repo: 'https://github.com/o/r/tree/main/src/lib', go: '1' }, 'a file opens its folder');
    assert.deepEqual(q(routeFor('/o/r/commit/0123abcd')), { repo: 'https://github.com/o/r/tree/0123abcd', go: '1' });
    assert.deepEqual(q(routeFor('/o/r/tree')), { repo: 'o/r', go: '1' });
    assert.deepEqual(q(routeFor('/o/r/blob/main')), { repo: 'https://github.com/o/r/tree/main', go: '1' }, 'a blob link without a file keeps the branch');
    assert.deepEqual(q(routeFor('/o/r/blob/main/README.md')), { repo: 'https://github.com/o/r/tree/main', go: '1' });
});

test('a bare repository (or an unknown section) shows the pick-a-tool page', () => {
    assert.deepEqual(routeFor('/facebook/react'), { hub: true, repo: 'facebook/react' });
    assert.deepEqual(routeFor('/facebook/react/'), { hub: true, repo: 'facebook/react' });
    assert.deepEqual(routeFor('/o/r.git'), { hub: true, repo: 'o/r' });
    assert.deepEqual(routeFor('/o/r/wiki'), { hub: true, repo: 'o/r' });
    const links = toolLinks('o/r');
    assert.equal(links.deps, '/deps.html?repo=o%2Fr&go=1');
    assert.equal(links.issues, '/issues.html?repo=o%2Fr&includePrs=issues&go=1');
});

test('anything that is not a repository stays a real "page not found"', () => {
    for (const p of ['/', '/facebook', '/orgs/github/people', '/settings/profile',
        '/topics/ai', '/-bad/repo', '/o/..', '/o/r%2F..%2Fx', '/o/code.html', '/o/%E0%A4%A', '/' + 'a'.repeat(40) + '/r']) {
        assert.equal(routeFor(p), null, p);
    }
});

test('accounts named like GitDoco folders (js, css, assets) still work', () => {
    assert.equal(page(routeFor('/js/some-repo/issues')), '/issues.html');
    assert.deepEqual(routeFor('/css/framework'), { hub: true, repo: 'css/framework' });
});

test('links stay on GitDoco and carry only checked names', () => {
    for (const p of ['/o/r/issues', '/o/r/pull/1', '/o/r/tree/x', '/o/r/discussions']) {
        const href = routeFor(p).href;
        assert.match(href, /^\/(issues|deps|code|discussions)\.html\?/, href);
    }
    assert.equal(routeFor('/o/r/pull/notanumber').tool, 'issues');
    assert.equal(routeFor('/o/r/compare/' + 'x'.repeat(400)).href.length < 400, true);
});
