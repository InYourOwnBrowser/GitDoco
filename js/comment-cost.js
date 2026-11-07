import { estimateCommentFetchCost } from './github-issues-api.js';

export function commentCostHint(selectedIssues, universe, cachedNumbers, scope) {
  if (scope === 'none') return { requests: 0, text: 'No extra requests.' };
  const needs = selectedIssues.filter(i => i.commentsCount > 0 && !cachedNumbers.has(i.number));
  if (needs.length === 0) return { requests: 0, text: 'Comments already loaded.' };
  const c = estimateCommentFetchCost(needs, universe);
  const bulk = c.perIssue >= 4 && c.bulkPages <= c.perIssue * 0.3;
  const n = bulk ? c.bulkPages : c.perIssue;
  return { requests: n, text: `About ${n} GitHub request${n === 1 ? '' : 's'}.` };
}
