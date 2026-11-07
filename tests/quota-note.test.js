import test from 'node:test';
import assert from 'node:assert/strict';
import { quotaNote, ANON_LIMIT } from '../js/comment-cost.js';

test('quotaNote: small fetches are fine, big shares warn, more than is left stops', () => {
    assert.equal(ANON_LIMIT, 60);
    assert.deepEqual(quotaNote(3, { remaining: 55 }), { text: 'About 3 GitHub requests (55 of 60 left this hour).', level: 'ok' });
    assert.equal(quotaNote(3).text, 'About 3 GitHub requests.', 'remaining unknown before the first response');
    const warn = quotaNote(20, { remaining: 50 });
    assert.equal(warn.level, 'warn');
    assert.match(warn.text, /big share of the 60 an hour.*\(50 left\).*5,000/);
    const over = quotaNote(45, { remaining: 30, words: { one: 'discussion', noun: 'discussions' } });
    assert.equal(over.level, 'over');
    assert.match(over.text, /only 30 of the 60 .* are left\. Add a token .* select fewer discussions/);
    assert.equal(quotaNote(61).level, 'over', 'more than the whole hourly allowance');
    assert.equal(quotaNote(3, { remaining: 50, max: 40 }).text, 'About 3 GitHub requests, up to 40 if some threads have to be fetched one by one (50 of 60 left this hour).');
});

test('quotaNote with a token: plain unless it exceeds what is left', () => {
    assert.deepEqual(quotaNote(200, { hasToken: true, remaining: 4800 }), { text: 'About 200 GitHub requests.', level: 'ok' });
    assert.equal(quotaNote(200, { hasToken: true, remaining: 100 }).level, 'over');
    assert.equal(quotaNote(1, { hasToken: true }).text, 'About 1 GitHub request.');
});
