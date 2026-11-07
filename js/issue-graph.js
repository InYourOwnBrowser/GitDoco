/**
 * Issue (and discussion) relationship map.
 *
 *   toIssueGraphData(...)  issues + cross-references + near-duplicates + topics -> plain data
 *   components(...)        connected groups ("these issues are about the same thing")
 *   forceLayout(...)       a deterministic force-directed layout (no libraries)
 *   mountIssueGraph(...)   an SVG view: pan/zoom, search, hover highlighting, a details panel,
 *                          and selecting issues (or a whole group) for the AI output
 *
 * No imports, like js/dep-graph.js, so it can be inlined into a standalone page later.
 * Titles, labels and topic names come from GitHub and are untrusted: they are only ever set with
 * textContent / setAttribute, never as markup.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
export const TOPIC_COLORS = ['#2A4BD7', '#1E7F57', '#B7791F', '#B93A2B', '#7C3AED', '#0E7490', '#BE185D', '#4D7C0F'];
const NO_TOPIC = '#8A96A3';

// ------------------------------------------------------------------ data

/**
 * @param {object} args
 * @param {object[]} args.issues   { number, title, state, stateReason, isPullRequest, mergedAt, isAnswered,
 *                                   commentsCount, reactionsTotal, labels: [{name}|string], htmlUrl, body }
 * @param {object[]} [args.clusters]  [{ label, issueNumbers }] from the NLP worker
 * @param {object} [args.similarMap]  { number: [number, ...] } near-duplicates from the NLP worker
 * @param {(n: number) => string[]} [args.extraTexts]  more text to scan for #refs (loaded comments)
 * @param {(text: string, self: number) => number[]} args.extractRefs
 */
export function toIssueGraphData({ issues, clusters = [], similarMap = {}, extraTexts = null, extractRefs }) {
    const idOf = new Map();
    // Topics with the same name (the clustering can split one theme in two) are shown as one.
    const topicIndex = new Map();
    const topics = [];
    const topicOf = new Map();
    for (const c of clusters || []) {
        const label = String(c.label || `Topic ${topics.length + 1}`);
        if (!topicIndex.has(label)) { topicIndex.set(label, topics.length); topics.push({ label, color: TOPIC_COLORS[topics.length % TOPIC_COLORS.length], count: 0 }); }
        const t = topicIndex.get(label);
        for (const n of c.issueNumbers || []) if (!topicOf.has(n)) { topicOf.set(n, t); topics[t].count++; }
    }
    const seenNumbers = new Set();
    issues = (issues || []).filter(iss => iss && !seenNumbers.has(iss.number) && seenNumbers.add(iss.number));
    const nodes = issues.map((iss, id) => {
        idOf.set(iss.number, id);
        const state = iss.isPullRequest && iss.mergedAt ? 'merged'
            : iss.isAnswered ? 'answered'
                : iss.state === 'closed' ? 'closed' : 'open';
        return {
            id,
            number: iss.number,
            title: String(iss.title || ''),
            state,
            isPR: Boolean(iss.isPullRequest),
            comments: Number(iss.commentsCount) || 0,
            reactions: Number(iss.reactionsTotal) || 0,
            labels: (iss.labels || []).map(l => String(typeof l === 'string' ? l : (l && l.name) || '')).filter(Boolean).slice(0, 8),
            topic: topicOf.has(iss.number) ? topicOf.get(iss.number) : -1,
            url: typeof iss.htmlUrl === 'string' && /^https:\/\/github\.com\//.test(iss.htmlUrl) ? iss.htmlUrl : ''
        };
    });
    const edges = new Map();
    const addEdge = (a, b, kind) => {
        if (a === undefined || b === undefined || a === b) return;
        const key = a < b ? `${a}-${b}` : `${b}-${a}`;
        const e = edges.get(key) || { a: Math.min(a, b), b: Math.max(a, b), ref: false, similar: false, from: [] };
        e[kind] = true;
        edges.set(key, e);
        return e;
    };
    for (const iss of issues) {
        const texts = [iss.body || '', ...(extraTexts ? extraTexts(iss.number) || [] : [])];
        const refs = new Set();
        for (const t of texts) for (const r of extractRefs(t, iss.number)) refs.add(r);
        for (const r of refs) {
            const e = addEdge(idOf.get(iss.number), idOf.get(r), 'ref');
            if (e) e.from.push(iss.number);
        }
    }
    for (const [num, list] of Object.entries(similarMap || {})) {
        for (const other of list || []) addEdge(idOf.get(Number(num)), idOf.get(Number(other)), 'similar');
    }
    return { nodes, edges: [...edges.values()], topics };
}

/** Neighbours of every node, honouring which edge kinds are shown. */
export function adjacency(data, { refs = true, similar = true } = {}) {
    const adj = data.nodes.map(() => []);
    for (const e of data.edges) {
        if ((e.ref && refs) || (e.similar && similar)) { adj[e.a].push(e.b); adj[e.b].push(e.a); }
    }
    return adj;
}

/** Connected groups: component id per node, and the members of each group (largest first). */
export function components(adj) {
    const comp = new Array(adj.length).fill(-1);
    const groups = [];
    for (let s = 0; s < adj.length; s++) {
        if (comp[s] !== -1) continue;
        const members = [s];
        comp[s] = groups.length;
        for (let i = 0; i < members.length; i++) {
            for (const t of adj[members[i]]) if (comp[t] === -1) { comp[t] = groups.length; members.push(t); }
        }
        groups.push(members);
    }
    return { comp, groups };
}

// ------------------------------------------------------------------ layout

function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export const nodeRadius = n => Math.min(18, 5 + Math.sqrt(n.comments + n.reactions) * 1.3);

/**
 * Force-directed positions for `ids` (deterministic: the same input gives the same picture).
 * Repulsion only between nearby nodes (a grid), springs along edges, a gentle pull to the centre.
 * @returns {Map<id, {x, y}>}
 */
export function forceLayout(data, ids, adj, { iterations = 260, seed = 7 } = {}) {
    const n = ids.length;
    const pos = new Map();
    if (!n) return pos;
    const rand = rng(seed + n);
    const topics = Math.max(1, data.topics.length);
    const spread = Math.sqrt(n) * 28;
    const X = new Float64Array(n), Y = new Float64Array(n), VX = new Float64Array(n), VY = new Float64Array(n);
    const local = new Map(ids.map((id, i) => [id, i]));
    ids.forEach((id, i) => {
        // Start each topic in its own sector, so related issues begin close together.
        const t = data.nodes[id].topic;
        const angle = t >= 0 ? (t / topics) * Math.PI * 2 : rand() * Math.PI * 2;
        const r = spread * (0.35 + rand() * 0.65);
        X[i] = Math.cos(angle) * r + (rand() - 0.5) * 20;
        Y[i] = Math.sin(angle) * r + (rand() - 0.5) * 20;
    });
    const springs = [];
    for (const e of data.edges) {
        const a = local.get(e.a), b = local.get(e.b);
        if (a === undefined || b === undefined) continue;
        if (!adj[e.a].includes(e.b)) continue;
        springs.push([a, b, e.ref ? 55 : 80]);
    }
    const CELL = 90, REPEL = 1800;
    for (let it = 0; it < iterations; it++) {
        const cool = 1 - it / iterations;
        const grid = new Map();
        for (let i = 0; i < n; i++) {
            const k = `${Math.floor(X[i] / CELL)},${Math.floor(Y[i] / CELL)}`;
            (grid.get(k) || grid.set(k, []).get(k)).push(i);
        }
        for (let i = 0; i < n; i++) {
            const cx = Math.floor(X[i] / CELL), cy = Math.floor(Y[i] / CELL);
            for (let gx = cx - 1; gx <= cx + 1; gx++) {
                for (let gy = cy - 1; gy <= cy + 1; gy++) {
                    const cell = grid.get(`${gx},${gy}`);
                    if (!cell) continue;
                    for (const j of cell) {
                        if (j <= i) continue;
                        let dx = X[i] - X[j], dy = Y[i] - Y[j];
                        let d2 = dx * dx + dy * dy;
                        if (d2 < 0.01) { dx = rand() - 0.5; dy = rand() - 0.5; d2 = 0.5; }
                        if (d2 > CELL * CELL * 2) continue;
                        const f = REPEL / d2;
                        const d = Math.sqrt(d2);
                        VX[i] += (dx / d) * f; VY[i] += (dy / d) * f;
                        VX[j] -= (dx / d) * f; VY[j] -= (dy / d) * f;
                    }
                }
            }
        }
        for (const [a, b, len] of springs) {
            const dx = X[b] - X[a], dy = Y[b] - Y[a];
            const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
            const f = (d - len) * 0.06;
            VX[a] += (dx / d) * f; VY[a] += (dy / d) * f;
            VX[b] -= (dx / d) * f; VY[b] -= (dy / d) * f;
        }
        for (let i = 0; i < n; i++) {
            VX[i] -= X[i] * 0.012; VY[i] -= Y[i] * 0.012;
            const max = 30 * cool + 1;
            const v = Math.sqrt(VX[i] * VX[i] + VY[i] * VY[i]);
            const s = v > max ? max / v : 1;
            X[i] += VX[i] * s; Y[i] += VY[i] * s;
            VX[i] *= 0.5; VY[i] *= 0.5;
        }
    }
    ids.forEach((id, i) => pos.set(id, { x: X[i], y: Y[i] }));
    return pos;
}

// ------------------------------------------------------------------ view

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
const STATE_TEXT = { open: 'Open', closed: 'Closed', merged: 'Merged', answered: 'Answered' };

/**
 * @param {HTMLElement} container
 * @param {object} data   from toIssueGraphData
 * @param {object} opts
 * @param {{ one: string, noun: string, One: string }} opts.words   "issue"/"discussion" wording
 * @param {(n: number) => boolean} opts.isSelected   whether an issue is selected for the AI output
 * @param {(numbers: number[], on: boolean) => void} opts.setSelected
 */
export function mountIssueGraph(container, data, opts) {
    const W = opts.words || { one: 'issue', noun: 'issues', One: 'Issue' };
    const state = { refs: true, similar: true, unlinked: false, hover: null, selected: null, matches: [], matchAt: -1, tx: 0, ty: 0, scale: 1 };
    let adj, comp, shown, pos;

    container.textContent = '';
    container.classList.add('dg');
    const toolbar = el('div', { class: 'dg-toolbar', role: 'toolbar', 'aria-label': 'Map controls' });
    const search = el('input', { type: 'search', class: 'dg-search', placeholder: `Find by #number or title…`, 'aria-label': `Find ${W.one === 'issue' ? 'an' : 'a'} ${W.one} on the map` });
    const matchInfo = el('span', { class: 'dg-match', 'aria-live': 'polite' });
    const btn = (text, title) => el('button', { type: 'button', class: 'dg-btn', title }, text);
    const toggle = (text, title, on) => { const b = el('button', { type: 'button', class: `dg-btn dg-toggle${on ? ' active' : ''}`, 'aria-pressed': on ? 'true' : 'false', title }, text); return b; };
    const fitBtn = btn('Fit', 'Fit the map to the window (0)');
    const zoomIn = btn('+', 'Zoom in (+)');
    const zoomOut = btn('−', 'Zoom out (−)');
    const refsBtn = toggle('References', `Lines for #number links between ${W.noun}`, true);
    const simBtn = toggle('Similar', `Dashed lines between ${W.noun} with very similar wording (possible duplicates)`, true);
    const unlinkedBtn = toggle('Unlinked', `Also show ${W.noun} with no links`, false);
    toolbar.append(search, matchInfo, fitBtn, zoomIn, zoomOut, refsBtn, simBtn, unlinkedBtn);

    const legend = el('div', { class: 'dg-legend', 'aria-label': 'Legend' });
    const body = el('div', { class: 'dg-body' });
    const stage = el('div', { class: 'dg-stage', tabindex: '0' });
    const canvas = svg('svg', { class: 'dg-svg ig-svg', 'aria-hidden': 'true' });
    const world = svg('g');
    const edgeLayer = svg('g', { class: 'ig-edges' });
    const nodeLayer = svg('g', { class: 'ig-nodes' });
    world.append(edgeLayer, nodeLayer);
    canvas.appendChild(world);
    stage.appendChild(canvas);
    const details = el('aside', { class: 'dg-details', 'aria-live': 'polite' });
    body.append(stage, details);
    container.append(toolbar, legend, body);

    let nodeEls = new Map();
    let edgeEls = [];

    function renderLegend() {
        legend.textContent = '';
        data.topics.forEach(t => {
            const item = el('span', { class: 'dg-legend-item' });
            const sw = el('span', { class: 'dg-swatch ig-swatch', 'aria-hidden': 'true' });
            sw.style.background = t.color;
            item.append(sw, document.createTextNode(t.label));
            legend.appendChild(item);
        });
        const none = el('span', { class: 'dg-legend-item' });
        const sw = el('span', { class: 'dg-swatch', 'aria-hidden': 'true' });
        none.append(sw, document.createTextNode(data.topics.length ? 'No topic' : 'Topics appear once they are found'));
        const hollow = el('span', { class: 'dg-legend-item' });
        hollow.append(el('span', { class: 'dg-swatch ig-swatch-closed', 'aria-hidden': 'true' }), document.createTextNode('Closed'));
        const sel = el('span', { class: 'dg-legend-item' });
        sel.append(el('span', { class: 'dg-swatch ig-swatch-picked', 'aria-hidden': 'true' }), document.createTextNode('Selected for the AI'));
        legend.append(none, hollow, sel, el('span', { class: 'dg-hint' }, 'Size = comments and reactions. Click for details.'));
    }

    function layout() {
        adj = adjacency(data, state);
        ({ comp } = components(adj));
        shown = data.nodes.map(n => n.id).filter(id => state.unlinked || adj[id].length > 0);
        pos = forceLayout(data, shown, adj);
    }

    function render() {
        edgeLayer.textContent = '';
        nodeLayer.textContent = '';
        nodeEls = new Map();
        edgeEls = [];
        for (const e of data.edges) {
            const show = (e.ref && state.refs) || (e.similar && state.similar);
            if (!show || !pos.has(e.a) || !pos.has(e.b)) continue;
            const p = pos.get(e.a), q = pos.get(e.b);
            const line = svg('line', { x1: p.x, y1: p.y, x2: q.x, y2: q.y, class: `ig-edge${e.ref && state.refs ? ' ig-ref' : ' ig-sim'}` });
            edgeLayer.appendChild(line);
            edgeEls.push({ a: e.a, b: e.b, line });
        }
        for (const id of shown) {
            const n = data.nodes[id];
            const p = pos.get(id);
            const r = nodeRadius(n);
            const color = n.topic >= 0 ? data.topics[n.topic].color : NO_TOPIC;
            const g = svg('g', { class: `ig-node ig-${n.state}${opts.isSelected(n.number) ? ' ig-picked' : ''}`, transform: `translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`, 'data-id': id });
            const title = svg('title');
            title.textContent = `#${n.number} ${n.title}`;
            g.appendChild(title);
            g.appendChild(svg('circle', { class: 'ig-ring', r: r + 4 }));
            const shape = n.isPR
                ? svg('rect', { class: 'ig-dot', x: -r, y: -r, width: r * 2, height: r * 2, rx: 3 })
                : svg('circle', { class: 'ig-dot', r });
            shape.setAttribute('fill', n.state === 'open' ? color : 'var(--dg-sheet)');
            shape.setAttribute('stroke', color);
            g.appendChild(shape);
            const label = svg('text', { class: 'ig-label', x: r + 3, y: 4 });
            label.textContent = `#${n.number}`;
            g.appendChild(label);
            nodeLayer.appendChild(g);
            nodeEls.set(id, g);
        }
        highlight();
        applyTransform();
    }

    function applyTransform() { world.setAttribute('transform', `translate(${state.tx},${state.ty}) scale(${state.scale})`); }

    function highlight() {
        const focus = state.hover !== null ? state.hover : state.selected;
        const near = focus !== null && pos.has(focus) ? new Set([focus, ...adj[focus]]) : null;
        canvas.classList.toggle('dg-dimmed', Boolean(near));
        const hits = new Set(state.matches);
        for (const [id, g] of nodeEls) {
            g.classList.toggle('dg-on', Boolean(near && near.has(id)));
            g.classList.toggle('dg-selected', id === state.selected);
            g.classList.toggle('dg-match-hit', hits.has(id));
            g.classList.toggle('ig-picked', opts.isSelected(data.nodes[id].number));
        }
        for (const e of edgeEls) e.line.classList.toggle('dg-on', Boolean(near && (e.a === focus || e.b === focus)));
    }

    function fit() {
        const r = stage.getBoundingClientRect();
        if (!r.width || !r.height || !pos.size) return;
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const p of pos.values()) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
        const w = x1 - x0 + 80, h = y1 - y0 + 80;
        state.scale = Math.max(0.1, Math.min(2, Math.min(r.width / w, r.height / h)));
        state.tx = r.width / 2 - ((x0 + x1) / 2) * state.scale;
        state.ty = r.height / 2 - ((y0 + y1) / 2) * state.scale;
        applyTransform();
    }
    function zoomAt(f, cx, cy) {
        const next = Math.max(0.1, Math.min(4, state.scale * f));
        const k = next / state.scale;
        state.tx = cx - (cx - state.tx) * k; state.ty = cy - (cy - state.ty) * k; state.scale = next;
        applyTransform();
    }
    const zoomCenter = f => { const r = stage.getBoundingClientRect(); zoomAt(f, r.width / 2, r.height / 2); };
    function centerOn(id) {
        const p = pos.get(id);
        if (!p) return;
        const r = stage.getBoundingClientRect();
        if (state.scale < 0.8) state.scale = 1;
        state.tx = r.width / 2 - p.x * state.scale; state.ty = r.height / 2 - p.y * state.scale;
        applyTransform();
    }

    function issueButton(id) {
        const n = data.nodes[id];
        const b = el('button', { type: 'button', class: 'dg-link' }, `#${n.number} ${n.title.length > 60 ? `${n.title.slice(0, 59)}…` : n.title}`);
        b.addEventListener('click', () => reveal(id));
        return b;
    }

    function renderDetails() {
        details.textContent = '';
        const id = state.selected;
        const linked = data.nodes.filter(n => adj[n.id].length > 0).length;
        if (id === null) {
            const { groups } = components(adj);
            const multi = groups.filter(g => g.length > 1).length;
            details.append(
                el('h3', {}, `${data.nodes.length} ${W.noun}`),
                el('p', {}, `${linked} are linked to another ${W.one}, in ${multi} group${multi === 1 ? '' : 's'}.`),
                el('p', { class: 'dg-muted' }, `Solid lines are #number references; dashed lines join ${W.noun} with very similar wording (possible duplicates).`),
                el('p', { class: 'dg-muted' }, `Click ${W.one === 'issue' ? 'an' : 'a'} ${W.one} to see its links and select it, or its whole group, for the AI output.`)
            );
            return;
        }
        const n = data.nodes[id];
        const h = el('h3');
        if (n.url) h.appendChild(el('a', { href: n.url, target: '_blank', rel: 'noopener noreferrer' }, `#${n.number}`));
        else h.appendChild(document.createTextNode(`#${n.number}`));
        h.appendChild(document.createTextNode(` ${n.title}`));
        details.appendChild(h);
        const meta = el('dl', { class: 'dg-meta' });
        const row = (k, v) => { meta.append(el('dt', {}, k), el('dd', {}, v)); };
        row('State', `${STATE_TEXT[n.state]}${n.isPR ? ' (pull request)' : ''}`);
        row('Comments', String(n.comments));
        if (n.reactions) row('Reactions', String(n.reactions));
        if (n.topic >= 0) row('Topic', data.topics[n.topic].label);
        if (n.labels.length) row('Labels', n.labels.join(', '));
        details.appendChild(meta);

        const picked = opts.isSelected(n.number);
        const pick = el('button', { type: 'button', class: `dg-btn${picked ? ' active' : ''}`, 'aria-pressed': picked ? 'true' : 'false' }, picked ? 'Selected for the AI' : 'Select for the AI');
        pick.addEventListener('click', () => { opts.setSelected([n.number], !opts.isSelected(n.number)); highlight(); renderDetails(); });
        details.appendChild(pick);
        const group = components(adj).groups[comp[id]];
        if (group.length > 1) {
            const nums = group.map(g => data.nodes[g].number);
            const allPicked = nums.every(x => opts.isSelected(x));
            const gb = el('button', { type: 'button', class: 'dg-btn' }, allPicked ? `Deselect its group (${group.length})` : `Select its group (${group.length})`);
            gb.title = `Everything connected to #${n.number} by the lines shown`;
            gb.addEventListener('click', () => { opts.setSelected(nums, !allPicked); highlight(); renderDetails(); });
            details.appendChild(gb);
        }

        const refs = data.edges.filter(e => e.ref && (e.a === id || e.b === id)).map(e => (e.a === id ? e.b : e.a));
        const sims = data.edges.filter(e => e.similar && (e.a === id || e.b === id)).map(e => (e.a === id ? e.b : e.a));
        const list = (title, ids) => {
            if (!ids.length) return;
            details.appendChild(el('h4', {}, `${title} (${ids.length})`));
            const ul = el('ul', { class: 'dg-list' });
            for (const x of ids.slice(0, 40)) { const li = el('li'); li.appendChild(issueButton(x)); ul.appendChild(li); }
            details.appendChild(ul);
        };
        list('Linked by #references', refs);
        list('Similar wording', sims);
        if (!refs.length && !sims.length) details.appendChild(el('p', { class: 'dg-muted' }, `No links to other loaded ${W.noun}.`));
    }

    function select(id) { state.selected = id; highlight(); renderDetails(); }
    function reveal(id) {
        if (!pos.has(id)) { state.unlinked = true; setToggle(unlinkedBtn, true); layout(); render(); }
        select(id);
        centerOn(id);
    }
    function setToggle(b, on) { b.classList.toggle('active', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); }
    function relayout() { layout(); render(); fit(); renderDetails(); }

    function runSearch() {
        const q = search.value.trim().toLowerCase().replace(/^#/, '');
        state.matches = !q ? [] : /^\d+$/.test(q)
            ? data.nodes.filter(n => String(n.number) === q).map(n => n.id)
            : data.nodes.filter(n => n.title.toLowerCase().includes(q)).map(n => n.id);
        state.matchAt = -1;
        matchInfo.textContent = q ? (state.matches.length ? `${state.matches.length} found, Enter for next` : 'No match') : '';
        highlight();
    }

    const idFrom = t => { const g = t && t.closest ? t.closest('.ig-node') : null; return g ? Number(g.getAttribute('data-id')) : null; };
    let drag = null;
    stage.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        drag = { x: e.clientX, y: e.clientY, tx: state.tx, ty: state.ty, moved: false, id: idFrom(e.target) };
        if (stage.setPointerCapture) stage.setPointerCapture(e.pointerId);
    });
    stage.addEventListener('pointermove', (e) => {
        if (drag) {
            const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
            if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
            if (drag.moved) { state.tx = drag.tx + dx; state.ty = drag.ty + dy; applyTransform(); stage.classList.add('dg-grabbing'); }
            return;
        }
        const id = idFrom(e.target);
        if (id !== state.hover) { state.hover = id; highlight(); }
    });
    stage.addEventListener('pointerup', () => {
        const d = drag; drag = null; stage.classList.remove('dg-grabbing');
        if (!d || d.moved) return;
        select(d.id);
    });
    stage.addEventListener('pointerleave', () => { if (state.hover !== null) { state.hover = null; highlight(); } });
    stage.addEventListener('wheel', (e) => {
        e.preventDefault();
        const r = stage.getBoundingClientRect();
        zoomAt(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    stage.addEventListener('keydown', (e) => {
        if (e.key === '+' || e.key === '=') zoomCenter(1.2);
        else if (e.key === '-' || e.key === '_') zoomCenter(1 / 1.2);
        else if (e.key === '0') fit();
        else if (e.key === 'Escape' && state.selected !== null) { select(null); e.stopPropagation(); }
        else return;
        e.preventDefault();
    });
    fitBtn.addEventListener('click', fit);
    zoomIn.addEventListener('click', () => zoomCenter(1.25));
    zoomOut.addEventListener('click', () => zoomCenter(1 / 1.25));
    refsBtn.addEventListener('click', () => { state.refs = !state.refs; setToggle(refsBtn, state.refs); relayout(); });
    simBtn.addEventListener('click', () => { state.similar = !state.similar; setToggle(simBtn, state.similar); relayout(); });
    unlinkedBtn.addEventListener('click', () => { state.unlinked = !state.unlinked; setToggle(unlinkedBtn, state.unlinked); relayout(); });
    search.addEventListener('input', runSearch);
    search.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || !state.matches.length) return;
        e.preventDefault();
        state.matchAt = (state.matchAt + 1) % state.matches.length;
        matchInfo.textContent = `${state.matchAt + 1} of ${state.matches.length}`;
        reveal(state.matches[state.matchAt]);
    });

    renderLegend();
    layout();
    if (!shown.length) { state.unlinked = true; setToggle(unlinkedBtn, true); layout(); }
    render();
    renderDetails();
    requestAnimationFrame(fit);

    return {
        destroy() { container.textContent = ''; container.classList.remove('dg'); },
        /** Call after the selection changed elsewhere (e.g. in the list). */
        refreshSelection() { highlight(); renderDetails(); }
    };
}
