export function buildSettingsSummary({ targetLabel, minifyMode, redactLevel, chunkLimit }) {
  const parts = [];

  if (targetLabel) {
    parts.push(targetLabel);
  }

  if (minifyMode === 'basic') {
    parts.push('blank lines removed');
  } else if (minifyMode === 'aggressive') {
    parts.push('comments removed');
  }

  if (redactLevel === 'off') {
    parts.push('secrets NOT hidden');
  } else if (redactLevel === 'strict') {
    parts.push('strict secret hiding');
  } else if (redactLevel === 'standard') {
    parts.push('secrets hidden');
  }

  const limit = Number(chunkLimit) || 0;
  if (limit > 0) {
    parts.push(`split at ${Math.round(limit / 1000)}k`);
  }

  return parts.join(' · ');
}
