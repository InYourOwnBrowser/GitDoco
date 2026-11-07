/**
 * Interactive dependency graph for the Dependencies tool.
 *
 * Three parts, all in this one file:
 *   toGraphData(...)   the packages and edges from resolveLicenses -> plain, serialisable data
 *   layoutGraph(...)   which nodes are shown and where (layered left to right by depth)
 *   mountGraph(...)    an SVG view with pan/zoom, search, expand/collapse, path highlighting
 *                      and a details panel
 *
 * This file has NO imports and touches nothing outside the element it is given, because the
 * standalone HTML export (js/dep-graph-export.js) inlines it into a self-contained page.
 *
 * Package names, versions, licenses and advisory titles come from repositories and registries,
 * so they are untrusted: they are only ever set with textContent / setAttribute, never as markup,
 * and links are only followed when they are https:// URLs built by js/links.js.
 */

export const ROOT_ID = 0;
/** Graphs larger than this open collapsed below the direct dependencies. */
export const AUTO_EXPAND_LIMIT = 250;

const NODE_W = 190;
const NODE_H = 26;
const ROW_H = 34;
const COL_GAP = 80;
const SVG_NS = 'http://www.w3.org/2000/svg';
const PROBLEM_GROUPS = new Set(['restricted', 'strong-copyleft']);
const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1, unknown: 1 };

// ------------------------------------------------------------------ data

/**
 * Builds the graph data. Node 0 is the project itself.
 * @param {object} args
 * @param {object[]} args.packages     from resolveLicenses
 * @param {[string,string][]} args.edges [fromKey, toKey]; fromKey === rootKey for direct dependencies
 * @param {string} args.rootKey         the key resolveLicenses uses for the project (ROOT_KEY)
 * @param {string} args.label           the project's name, e.g. "owner/repo"
 * @param {object} [args.groupLabels]   license group -> label
 * @param {(p: object) => object} [args.links]  package -> { url, advisoryUrl(id) } (https only)
 * @returns {{ label: string, nodes: object[], edges: [number, number][] }}
 */
export function toGraphData({ packages, edges, rootKey, label, groupLabels = {}, links = null }) {
    const nodes = [{ id: ROOT_ID, root: true, name: label || 'project', version: '', group: 'root', relation: 'root' }];
    const idOf = new Map([[rootKey, ROOT_ID]]);
    for (const p of packages || []) {
        if (idOf.has(p.key)) continue;
        const l = links ? links(p) : null;
        const advisories = (p.advisoryDetails && p.advisoryDetails.length ? p.advisoryDetails : (p.advisories || []).map(id => ({ id })))
            .map(a => ({
                id: String(a.id || ''),
                severity: a.severity || 'unknown',
                title: String(a.title || ''),
                score: typeof a.score === 'number' ? a.score : null,
                url: safeUrl(l && l.advisoryUrl ? l.advisoryUrl(a.id) : '')
            }));
        const node = {
            id: nodes.length,
            name: String(p.name || ''),
            version: p.version ? String(p.version) : '',
            ecosystem: String(p.ecosystem || ''),
            relation: p.relation === 'direct' ? 'direct' : 'transitive',
            dev: Boolean(p.dev),
            license: (p.license && p.license.expression) ? String(p.license.expression) : '',
            group: (p.license && p.license.group) || 'unknown',
            groupLabel: groupLabels[(p.license && p.license.group) || 'unknown'] || '',
            advisories,
            severity: p.maxSeverity || (advisories.length ? 'unknown' : null),
            verdict: p.policy && p.policy.verdict && p.policy.verdict !== 'allow' ? p.policy.verdict : null,
            outdated: Boolean(p.outdated),
            latest: p.latest ? String(p.latest) : '',
            checked: p.status === 'ok',
            url: safeUrl(l ? l.url : '')
        };
        idOf.set(p.key, node.id);
        nodes.push(node);
    }
    const seen = new Set();
    const out = [];
    for (const [from, to] of edges || []) {
        const a = idOf.get(from), b = idOf.get(to);
        if (a === undefined || b === undefined || a === b || b === ROOT_ID) continue;
        const k = `${a}>${b}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push([a, b]);
    }
    // Packages nothing points to (e.g. Pipfile.lock, Go "// indirect") hang off the project,
    // marked so the view can say their parent is not known.
    const hasParent = new Set(out.map(e => e[1]));
    for (const n of nodes) {
        if (n.id !== ROOT_ID && !hasParent.has(n.id)) {
            if (n.relation !== 'direct') n.unlinked = true;
            out.push([ROOT_ID, n.id]);
        }
    }
    return { label: nodes[0].name, nodes, edges: out };
}

function safeUrl(u) {
    return typeof u === 'string' && /^https:\/\/[^\s"'<>]+$/.test(u) ? u : '';
}

/** A node "needs attention": advisories, blocked or flagged by policy, or a copyleft/restricted license. */
export function isProblem(n) {
    return Boolean(n && !n.root && ((n.advisories && n.advisories.length) || n.verdict || PROBLEM_GROUPS.has(n.group)));
}

/** Adjacency lists, depth from the project (shortest path) and the BFS parent of every node. */
export function indexGraph(data) {
    const n = data.nodes.length;
    const children = Array.from({ length: n }, () => []);
    const parents = Array.from({ length: n }, () => []);
    for (const [a, b] of data.edges) { children[a].push(b); parents[b].push(a); }
    const depth = new Array(n).fill(-1);
    const via = new Array(n).fill(-1);
    depth[ROOT_ID] = 0;
    const queue = [ROOT_ID];
    for (let i = 0; i < queue.length; i++) {
        const id = queue[i];
        for (const c of children[id]) {
            if (depth[c] !== -1) continue;
            depth[c] = depth[id] + 1;
            via[c] = id;
            queue.push(c);
        }
    }
    return { children, parents, depth, via };
}

/** Shortest chain of node ids from the project to `id` (inclusive), or [] if unreachable. */
export function pathTo(index, id) {
    const out = [];
    for (let cur = id; cur !== -1; cur = cur === ROOT_ID ? -1 : index.via[cur]) {
        out.unshift(cur);
        if (out.length > index.depth.length) return [];
    }
    return out[0] === ROOT_ID ? out : [];
}

/** The ids to start expanded: everything for a small graph, else the project and its direct dependencies. */
export function defaultExpanded(data, index) {
    if (data.nodes.length <= AUTO_EXPAND_LIMIT) return new Set(data.nodes.map(n => n.id));
    return new Set([ROOT_ID, ...index.children[ROOT_ID]]);
}

// ------------------------------------------------------------------ layout

/**
 * Which nodes are shown and where.
 * @param {object} data   from toGraphData
 * @param {object} index  from indexGraph
 * @param {object} view   { expanded: Set<id>, problemsOnly: boolean }
 * @returns {{ nodes: Map<id, {x, y, depth, hidden}>, edges: [number, number][], width, height }}
 *   `hidden` is how many children a collapsed node has that are not shown.
 */
export function layoutGraph(data, index, { expanded = new Set([ROOT_ID]), problemsOnly = false } = {}) {
    let allowed = null;
    if (problemsOnly) {
        // Problems and every node on a path from the project to one.
        allowed = new Set([ROOT_ID]);
        const stack = data.nodes.filter(isProblem).map(nd => nd.id);
        while (stack.length) {
            const id = stack.pop();
            if (allowed.has(id)) continue;
            allowed.add(id);
            for (const p of index.parents[id]) stack.push(p);
        }
    }
    const ok = id => !allowed || allowed.has(id);
    // Visible: reachable from the project through expanded nodes (all of them in problems-only mode).
    const depth = new Map([[ROOT_ID, 0]]);
    const order = [ROOT_ID];
    for (let i = 0; i < order.length; i++) {
        const id = order[i];
        if (!problemsOnly && !expanded.has(id)) continue;
        for (const c of index.children[id]) {
            if (depth.has(c) || !ok(c)) continue;
            depth.set(c, depth.get(id) + 1);
            order.push(c);
        }
    }
    const layers = [];
    for (const id of order) (layers[depth.get(id)] = layers[depth.get(id)] || []).push(id);

    // Order each layer: the first by importance, then by the average position of shown parents
    // (a few sweeps of the barycenter heuristic keep crossings down).
    const pos = new Map();
    const node = id => data.nodes[id];
    const weight = id => (isProblem(node(id)) ? 0 : 1);
    if (layers[1]) layers[1].sort((a, b) => weight(a) - weight(b) || node(a).name.localeCompare(node(b).name));
    layers.forEach(l => l.forEach((id, i) => pos.set(id, i)));
    const barycenter = (id, neighbours) => {
        const ps = neighbours[id].filter(p => pos.has(p) && depth.has(p) && depth.get(p) !== depth.get(id));
        return ps.length ? ps.reduce((s, p) => s + pos.get(p) / Math.max(1, (layers[depth.get(p)] || []).length), 0) / ps.length : 0.5;
    };
    for (let sweep = 0; sweep < 3; sweep++) {
        const down = sweep % 2 === 0;
        const range = down ? layers.map((_, i) => i).slice(2) : layers.map((_, i) => i).slice(1).reverse();
        for (const d of range) {
            const l = layers[d];
            if (!l) continue;
            const key = new Map(l.map(id => [id, barycenter(id, down ? index.parents : index.children)]));
            l.sort((a, b) => key.get(a) - key.get(b) || node(a).name.localeCompare(node(b).name));
            l.forEach((id, i) => pos.set(id, i));
        }
    }

    const tallest = Math.max(1, ...layers.map(l => l.length));
    const nodes = new Map();
    layers.forEach((l, d) => {
        const offset = ((tallest - l.length) * ROW_H) / 2;
        l.forEach((id, i) => {
            const shown = index.children[id].filter(c => depth.has(c)).length;
            const total = index.children[id].filter(ok).length;
            nodes.set(id, { x: d * (NODE_W + COL_GAP), y: offset + i * ROW_H, depth: d, hidden: Math.max(0, total - shown) });
        });
    });
    const edges = data.edges.filter(([a, b]) => nodes.has(a) && nodes.has(b));
    return { nodes, edges, width: layers.length * (NODE_W + COL_GAP) - COL_GAP, height: tallest * ROW_H, layers };
}

// ------------------------------------------------------------------ view

const shortLabel = (n, max = 26) => {
    const s = n.root ? n.name : `${n.name}${n.version ? `@${n.version}` : ''}`;
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

function el(tag, attrs = {}, text) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') e.className = v; else e.setAttribute(k, v === true ? '' : String(v));
    }
    if (text !== undefined) e.textContent = text;
    return e;
}
function svg(tag, attrs = {}) {
    const e = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) e.setAttribute(k, String(v));
    return e;
}
function extLink(url, text) {
    const href = safeUrl(url);
    if (!href) return el('span', {}, text);
    const a = el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);
    return a;
}

/**
 * Renders the graph into `container` and wires up the controls.
 * @param {HTMLElement} container
 * @param {object} data   from toGraphData
 * @param {object} [options] { onError(msg) }
 * @returns {{ destroy(): void, getSvgMarkup(): string, select(id): void, reveal(id): void }}
 */
export function mountGraph(container, data, options = {}) {
    const index = indexGraph(data);
    const state = {
        expanded: defaultExpanded(data, index),
        problemsOnly: false,
        selected: null,
        hover: null,
        matches: [],
        matchAt: -1,
        tx: 20, ty: 20, scale: 1,
        layout: null
    };
    const problemCount = data.nodes.filter(isProblem).length;

    container.textContent = '';
    container.classList.add('dg');
    const toolbar = el('div', { class: 'dg-toolbar', role: 'toolbar', 'aria-label': 'Graph controls' });
    const search = el('input', { type: 'search', class: 'dg-search', placeholder: 'Find a package…', 'aria-label': 'Find a package in the graph' });
    const matchInfo = el('span', { class: 'dg-match', 'aria-live': 'polite' });
    const btn = (text, title) => el('button', { type: 'button', class: 'dg-btn', title }, text);
    const fitBtn = btn('Fit', 'Fit the graph to the window (0)');
    const zoomIn = btn('+', 'Zoom in (+)');
    const zoomOut = btn('−', 'Zoom out (−)');
    const expandAll = btn('Expand all', 'Show every package');
    const collapseAll = btn('Collapse', 'Show only the direct dependencies');
    const problems = el('button', { type: 'button', class: 'dg-btn dg-toggle', 'aria-pressed': 'false', title: 'Show only packages with advisories, policy flags or copyleft/restricted licenses, and the paths that lead to them' }, `Problems only (${problemCount})`);
    problems.disabled = problemCount === 0;
    toolbar.append(search, matchInfo, fitBtn, zoomIn, zoomOut, expandAll, collapseAll, problems);

    const legend = el('div', { class: 'dg-legend', 'aria-label': 'Legend' });
    for (const [g, text] of [['permissive', 'Permissive'], ['weak-copyleft', 'Weak copyleft'], ['strong-copyleft', 'Strong copyleft'], ['restricted', 'Restricted'], ['unknown', 'Unknown']]) {
        const item = el('span', { class: 'dg-legend-item' });
        item.append(el('span', { class: `dg-swatch dg-g-${g}`, 'aria-hidden': 'true' }), document.createTextNode(text));
        legend.appendChild(item);
    }
    const advItem = el('span', { class: 'dg-legend-item' });
    advItem.append(el('span', { class: 'dg-swatch dg-swatch-adv', 'aria-hidden': 'true' }), document.createTextNode('Advisory'));
    const devItem = el('span', { class: 'dg-legend-item' });
    devItem.append(el('span', { class: 'dg-swatch dg-swatch-dev', 'aria-hidden': 'true' }), document.createTextNode('Dev only'));
    legend.append(advItem, devItem, el('span', { class: 'dg-hint' }, 'Drag to pan, scroll to zoom, click a package for details, double-click to expand.'));

    const body = el('div', { class: 'dg-body' });
    const stage = el('div', { class: 'dg-stage', tabindex: '0', 'aria-label': `Dependency graph of ${data.label}: ${data.nodes.length - 1} packages. Use the arrow keys to move between packages.` });
    const canvas = svg('svg', { class: 'dg-svg', role: 'img', 'aria-hidden': 'true' });
    const world = svg('g', { class: 'dg-world' });
    const edgeLayer = svg('g', { class: 'dg-edges' });
    const nodeLayer = svg('g', { class: 'dg-nodes' });
    world.append(edgeLayer, nodeLayer);
    canvas.appendChild(world);
    stage.appendChild(canvas);
    const details = el('aside', { class: 'dg-details', 'aria-live': 'polite' });
    body.append(stage, details);
    container.append(toolbar, legend, body);

    let nodeEls = new Map();
    let edgeEls = [];

    // ---------------- rendering

    function render() {
        state.layout = layoutGraph(data, index, state);
        edgeLayer.textContent = '';
        nodeLayer.textContent = '';
        nodeEls = new Map();
        edgeEls = [];
        const L = state.layout;
        for (const [a, b] of L.edges) {
            const p = L.nodes.get(a), q = L.nodes.get(b);
            const x1 = p.x + NODE_W, y1 = p.y + NODE_H / 2, x2 = q.x, y2 = q.y + NODE_H / 2;
            const back = q.depth <= p.depth;
            const d = back
                ? `M${x1},${y1} C${x1 + 60},${y1} ${x2 - 60},${y2 - 40} ${x2},${y2}`
                : `M${x1},${y1} C${(x1 + x2) / 2},${y1} ${(x1 + x2) / 2},${y2} ${x2},${y2}`;
            const path = svg('path', { d, class: `dg-edge${back ? ' dg-edge-back' : ''}${data.nodes[b].unlinked ? ' dg-edge-unknown' : ''}` });
            edgeLayer.appendChild(path);
            edgeEls.push({ a, b, path });
        }
        for (const [id, pos] of L.nodes) {
            const n = data.nodes[id];
            const g = svg('g', {
                class: `dg-node dg-g-${n.group}${n.dev ? ' dg-dev' : ''}${n.severity ? ` dg-adv dg-sev-${n.severity}` : ''}${n.verdict ? ` dg-policy-${n.verdict}` : ''}`,
                transform: `translate(${pos.x},${pos.y})`,
                'data-id': id
            });
            const title = svg('title');
            title.textContent = n.root ? n.name : `${n.name}${n.version ? `@${n.version}` : ''}${n.license ? ` · ${n.license}` : ''}${n.advisories.length ? ` · ${n.advisories.length} advisor${n.advisories.length === 1 ? 'y' : 'ies'}` : ''}`;
            g.appendChild(title);
            g.appendChild(svg('rect', { class: 'dg-box', width: NODE_W, height: NODE_H, rx: 5 }));
            if (!n.root) g.appendChild(svg('rect', { class: 'dg-bar', width: 5, height: NODE_H, rx: 2 }));
            const text = svg('text', { x: n.root ? 10 : 12, y: NODE_H / 2 + 4, class: 'dg-label' });
            text.textContent = shortLabel(n);
            g.appendChild(text);
            if (n.advisories && n.advisories.length) {
                const badge = svg('circle', { class: 'dg-adv-dot', cx: NODE_W - 10, cy: NODE_H / 2, r: 5 });
                g.appendChild(badge);
            }
            if (pos.hidden > 0 || (index.children[id].length && state.expanded.has(id) && !state.problemsOnly && id !== ROOT_ID)) {
                const more = svg('g', { class: 'dg-more', transform: `translate(${NODE_W + 4},${NODE_H / 2 - 8})` });
                more.appendChild(svg('rect', { width: pos.hidden > 0 ? 34 : 16, height: 16, rx: 8 }));
                const t = svg('text', { x: pos.hidden > 0 ? 17 : 8, y: 12, 'text-anchor': 'middle' });
                t.textContent = pos.hidden > 0 ? `+${pos.hidden}` : '−';
                more.appendChild(t);
                g.appendChild(more);
            }
            nodeLayer.appendChild(g);
            nodeEls.set(id, g);
        }
        applyHighlight();
        applyTransform();
    }

    function applyTransform() {
        world.setAttribute('transform', `translate(${state.tx},${state.ty}) scale(${state.scale})`);
    }

    /** `id` and its ancestors (every shown path up to the project). */
    function ancestors(id) {
        const set = new Set([id]);
        const stack = [id];
        while (stack.length) {
            const cur = stack.pop();
            for (const p of index.parents[cur]) if (!set.has(p) && state.layout.nodes.has(p)) { set.add(p); stack.push(p); }
        }
        return set;
    }

    function applyHighlight() {
        const focus = state.hover !== null ? state.hover : state.selected;
        const up = focus !== null && state.layout.nodes.has(focus) ? ancestors(focus) : null;
        const down = up ? new Set(index.children[focus].filter(c => state.layout.nodes.has(c))) : null;
        canvas.classList.toggle('dg-dimmed', Boolean(up));
        const matchSet = new Set(state.matches);
        for (const [id, g] of nodeEls) {
            g.classList.toggle('dg-on', Boolean(up && (up.has(id) || down.has(id))));
            g.classList.toggle('dg-selected', id === state.selected);
            g.classList.toggle('dg-match-hit', matchSet.has(id));
        }
        for (const e of edgeEls) {
            // Paths up to the project, and the focused package's own dependencies.
            const on = up && ((up.has(e.a) && up.has(e.b)) || (e.a === focus && down.has(e.b)));
            e.path.classList.toggle('dg-on', Boolean(on));
        }
    }

    // ---------------- details panel

    function renderDetails() {
        details.textContent = '';
        const id = state.selected;
        if (id === null) {
            const n = data.nodes.length - 1;
            const direct = index.children[ROOT_ID].filter(c => data.nodes[c].relation === 'direct').length;
            details.append(
                el('h3', {}, data.label),
                el('p', {}, `${n} package${n === 1 ? '' : 's'}, ${direct} direct.`),
                el('p', { class: 'dg-muted' }, problemCount ? `${problemCount} need${problemCount === 1 ? 's' : ''} attention: use "Problems only" to see where they come from.` : 'No packages with advisories, policy flags or copyleft/restricted licenses.'),
                el('p', { class: 'dg-muted' }, 'Select a package to see its license, advisories and why it is here.')
            );
            return;
        }
        const n = data.nodes[id];
        details.append(el('h3', {}, n.root ? n.name : n.name));
        if (n.root) {
            details.append(el('p', {}, `The project. ${index.children[ROOT_ID].length} packages depend on it directly.`));
            return;
        }
        const meta = el('dl', { class: 'dg-meta' });
        const row = (k, v) => { if (v === '' || v === null || v === undefined) return; meta.append(el('dt', {}, k)); const dd = el('dd'); if (v instanceof Node) dd.appendChild(v); else dd.textContent = v; meta.append(dd); };
        row('Version', n.version || 'unknown');
        row('Ecosystem', n.ecosystem);
        row('Relation', `${n.relation === 'direct' ? 'Direct' : 'Transitive'}${n.dev ? ', development only' : ''}`);
        row('License', n.license ? `${n.license}${n.groupLabel ? ` (${n.groupLabel})` : ''}` : (n.checked ? `None found${n.groupLabel ? ` (${n.groupLabel})` : ''}` : 'Not looked up'));
        if (n.verdict) row('Policy', n.verdict === 'block' ? 'Blocked' : 'Needs review');
        if (n.outdated && n.latest) row('Latest', n.latest);
        if (n.url) row('Registry', extLink(n.url, 'Open package page'));
        details.appendChild(meta);

        if (n.advisories.length) {
            details.appendChild(el('h4', {}, `Advisories (${n.advisories.length})`));
            const ul = el('ul', { class: 'dg-advisories' });
            for (const a of n.advisories) {
                const li = el('li');
                li.append(el('span', { class: `dg-sev dg-sev-${a.severity}` }, a.severity === 'unknown' ? 'unrated' : a.severity), document.createTextNode(' '), extLink(a.url, a.id));
                if (a.title) li.append(document.createTextNode(` ${a.title}`));
                ul.appendChild(li);
            }
            details.appendChild(ul);
        }

        const chain = pathTo(index, id);
        details.appendChild(el('h4', {}, 'Why it is here'));
        if (n.unlinked) {
            details.appendChild(el('p', { class: 'dg-muted' }, 'Installed, but the lockfile does not say which package needs it.'));
        } else if (chain.length) {
            const p = el('p', { class: 'dg-chain' });
            chain.forEach((c, i) => {
                if (i) p.append(document.createTextNode(' → '));
                const b = el('button', { type: 'button', class: 'dg-link' }, data.nodes[c].root ? 'project' : data.nodes[c].name);
                b.addEventListener('click', () => reveal(c));
                p.appendChild(b);
            });
            details.appendChild(p);
        }
        const parents = index.parents[id].filter(p => p !== ROOT_ID);
        if (parents.length) {
            details.appendChild(el('h4', {}, `Required by (${parents.length})`));
            const ul = el('ul', { class: 'dg-list' });
            for (const p of parents.slice(0, 50)) {
                const b = el('button', { type: 'button', class: 'dg-link' }, shortLabel(data.nodes[p], 40));
                b.addEventListener('click', () => reveal(p));
                const li = el('li'); li.appendChild(b); ul.appendChild(li);
            }
            details.appendChild(ul);
        }
        const kids = index.children[id];
        if (kids.length) {
            const toggle = el('button', { type: 'button', class: 'dg-btn' }, `${state.expanded.has(id) ? 'Hide' : 'Show'} its ${kids.length} ${kids.length === 1 ? 'dependency' : 'dependencies'}`);
            toggle.disabled = state.problemsOnly;
            toggle.addEventListener('click', () => { toggleExpand(id); renderDetails(); });
            details.appendChild(toggle);
        }
    }

    // ---------------- actions

    function select(id) {
        state.selected = id;
        applyHighlight();
        renderDetails();
    }

    function toggleExpand(id) {
        if (state.problemsOnly || !index.children[id].length) return;
        if (state.expanded.has(id)) state.expanded.delete(id); else state.expanded.add(id);
        const before = state.layout.nodes.get(id);
        render();
        const after = state.layout.nodes.get(id);
        if (before && after) { state.tx += (before.x - after.x) * state.scale; state.ty += (before.y - after.y) * state.scale; applyTransform(); }
    }

    /** Expands the shortest path to `id`, selects it and brings it into view. */
    function reveal(id) {
        if (state.problemsOnly && !state.layout.nodes.has(id)) setProblemsOnly(false);
        for (const c of pathTo(index, id).slice(0, -1)) state.expanded.add(c);
        render();
        select(id);
        centerOn(id);
    }

    function centerOn(id) {
        const p = state.layout.nodes.get(id);
        if (!p) return;
        const r = stage.getBoundingClientRect();
        state.tx = r.width / 2 - (p.x + NODE_W / 2) * state.scale;
        state.ty = r.height / 2 - (p.y + NODE_H / 2) * state.scale;
        applyTransform();
    }

    function fit() {
        const r = stage.getBoundingClientRect();
        const L = state.layout;
        if (!r.width || !r.height) return;
        const w = L.width + 60, h = L.height + 40;
        state.scale = Math.max(0.08, Math.min(1.4, Math.min(r.width / w, r.height / h)));
        state.tx = (r.width - L.width * state.scale) / 2;
        state.ty = Math.max(10, (r.height - L.height * state.scale) / 2);
        applyTransform();
    }

    function zoomAt(factor, cx, cy) {
        const next = Math.max(0.08, Math.min(3, state.scale * factor));
        const f = next / state.scale;
        state.tx = cx - (cx - state.tx) * f;
        state.ty = cy - (cy - state.ty) * f;
        state.scale = next;
        applyTransform();
    }
    const zoomCenter = factor => { const r = stage.getBoundingClientRect(); zoomAt(factor, r.width / 2, r.height / 2); };

    function setProblemsOnly(on) {
        state.problemsOnly = on;
        problems.setAttribute('aria-pressed', on ? 'true' : 'false');
        problems.classList.toggle('active', on);
        render();
        fit();
        renderDetails();
    }

    function runSearch() {
        const q = search.value.trim().toLowerCase();
        state.matches = q ? data.nodes.filter(n => !n.root && n.name.toLowerCase().includes(q)).map(n => n.id) : [];
        state.matchAt = -1;
        matchInfo.textContent = q ? (state.matches.length ? `${state.matches.length} found, Enter for next` : 'No match') : '';
        applyHighlight();
    }

    // ---------------- events

    const nodeIdFrom = target => {
        const g = target && target.closest ? target.closest('.dg-node') : null;
        return g ? Number(g.getAttribute('data-id')) : null;
    };

    let drag = null;
    const onPointerDown = (e) => {
        if (e.button !== 0) return;
        // Remember what was pressed: pointer capture retargets the release to the stage.
        const more = e.target && e.target.closest ? Boolean(e.target.closest('.dg-more')) : false;
        drag = { x: e.clientX, y: e.clientY, tx: state.tx, ty: state.ty, moved: false, id: nodeIdFrom(e.target), more };
        stage.setPointerCapture && stage.setPointerCapture(e.pointerId);
    };
    const onPointerMove = (e) => {
        if (drag) {
            const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
            if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
            if (drag.moved) { state.tx = drag.tx + dx; state.ty = drag.ty + dy; applyTransform(); stage.classList.add('dg-grabbing'); }
            return;
        }
        const id = nodeIdFrom(e.target);
        if (id !== state.hover) { state.hover = id; applyHighlight(); }
    };
    const onPointerUp = () => {
        const pressed = drag;
        drag = null;
        stage.classList.remove('dg-grabbing');
        if (!pressed || pressed.moved) return;
        if (pressed.id === null) { select(null); return; }
        if (pressed.more) toggleExpand(pressed.id);
        select(pressed.id);
    };
    const onLeave = () => { if (state.hover !== null) { state.hover = null; applyHighlight(); } };
    const onDbl = (e) => { const id = nodeIdFrom(e.target); if (id !== null) { toggleExpand(id); select(id); } };
    const onWheel = (e) => {
        e.preventDefault();
        const r = stage.getBoundingClientRect();
        zoomAt(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)), e.clientX - r.left, e.clientY - r.top);
    };
    const onKey = (e) => {
        if (e.target === search) return;
        const L = state.layout;
        const cur = state.selected !== null && L.nodes.has(state.selected) ? state.selected : null;
        const sameLayer = (delta) => {
            const p = L.nodes.get(cur);
            const layer = L.layers[p.depth];
            const i = layer.indexOf(cur) + delta;
            return i >= 0 && i < layer.length ? layer[i] : cur;
        };
        let next = null;
        switch (e.key) {
            case '+': case '=': zoomCenter(1.2); break;
            case '-': case '_': zoomCenter(1 / 1.2); break;
            case '0': fit(); break;
            case 'ArrowRight':
                if (cur === null) { next = ROOT_ID; break; }
                if (!state.expanded.has(cur) && !state.problemsOnly) toggleExpand(cur);
                next = index.children[cur].find(c => state.layout.nodes.has(c)) ?? cur;
                break;
            case 'ArrowLeft': next = cur === null ? ROOT_ID : (index.via[cur] >= 0 && L.nodes.has(index.via[cur]) ? index.via[cur] : (index.parents[cur].find(p => L.nodes.has(p)) ?? cur)); break;
            case 'ArrowUp': next = cur === null ? ROOT_ID : sameLayer(-1); break;
            case 'ArrowDown': next = cur === null ? ROOT_ID : sameLayer(1); break;
            case 'Enter': if (cur !== null) toggleExpand(cur); renderDetails(); break;
            case 'Escape': if (cur !== null) { select(null); e.stopPropagation(); e.preventDefault(); } return;
            default: return;
        }
        e.preventDefault();
        if (next !== null) {
            select(next);
            const p = state.layout.nodes.get(next);
            const r = stage.getBoundingClientRect();
            const sx = p.x * state.scale + state.tx, sy = p.y * state.scale + state.ty;
            if (sx < 0 || sy < 0 || sx > r.width - NODE_W * state.scale || sy > r.height - NODE_H * state.scale) centerOn(next);
        }
    };

    stage.addEventListener('pointerdown', onPointerDown);
    stage.addEventListener('pointermove', onPointerMove);
    stage.addEventListener('pointerup', onPointerUp);
    stage.addEventListener('pointerleave', onLeave);
    stage.addEventListener('dblclick', onDbl);
    stage.addEventListener('wheel', onWheel, { passive: false });
    stage.addEventListener('keydown', onKey);
    fitBtn.addEventListener('click', fit);
    zoomIn.addEventListener('click', () => zoomCenter(1.25));
    zoomOut.addEventListener('click', () => zoomCenter(1 / 1.25));
    expandAll.addEventListener('click', () => { state.expanded = new Set(data.nodes.map(n => n.id)); if (state.problemsOnly) setProblemsOnly(false); else { render(); fit(); } });
    collapseAll.addEventListener('click', () => { state.expanded = new Set([ROOT_ID]); if (state.problemsOnly) setProblemsOnly(false); else { render(); fit(); } });
    problems.addEventListener('click', () => setProblemsOnly(!state.problemsOnly));
    search.addEventListener('input', runSearch);
    search.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || !state.matches.length) return;
        e.preventDefault();
        state.matchAt = (state.matchAt + 1) % state.matches.length;
        matchInfo.textContent = `${state.matchAt + 1} of ${state.matches.length}`;
        reveal(state.matches[state.matchAt]);
    });

    render();
    renderDetails();
    // Once the container has a size (it may be opening in a dialog): fit everything, unless that
    // would make the labels unreadable; then start at a readable zoom with the project in view.
    requestAnimationFrame(() => {
        fit();
        if (state.scale < 0.55) {
            const r = stage.getBoundingClientRect();
            const root = state.layout.nodes.get(ROOT_ID);
            state.scale = 0.8;
            state.tx = 24 - root.x * state.scale;
            state.ty = r.height / 2 - (root.y + NODE_H / 2) * state.scale;
            applyTransform();
        }
    });

    return {
        destroy() {
            container.textContent = '';
            container.classList.remove('dg');
        },
        select,
        reveal,
        fit,
        getSvgMarkup: () => staticSvg(data, state.layout)
    };
}

// ------------------------------------------------------------------ static image

const GROUP_FILL = { root: '#16202B', permissive: '#1E7F57', 'weak-copyleft': '#B7791F', 'strong-copyleft': '#B93A2B', restricted: '#7C3AED', unknown: '#8A96A3' };
const xmlEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * A self-contained SVG picture of a laid-out graph: no scripts, no external resources, fixed
 * light colours (it is shown as an image in READMEs, where the page's theme does not apply).
 */
export function staticSvg(data, layout) {
    const pad = 20;
    const w = Math.ceil(layout.width + pad * 2 + 50), h = Math.ceil(layout.height + pad * 2 + 24);
    const out = [];
    out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif" font-size="11">`);
    out.push(`<title>${xmlEsc(`Dependency graph of ${data.label}`)}</title>`);
    out.push(`<rect width="${w}" height="${h}" fill="#FFFFFF"/>`);
    out.push(`<g transform="translate(${pad},${pad})" fill="none" stroke="#B8C2CC" stroke-width="1">`);
    for (const [a, b] of layout.edges) {
        const p = layout.nodes.get(a), q = layout.nodes.get(b);
        const x1 = p.x + NODE_W, y1 = p.y + NODE_H / 2, x2 = q.x, y2 = q.y + NODE_H / 2;
        const d = q.depth <= p.depth
            ? `M${x1},${y1} C${x1 + 60},${y1} ${x2 - 60},${y2 - 40} ${x2},${y2}`
            : `M${x1},${y1} C${(x1 + x2) / 2},${y1} ${(x1 + x2) / 2},${y2} ${x2},${y2}`;
        out.push(`<path d="${d}"${data.nodes[b].unlinked ? ' stroke-dasharray="3 3"' : ''}/>`);
    }
    out.push('</g>');
    out.push(`<g transform="translate(${pad},${pad})">`);
    for (const [id, pos] of layout.nodes) {
        const n = data.nodes[id];
        const fill = GROUP_FILL[n.group] || GROUP_FILL.unknown;
        const label = `${n.root ? n.name : `${n.name}${n.version ? `@${n.version}` : ''}`}${n.license ? ` · ${n.license}` : ''}`;
        out.push(`<g transform="translate(${pos.x},${pos.y})"><title>${xmlEsc(label)}</title>`);
        out.push(n.root
            ? `<rect width="${NODE_W}" height="${NODE_H}" rx="5" fill="${fill}"/>`
            : `<rect width="${NODE_W}" height="${NODE_H}" rx="5" fill="#FFFFFF" stroke="${n.severity ? '#B93A2B' : '#D5DBE2'}" stroke-width="${n.severity ? 2 : 1}"${n.dev ? ' stroke-dasharray="4 3"' : ''}/><rect width="5" height="${NODE_H}" rx="2" fill="${fill}"/>`);
        out.push(`<text x="${n.root ? 10 : 12}" y="${NODE_H / 2 + 4}" fill="${n.root ? '#FFFFFF' : '#16202B'}">${xmlEsc(shortLabel(n))}</text>`);
        if (n.advisories && n.advisories.length) out.push(`<circle cx="${NODE_W - 10}" cy="${NODE_H / 2}" r="5" fill="#B93A2B"/>`);
        if (pos.hidden > 0) out.push(`<text x="${NODE_W + 6}" y="${NODE_H / 2 + 4}" fill="#5A6877">+${pos.hidden}</text>`);
        out.push('</g>');
    }
    out.push('</g>');
    const legend = [['permissive', 'Permissive'], ['weak-copyleft', 'Weak copyleft'], ['strong-copyleft', 'Strong copyleft'], ['restricted', 'Restricted'], ['unknown', 'Unknown']];
    out.push(`<g transform="translate(${pad},${h - 14})" fill="#5A6877">`);
    let x = 0;
    for (const [g, t] of legend) {
        out.push(`<rect x="${x}" y="-8" width="8" height="8" rx="2" fill="${GROUP_FILL[g]}"/><text x="${x + 12}" y="0">${t}</text>`);
        x += 22 + t.length * 6;
    }
    out.push(`<circle cx="${x + 4}" cy="-4" r="4" fill="#B93A2B"/><text x="${x + 12}" y="0">Advisory</text>`);
    out.push(`<text x="${x + 80}" y="0">Made with GitDoco</text>`);
    out.push('</g></svg>');
    return out.join('\n');
}
