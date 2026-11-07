import { estimateCommentFetchCost } from './github-issues-api.js';

export function commentCostHint(selectedIssues, universe, cachedNumbers, scope) {
  if (scope === 'none') return { requests: 0, text: 'No extra requests.' };
  const needs = selectedIssues.filter(i => i.commentsCount > 0 && !cachedNumbers.has(i.number));
  if (needs.length === 0) return { requests: 0, text: 'Comments already loaded.' };
  const c = estimateCommentFetchCost(needs, universe);
  const bulk = c.perIssue >= 4 && c.bulkPages <= c.perIssue * 0.3;
  const n = bulk ? c.bulkPages : c.perIssue;
  // The bulk route reads the repo's comment feed; threads whose counts don't match are then
  // fetched one by one, so the per-thread figure is the upper bound.
  return { requests: n, max: bulk ? c.perIssue : n, text: `About ${n} GitHub request${n === 1 ? '' : 's'}.` };
}

/** GitHub's hourly REST allowance without a token. */
export const ANON_LIMIT = 60;

/**
 * Says what fetching comments will cost against the hourly GitHub limit, so people are warned
 * before spending it (without a token, comments usually cost one request per thread).
 * @param {number} requests   estimated requests
 * (opts.max: the most it could take, when the estimate assumes the cheaper bulk route works)
 * @param {object} opts
 * @param {boolean} opts.hasToken
 * @param {number} [opts.remaining]  requests left this hour, when GitHub has told us (else unknown)
 * @param {{ one: string, noun: string }} [opts.words]
 * @returns {{ text: string, level: 'ok'|'warn'|'over' }}
 */
export function quotaNote(requests, { hasToken = false, remaining = Infinity, max = 0, words = { one: 'issue', noun: 'issues' } } = {}) {
    const n = Math.max(0, Math.round(requests));
    const upTo = max > n ? `, up to ${max} if some threads have to be fetched one by one` : '';
    const reqs = k => `${k} GitHub request${k === 1 ? '' : 's'}${k === n ? upTo : ''}`;
    const known = Number.isFinite(remaining);
    if (hasToken) {
        if (known && n > remaining) return { text: `About ${reqs(n)}, but only ${remaining} are left this hour.`, level: 'over' };
        return { text: `About ${reqs(n)}.`, level: 'ok' };
    }
    const left = known ? remaining : ANON_LIMIT;
    if (n > left) {
        return {
            text: `About ${reqs(n)}, but only ${left} of the ${ANON_LIMIT} you get an hour without a token ${left === 1 ? 'is' : 'are'} left. Add a token (5,000 an hour), select fewer ${words.noun}, or include fewer comments.`,
            level: 'over'
        };
    }
    if (n >= ANON_LIMIT / 4) {
        return { text: `About ${reqs(n)}: a big share of the ${ANON_LIMIT} an hour GitHub allows without a token (${left} left). A token raises the limit to 5,000.`, level: 'warn' };
    }
    return { text: `About ${reqs(n)}${known ? ` (${left} of ${ANON_LIMIT} left this hour)` : ''}.`, level: 'ok' };
}
