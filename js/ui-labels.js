/**
 * Shared UI label helpers.
 */

/**
 * Returns copy button label based on chunk index and part count.
 *
 * @param {number} partIndex 0-based index of current chunk
 * @param {number} totalParts total number of chunks
 * @returns {string}
 */
export function copyLabel(partIndex, totalParts) {
    if (!totalParts || totalParts <= 1) {
        return 'Copy';
    }
    return `Copy part ${partIndex + 1} of ${totalParts}`;
}
