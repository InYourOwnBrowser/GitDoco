import { externalLink } from './links.js';
/**
 * Generates an ASCII directory topology from a list of relative file paths.
 */
export function generateTree(paths) {
    const tree = Object.create(null);
    for (const path of paths) {
        let current = tree;
        for (const part of path.split('/')) {
            if (!Object.prototype.hasOwnProperty.call(current, part) || typeof current[part] !== 'object' || current[part] === null) {
                current[part] = Object.create(null);
            }
            current = current[part];
        }
    }

    function print(node, prefix = '') {
        let out = '';
        const keys = Object.keys(node);
        keys.forEach((k, idx) => {
            const isLast = idx === keys.length - 1;
            out += `${prefix}${isLast ? '└── ' : '├── '}${k}\n`;
            out += print(node[k], prefix + (isLast ? '    ' : '│   '));
        });
        return out;
    }

    return print(tree);
}

function calculateDirSize(dirItem) {
    if (typeof dirItem._cachedSize === 'number') return dirItem._cachedSize;
    let sum = 0;
    if (!dirItem || !dirItem.children) return 0;
    for (const key of Object.keys(dirItem.children)) {
        const child = dirItem.children[key];
        if (child.isDir) {
            sum += calculateDirSize(child);
        } else {
            sum += child.size || 0;
        }
    }
    dirItem._cachedSize = sum;
    return sum;
}

function getMaxSiblingSize(siblingsMap) {
    let max = 1;
    for (const k of Object.keys(siblingsMap)) {
        const child = siblingsMap[k];
        const sz = child.isDir ? calculateDirSize(child) : (child.size || 0);
        if (sz > max) max = sz;
    }
    return max;
}

function matchQuery(name, path, query) {
    if (!query) return true;
    const nameLower = name.toLowerCase();
    const pathLower = path.toLowerCase();
    const qLower = query.toLowerCase();

    if (qLower.startsWith('*.')) {
        const ext = qLower.slice(1);
        return nameLower.endsWith(ext) || pathLower.endsWith(ext);
    }
    if (qLower.includes('*')) {
        const regexStr = '^' + qLower.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$';
        try {
            const re = new RegExp(regexStr);
            return re.test(nameLower) || re.test(pathLower);
        } catch (_) {}
    }
    return nameLower.includes(qLower) || pathLower.includes(qLower);
}

const SVG_FOLDER = `<svg class="svg-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`;
const SVG_FILE = `<svg class="svg-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>`;
const SVG_CHEVRON_DOWN = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>`;
const SVG_CHEVRON_RIGHT = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"></polyline></svg>`;

/**
 * @param {object} [options]
 * @param {(path: string) => (string|null)} [options.fileUrl] link for each file row (e.g. the file on GitHub)
 */
export function renderInteractiveTree(nodes, container, onSelectionChange, largeThresholdKb = 50, options = {}) {
    container.innerHTML = '';

    const root = { name: '', isDir: true, children: Object.create(null), path: '' };

    for (const node of nodes) {
        const parts = node.path.split('/');
        let current = root;
        let currPath = '';

        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            currPath = currPath ? `${currPath}/${part}` : part;
            const isLast = i === parts.length - 1;

            if (isLast && node.type === 'blob') {
                current.children[part] = {
                    name: part,
                    isDir: false,
                    path: node.path,
                    size: node.size || 0,
                    node: node
                };
            } else {
                if (!Object.prototype.hasOwnProperty.call(current.children, part)) {
                    current.children[part] = {
                        name: part,
                        isDir: true,
                        path: currPath,
                        children: Object.create(null)
                    };
                }
                current = current.children[part];
            }
        }
    }

    let isFirstRow = true;
    let allTreeRows = [];
    let allNodeItems = [];
    let currentLargeThresholdBytes = largeThresholdKb * 1024;

    function isRowVisible(row) {
        if (row.offsetParent !== null) return true;
        let curr = row;
        while (curr && curr !== container) {
            if (curr.style && curr.style.display === 'none') return false;
            curr = curr.parentElement;
        }
        return true;
    }

    function ensureValidTabStop() {
        const visibleRows = allTreeRows.filter(isRowVisible);
        const hasValidTabStop = visibleRows.some(r => r.tabIndex === 0);
        if (!hasValidTabStop) {
            allTreeRows.forEach(r => r.tabIndex = -1);
            if (visibleRows.length > 0) {
                visibleRows[0].tabIndex = 0;
            }
        }
    }

    function createTreeNodeDOM(item, maxSiblingBytes = 1) {
        const li = document.createElement('li');
        li.className = 'tree-item';
        li.setAttribute('role', 'treeitem');

        const row = document.createElement('div');
        row.className = 'tree-row';
        row.tabIndex = isFirstRow ? 0 : -1;
        if (isFirstRow) isFirstRow = false;
        allTreeRows.push(row);

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = true;
        checkbox.className = 'tree-checkbox';
        checkbox.setAttribute('aria-label', `Select ${item.name}`);

        const label = document.createElement('span');
        label.className = item.isDir ? 'tree-folder-label' : 'tree-file-label';

        const iconSpan = document.createElement('span');
        iconSpan.innerHTML = item.isDir ? SVG_FOLDER : SVG_FILE;

        const nameSpan = document.createElement('span');
        nameSpan.textContent = item.name;

        label.appendChild(iconSpan);
        label.appendChild(nameSpan);

        // Files link to their page on GitHub. Not a tab stop: the tree is navigated by rows.
        const fileHref = !item.isDir && options.fileUrl ? options.fileUrl(item.path) : null;
        const fileLink = fileHref ? externalLink(fileHref, '', { title: `Open ${item.path} on GitHub`, className: 'ext-link tree-file-link', focusable: false }) : null;

        const bytes = item.isDir ? calculateDirSize(item) : (item.size || 0);
        const pct = Math.max(4, Math.round((bytes / Math.max(1, maxSiblingBytes)) * 100));

        const weightBg = document.createElement('span');
        weightBg.className = 'tree-weight-bar-bg';
        const weightFill = document.createElement('span');
        const isLarge = !item.isDir && bytes > currentLargeThresholdBytes;
        weightFill.className = 'tree-weight-bar-fill' + (isLarge ? ' near' : '');
        weightFill.style.width = `${pct}%`;
        weightBg.appendChild(weightFill);

        const sizeBadge = document.createElement('span');
        const kbStr = bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
        const estTok = Math.round(bytes / 3.8);
        sizeBadge.className = 'tree-size-badge' + (isLarge ? ' tree-large-badge' : '');
        sizeBadge.textContent = isLarge ? `${kbStr} (~${estTok.toLocaleString()} tok) [Large]` : `${kbStr} (~${estTok.toLocaleString()} tok)`;

        if (!item.isDir) {
            allNodeItems.push({
                isDir: false,
                bytes,
                kbStr,
                estTok,
                weightFill,
                sizeBadge
            });
        }

        row.appendChild(checkbox);
        row.appendChild(label);
        if (fileLink) row.appendChild(fileLink);
        row.appendChild(weightBg);
        row.appendChild(sizeBadge);
        li.appendChild(row);

        row.addEventListener('click', (e) => {
            if (e.target === checkbox) return;
            if (e.target.closest('.tree-toggle-btn')) return;
            checkbox.checked = !checkbox.checked;
            checkbox.dispatchEvent(new Event('change', { bubbles: true }));
        });

        // Roving tabindex navigation
        row.addEventListener('focus', () => {
            allTreeRows.forEach(r => r.tabIndex = -1);
            row.tabIndex = 0;
        });

        if (item.isDir) {
            li.setAttribute('aria-expanded', 'true');
            const toggleBtn = document.createElement('button');
            toggleBtn.type = 'button';
            toggleBtn.className = 'tree-toggle-btn';
            toggleBtn.setAttribute('aria-label', `Toggle folder ${item.name}`);
            toggleBtn.innerHTML = SVG_CHEVRON_DOWN;
            row.insertBefore(toggleBtn, label);

            const ul = document.createElement('ul');
            ul.className = 'tree-children';
            ul.setAttribute('role', 'group');

            let isExpanded = true;
            const toggleExpand = (expand) => {
                isExpanded = typeof expand === 'boolean' ? expand : !isExpanded;
                ul.style.display = isExpanded ? 'block' : 'none';
                toggleBtn.innerHTML = isExpanded ? SVG_CHEVRON_DOWN : SVG_CHEVRON_RIGHT;
                li.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
                ensureValidTabStop();
            };

            toggleBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleExpand();
            });

            const childKeys = Object.keys(item.children).sort((a, b) => {
                const aIsDir = item.children[a].isDir;
                const bIsDir = item.children[b].isDir;
                if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
                return a.localeCompare(b);
            });

            const maxChildSiblingBytes = getMaxSiblingSize(item.children);
            const childElements = [];
            for (const key of childKeys) {
                const childItem = item.children[key];
                const childDOM = createTreeNodeDOM(childItem, maxChildSiblingBytes);
                ul.appendChild(childDOM.li);
                childElements.push(childDOM);
            }

            li.appendChild(ul);

            checkbox.addEventListener('change', () => {
                const isChecked = checkbox.checked;
                for (const child of childElements) {
                    child.setSubtreeChecked(isChecked);
                }
                updateSelectionState();
            });

            row.addEventListener('keydown', (e) => {
                if (e.key === ' ' || e.key === 'Spacebar' || e.key === 'Enter') {
                    e.preventDefault();
                    checkbox.checked = !checkbox.checked;
                    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
                } else if (e.key === 'ArrowRight') {
                    e.preventDefault();
                    if (!isExpanded) toggleExpand(true);
                } else if (e.key === 'ArrowLeft') {
                    e.preventDefault();
                    if (isExpanded) toggleExpand(false);
                } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    const visibleRows = allTreeRows.filter(isRowVisible);
                    const idx = visibleRows.indexOf(row);
                    if (idx !== -1) {
                        const targetIdx = idx + (e.key === 'ArrowDown' ? 1 : -1);
                        if (visibleRows[targetIdx]) {
                            visibleRows[targetIdx].focus();
                        }
                    }
                } else if (e.key === 'Home') {
                    e.preventDefault();
                    const visibleRows = allTreeRows.filter(isRowVisible);
                    if (visibleRows.length > 0) {
                        visibleRows[0].focus();
                    }
                } else if (e.key === 'End') {
                    e.preventDefault();
                    const visibleRows = allTreeRows.filter(isRowVisible);
                    if (visibleRows.length > 0) {
                        visibleRows[visibleRows.length - 1].focus();
                    }
                }
            });

            return {
                li,
                checkbox,
                isDir: true,
                path: item.path,
                name: item.name,
                childElements,
                toggleExpand,
                setSubtreeChecked(val, onlyVisible = false) {
                    if (onlyVisible && li.style.display === 'none') return;
                    checkbox.checked = val;
                    for (const child of childElements) {
                        child.setSubtreeChecked(val, onlyVisible);
                    }
                },
                updateStateFromChildren() {
                    let allChecked = true;
                    let noneChecked = true;
                    let anyIndeterminate = false;
                    for (const child of childElements) {
                        child.updateStateFromChildren();
                        if (child.checkbox.indeterminate) {
                            anyIndeterminate = true;
                            allChecked = false;
                            noneChecked = false;
                        } else if (child.checkbox.checked) {
                            noneChecked = false;
                        } else {
                            allChecked = false;
                        }
                    }
                    checkbox.checked = !noneChecked;
                    checkbox.indeterminate = anyIndeterminate || (!allChecked && !noneChecked);
                    checkbox.setAttribute('aria-checked', checkbox.indeterminate ? 'mixed' : (checkbox.checked ? 'true' : 'false'));
                },
                collectSelectedFiles(acc) {
                    for (const child of childElements) {
                        child.collectSelectedFiles(acc);
                    }
                },
                deselectIfLargerThan(thresholdBytes) {
                    for (const child of childElements) {
                        if (child.deselectIfLargerThan) child.deselectIfLargerThan(thresholdBytes);
                    }
                },
                expandAll(val) {
                    toggleExpand(val);
                    for (const child of childElements) {
                        if (child.expandAll) child.expandAll(val);
                    }
                },
                applyFilter(query, isSubpath = false) {
                    let matchingFiles = 0;
                    if (isSubpath) {
                        const clean = (query || '').replace(/^\/+|\/+$/g, '').toLowerCase();
                        const pLower = item.path.toLowerCase();
                        const selfMatches = pLower === clean || pLower.startsWith(clean + '/') || clean.startsWith(pLower + '/');
                        for (const child of childElements) {
                            matchingFiles += child.applyFilter(query, true);
                        }
                        const isVisible = !clean || selfMatches || matchingFiles > 0;
                        li.style.display = isVisible ? 'block' : 'none';
                        if (query && isVisible) toggleExpand(true);
                    } else {
                        const selfMatches = matchQuery(item.name, item.path, query);
                        for (const child of childElements) {
                            matchingFiles += child.applyFilter(query, false);
                        }
                        const isVisible = !query || selfMatches || matchingFiles > 0;
                        li.style.display = isVisible ? 'block' : 'none';
                        if (query && isVisible) toggleExpand(true);
                    }
                    return matchingFiles;
                }
            };
        } else {
            checkbox.addEventListener('change', () => {
                updateSelectionState();
            });

            row.addEventListener('keydown', (e) => {
                if (e.key === ' ' || e.key === 'Spacebar' || e.key === 'Enter') {
                    e.preventDefault();
                    checkbox.checked = !checkbox.checked;
                    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
                } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    const visibleRows = allTreeRows.filter(isRowVisible);
                    const idx = visibleRows.indexOf(row);
                    if (idx !== -1) {
                        const targetIdx = idx + (e.key === 'ArrowDown' ? 1 : -1);
                        if (visibleRows[targetIdx]) {
                            visibleRows[targetIdx].focus();
                        }
                    }
                } else if (e.key === 'Home') {
                    e.preventDefault();
                    const visibleRows = allTreeRows.filter(isRowVisible);
                    if (visibleRows.length > 0) {
                        visibleRows[0].focus();
                    }
                } else if (e.key === 'End') {
                    e.preventDefault();
                    const visibleRows = allTreeRows.filter(isRowVisible);
                    if (visibleRows.length > 0) {
                        visibleRows[visibleRows.length - 1].focus();
                    }
                }
            });

            return {
                li,
                checkbox,
                isDir: false,
                path: item.path,
                name: item.name,
                setSubtreeChecked(val, onlyVisible = false) {
                    if (onlyVisible && li.style.display === 'none') return;
                    checkbox.checked = val;
                },
                deselectIfLargerThan(thresholdBytes) {
                    if (!item.isDir && item.size > thresholdBytes) {
                        checkbox.checked = false;
                    }
                },
                updateStateFromChildren() {},
                collectSelectedFiles(acc) {
                    if (checkbox.checked) {
                        acc.push(item.node);
                    }
                },
                applyFilter(query, isSubpath = false) {
                    let matches = false;
                    if (isSubpath) {
                        const clean = (query || '').replace(/^\/+|\/+$/g, '').toLowerCase();
                        const pLower = item.path.toLowerCase();
                        matches = !clean || pLower === clean || pLower.startsWith(clean + '/');
                    } else {
                        matches = !query || matchQuery(item.name, item.path, query);
                    }
                    li.style.display = matches ? 'block' : 'none';
                    return matches ? 1 : 0;
                }
            };
        }
    }

    const rootUl = document.createElement('ul');
    rootUl.className = 'tree-root';
    rootUl.setAttribute('role', 'tree');

    const rootChildKeys = Object.keys(root.children).sort((a, b) => {
        const aIsDir = root.children[a].isDir;
        const bIsDir = root.children[b].isDir;
        if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
        return a.localeCompare(b);
    });

    const maxRootSiblingBytes = getMaxSiblingSize(root.children);
    const rootNodes = [];
    for (const key of rootChildKeys) {
        const childDOM = createTreeNodeDOM(root.children[key], maxRootSiblingBytes);
        rootUl.appendChild(childDOM.li);
        rootNodes.push(childDOM);
    }

    container.appendChild(rootUl);

    function getSelectedNodes() {
        const selected = [];
        for (const rn of rootNodes) {
            rn.collectSelectedFiles(selected);
        }
        return selected;
    }

    function updateSelectionState() {
        for (const rn of rootNodes) {
            rn.updateStateFromChildren();
        }
        if (onSelectionChange) {
            onSelectionChange(getSelectedNodes());
        }
    }

    let currentQuery = '';

    function getSelectedStats() {
        const selected = getSelectedNodes();
        let totalBytes = 0;
        for (const n of selected) {
            totalBytes += n.size || 0;
        }
        const estTokens = Math.round(totalBytes / 3.8);
        return { count: selected.length, bytes: totalBytes, estTokens };
    }

    return {
        getSelectedNodes,
        getSelectedStats,
        setLargeThresholdKb(kbVal) {
            currentLargeThresholdBytes = kbVal * 1024;
            for (const nodeItem of allNodeItems) {
                if (!nodeItem.isDir) {
                    const isLarge = nodeItem.bytes > currentLargeThresholdBytes;
                    nodeItem.weightFill.className = 'tree-weight-bar-fill' + (isLarge ? ' near' : '');
                    nodeItem.sizeBadge.className = 'tree-size-badge' + (isLarge ? ' tree-large-badge' : '');
                    nodeItem.sizeBadge.textContent = isLarge
                        ? `${nodeItem.kbStr} (~${nodeItem.estTok.toLocaleString()} tok) [Large]`
                        : `${nodeItem.kbStr} (~${nodeItem.estTok.toLocaleString()} tok)`;
                }
            }
        },
        selectAll(val) {
            const hasFilter = Boolean(currentQuery);
            for (const rn of rootNodes) {
                rn.setSubtreeChecked(val, hasFilter);
            }
            updateSelectionState();
        },
        setPathsChecked(paths, checked = false) {
            const pathSet = new Set(Array.isArray(paths) ? paths : [paths]);
            function walk(node) {
                if (!node.isDir) {
                    if (pathSet.has(node.path)) {
                        node.checkbox.checked = checked;
                    }
                } else if (node.childElements) {
                    for (const child of node.childElements) {
                        walk(child);
                    }
                }
            }
            for (const rn of rootNodes) {
                walk(rn);
            }
            updateSelectionState();
        },
        deselectLarge(thresholdBytes) {
            for (const rn of rootNodes) {
                if (rn.deselectIfLargerThan) rn.deselectIfLargerThan(thresholdBytes);
            }
            updateSelectionState();
        },
        expandAll(val) {
            for (const rn of rootNodes) {
                if (rn.expandAll) rn.expandAll(val);
            }
            ensureValidTabStop();
        },
        filter(query, isSubpath = false) {
            currentQuery = (query || '').trim();
            let visibleCount = 0;
            for (const rn of rootNodes) {
                visibleCount += rn.applyFilter(currentQuery, isSubpath);
            }
            ensureValidTabStop();
            return visibleCount;
        },
        selectBySubpath(subpath) {
            const clean = (subpath || '').trim().replace(/^\/+|\/+$/g, '');
            if (!clean) return;
            function walk(node) {
                if (!node.isDir) {
                    const matches = node.path === clean || node.path.startsWith(clean + '/');
                    node.checkbox.checked = matches;
                } else {
                    if (node.childElements) {
                        for (const child of node.childElements) {
                            walk(child);
                        }
                    }
                    if (node.updateStateFromChildren) {
                        node.updateStateFromChildren();
                    }
                }
            }
            for (const rn of rootNodes) {
                walk(rn);
            }
            updateSelectionState();
        }
    };
}
