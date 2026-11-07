/**
 * Output Schemas for LLM Context Packaging
 */

export function stripXmlInvalidChars(str) {
    if (!str) return '';
    return String(str).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x84\x86-\x9F]/g, '');
}

export function escapeXml(str) {
    if (!str) return '';
    return stripXmlInvalidChars(String(str))
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

export function escapeCdata(str) {
    if (!str) return '';
    return stripXmlInvalidChars(String(str)).replace(/\]\]\>/g, ']]]]><![CDATA[>');
}

export function getMarkdownFence(content) {
    if (!content) return '```';
    const matches = content.match(/`+/g);
    if (!matches) return '```';
    let maxLen = 0;
    for (const m of matches) {
        if (m.length > maxLen) maxLen = m.length;
    }
    const fenceLen = Math.max(3, maxLen + 1);
    return '`'.repeat(fenceLen);
}

// Local .zip archives have no owner, so they are named by the archive alone.
function repoDisplayName(repoInfo) {
    return repoInfo.owner ? `${repoInfo.owner}/${repoInfo.repo}` : repoInfo.repo;
}

export function formatClaudeXml(repoInfo, branch, treeText, files, options = {}) {
    const startIndex = (options && options.startIndex) || 1;
    let doc = `<documents>\n`;
    doc += `  <!-- Global Repository Context -->\n`;
    doc += `  <context>\n`;
    if (options && options.partNote) {
        doc += `    <note>${escapeXml(options.partNote)}</note>\n`;
    }
    if (options && options.failedFilesCount > 0) {
        doc += `    <warnings>${options.failedFilesCount} file(s) failed to download and were excluded.</warnings>\n`;
    }
    doc += `    <repository>${escapeXml(repoDisplayName(repoInfo))}</repository>\n`;
    if (branch) doc += `    <branch>${escapeXml(branch)}</branch>\n`;
    if (repoInfo.source) doc += `    <source>${escapeXml(repoInfo.source)}</source>\n`;
    if (repoInfo.url) {
        doc += `    <url>${escapeXml(repoInfo.url)}</url>\n`;
    }
    if (treeText) {
        doc += `    <structure>\n${escapeXml(treeText)}    </structure>\n`;
    }
    doc += `  </context>\n\n`;

    files.forEach((file, idx) => {
        doc += `  <document index="${startIndex + idx}">\n`;
        doc += `    <source>${escapeXml(file.path)}</source>\n`;
        let contentStr = stripXmlInvalidChars(file.content || '');
        if (contentStr.includes('</document_content>') || contentStr.includes('</document>') || contentStr.includes('<') || contentStr.includes('&') || contentStr.includes(']]>')) {
            contentStr = `<![CDATA[\n${escapeCdata(contentStr)}\n]]>`;
        }
        doc += `    <document_content>\n${contentStr}\n    </document_content>\n`;
        doc += `  </document>\n`;
    });

    if (options && options.instructions && options.instructions.trim()) {
        let instStr = stripXmlInvalidChars(options.instructions.trim());
        if (instStr.includes('</instructions>') || instStr.includes('<') || instStr.includes('&') || instStr.includes(']]>')) {
            instStr = `<![CDATA[\n${escapeCdata(instStr)}\n]]>`;
        } else {
            instStr = escapeXml(instStr);
        }
        doc += `  <instructions>\n${instStr}\n  </instructions>\n`;
    }

    doc += `</documents>`;
    return {
        text: doc,
        ext: 'xml',
        mime: 'application/xml'
    };
}

export function formatMarkdown(repoInfo, branch, treeText, files, options = {}) {
    const treeFence = getMarkdownFence(treeText);
    let md = '';
    if (options && options.partNote) {
        md += `Note: ${options.partNote}\n\n`;
    }
    if (options && options.failedFilesCount > 0) {
        md += `> **Warning:** ${options.failedFilesCount} file(s) failed to download and were excluded.\n\n`;
    }
    md += `# Repository: ${repoDisplayName(repoInfo)}\n`;
    if (branch) md += `Branch: ${branch}\n`;
    if (repoInfo.source) md += `Source: ${repoInfo.source}\n`;
    if (repoInfo.url) {
        md += `Source URL: ${repoInfo.url}\n`;
    }
    if (treeText) {
        md += `\n## Structure\n${treeFence}text\n${treeText}${treeFence}\n\n`;
    }
    md += `## Files\n\n`;
    for (const file of files) {
        const filename = file.path.split('/').pop();
        const ext = filename.includes('.') ? filename.split('.').pop() : '';
        const fence = getMarkdownFence(file.content);
        const pathFence = file.path.includes('`') ? '`` ' + file.path + ' ``' : '`' + file.path + '`';
        md += `### File: ${pathFence}\n${fence}${ext}\n${file.content}\n${fence}\n\n`;
    }

    if (options && options.instructions && options.instructions.trim()) {
        const fence = getMarkdownFence(options.instructions.trim());
        md += `## Instructions\n\n${fence}text\n${options.instructions.trim()}\n${fence}\n`;
    }

    return {
        text: md,
        ext: 'md',
        mime: 'text/markdown'
    };
}

export function formatGenericXml(repoInfo, branch, treeText, files, options = {}) {
    let xml = `<repository name="${escapeXml(repoDisplayName(repoInfo))}"${branch ? ` branch="${escapeXml(branch)}"` : ''}${repoInfo.source ? ` source="${escapeXml(repoInfo.source)}"` : ''}${repoInfo.url ? ` url="${escapeXml(repoInfo.url)}"` : ''}>\n`;
    if (options && options.partNote) {
        xml += `<note>${escapeXml(options.partNote)}</note>\n`;
    }
    if (options && options.failedFilesCount > 0) {
        xml += `<warnings>${options.failedFilesCount} file(s) failed to download and were excluded.</warnings>\n`;
    }
    if (treeText) {
        xml += `<structure>\n${escapeXml(treeText)}</structure>\n`;
    }
    xml += `<files>\n`;
    for (const file of files) {
        xml += `<file path="${escapeXml(file.path)}">\n<![CDATA[\n${escapeCdata(stripXmlInvalidChars(file.content))}\n]]>\n</file>\n`;
    }
    xml += `</files>\n`;

    if (options && options.instructions && options.instructions.trim()) {
        let instStr = stripXmlInvalidChars(options.instructions.trim());
        if (instStr.includes('</instructions>') || instStr.includes('<') || instStr.includes('&') || instStr.includes(']]>')) {
            instStr = `<![CDATA[\n${escapeCdata(instStr)}\n]]>`;
        } else {
            instStr = escapeXml(instStr);
        }
        xml += `<instructions>\n${instStr}\n</instructions>\n`;
    }

    xml += `</repository>`;
    return {
        text: xml,
        ext: 'xml',
        mime: 'application/xml'
    };
}

export function formatJson(repoInfo, branch, treeText, files, options = {}) {
    const jsonObj = {
        repository: repoDisplayName(repoInfo),
        ...(branch ? { branch } : {}),
        ...(repoInfo.source ? { source: repoInfo.source } : {}),
        ...(options && options.partNote ? { note: options.partNote } : {}),
        ...(options && options.failedFilesCount > 0 ? { warnings: `${options.failedFilesCount} file(s) failed to download and were excluded.` } : {}),
        ...(repoInfo.url ? { url: repoInfo.url } : {}),
        ...(treeText ? { structure: treeText } : {}),
        files,
        ...(options && options.instructions && options.instructions.trim() ? { instructions: options.instructions.trim() } : {})
    };
    const json = JSON.stringify(jsonObj, null, 2);
    return {
        text: json,
        ext: 'json',
        mime: 'application/json'
    };
}

export function chunkContextOutput(format, repoInfo, branch, treeText, files, chunkTokenLimit, estimateTokensFn, options = {}) {
    const rawInstructions = (options && options.instructions) || '';
    const instructions = rawInstructions.trim();

    if (!chunkTokenLimit || chunkTokenLimit <= 0) {
        const output = buildContextOutput(format, repoInfo, branch, treeText, files, { ...options, instructions });
        output.exceedsLimit = false;
        return [output];
    }

    const cleanOpts = { ...options, instructions: '' };
    const emptyChunkBase = buildContextOutput(format, repoInfo, branch, '', [], cleanOpts);
    const emptyChunkTokens = estimateTokensFn(emptyChunkBase.text);

    // Measure instructions token overhead
    let instructionsOverhead = 0;
    if (instructions) {
        const withInst = buildContextOutput(format, repoInfo, branch, '', [], { ...options, instructions });
        instructionsOverhead = estimateTokensFn(withInst.text) - emptyChunkTokens;
    }

    // Measure only the marginal token cost of each file
    const fileTokenEstimates = files.map(file => {
        const singleFileOutput = buildContextOutput(format, repoInfo, branch, '', [file], cleanOpts);
        return Math.max(1, estimateTokensFn(singleFileOutput.text) - emptyChunkTokens);
    });

    const firstChunkBase = buildContextOutput(format, repoInfo, branch, treeText, [], cleanOpts);
    const baseWrapperTokens = estimateTokensFn(firstChunkBase.text);

    const chunks = [];
    let currentFiles = [];
    let currentStartIndex = 1;
    let runningTokens = baseWrapperTokens;

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const fileTokens = fileTokenEstimates[i];

        if (currentFiles.length > 0 && (runningTokens + fileTokens > chunkTokenLimit)) {
            chunks.push({ files: currentFiles, startIndex: currentStartIndex });
            currentStartIndex += currentFiles.length;
            currentFiles = [file];
            runningTokens = emptyChunkTokens + fileTokens;
        } else {
            currentFiles.push(file);
            runningTokens += fileTokens;
        }
    }

    if (currentFiles.length > 0) {
        chunks.push({ files: currentFiles, startIndex: currentStartIndex });
    }

    // Re-check final chunk with instructions overhead
    if (instructions && chunks.length > 0) {
        let lastChunk = chunks[chunks.length - 1];
        let lastTree = chunks.length === 1 ? treeText : '';
        let lastOpts = { ...options, startIndex: lastChunk.startIndex, instructions, partNote: chunks.length > 1 ? `Part ${chunks.length} of ${chunks.length}.` : '' };
        let lastOutput = buildContextOutput(format, repoInfo, branch, lastTree, lastChunk.files, lastOpts);

        while (estimateTokensFn(lastOutput.text) > chunkTokenLimit) {
            if (lastChunk.files.length > 1) {
                const spilled = lastChunk.files.pop();
                chunks.push({ files: [spilled], startIndex: lastChunk.startIndex + lastChunk.files.length });
                lastChunk = chunks[chunks.length - 1];
                lastTree = '';
                lastOpts = { ...options, startIndex: lastChunk.startIndex, instructions, partNote: `Part ${chunks.length} of ${chunks.length}.` };
                lastOutput = buildContextOutput(format, repoInfo, branch, lastTree, lastChunk.files, lastOpts);
            } else if (lastChunk.files.length === 1) {
                chunks.push({ files: [], startIndex: lastChunk.startIndex + 1 });
                lastChunk = chunks[chunks.length - 1];
                lastTree = '';
                lastOpts = { ...options, startIndex: lastChunk.startIndex, instructions, partNote: `Part ${chunks.length} of ${chunks.length}.` };
                lastOutput = buildContextOutput(format, repoInfo, branch, lastTree, lastChunk.files, lastOpts);
            } else {
                break;
            }
        }
    }

    const N = chunks.length;
    const finalChunks = chunks.map((c, idx) => {
        const isLast = (idx === N - 1);
        const chunkOpts = {
            ...options,
            startIndex: c.startIndex,
            instructions: isLast ? instructions : '',
            partNote: (N > 1 && !isLast) ? `Part ${idx + 1} of ${N}. Instructions are in part ${N}.` : ''
        };
        const treeForChunk = idx === 0 ? treeText : '';
        const chunkOutput = buildContextOutput(format, repoInfo, branch, treeForChunk, c.files, chunkOpts);
        chunkOutput.exceedsLimit = estimateTokensFn(chunkOutput.text) > chunkTokenLimit;
        return chunkOutput;
    });

    return finalChunks;
}

export function buildContextOutput(format, repoInfo, branch, treeText, files, options = {}) {
    switch (format) {
        case 'claude-xml':
            return formatClaudeXml(repoInfo, branch, treeText, files, options);
        case 'markdown':
            return formatMarkdown(repoInfo, branch, treeText, files, options);
        case 'generic-xml':
            return formatGenericXml(repoInfo, branch, treeText, files, options);
        case 'json':
            return formatJson(repoInfo, branch, treeText, files, options);
        default:
            return formatClaudeXml(repoInfo, branch, treeText, files, options);
    }
}
