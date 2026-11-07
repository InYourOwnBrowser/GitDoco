/**
 * Builds summary lines for the build summary card.
 *
 * @param {Object} options
 * @param {string} options.kind - 'issues', 'discussions' or 'files'
 * @param {number} options.items - Number of items included
 * @param {number} [options.comments] - Number of comments included (issues and discussions)
 * @param {number} options.tokens - Estimated tokens
 * @param {number} [options.parts] - Number of output parts
 * @param {number} [options.secretsHidden] - Number of hidden secrets
 * @param {number} [options.warnings] - Number of warnings
 * @returns {string[]} Array of summary line strings
 */
export function buildSummaryLines({
    kind = 'files',
    items = 0,
    comments = 0,
    tokens = 0,
    parts = 1,
    secretsHidden = 0,
    warnings = 0
} = {}) {
    const lines = [];

    const hasComments = kind === 'issues' || kind === 'discussions';
    let line1 = `${items} ${hasComments ? kind : 'files'} included`;
    if (hasComments) {
        line1 += ` · ${comments} comments`;
    }
    lines.push(line1);

    let line2 = `About ${tokens.toLocaleString()} tokens (estimated)`;
    if (parts > 1) {
        line2 += ` · ${parts} parts`;
    }
    lines.push(line2);

    if (secretsHidden > 0) {
        lines.push(`${secretsHidden} possible secret(s) hidden`);
    }

    if (warnings > 0) {
        lines.push(`${warnings} warning(s) above`);
    }

    return lines;
}
