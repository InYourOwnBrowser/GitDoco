/**
 * Phrase map: the phrases that recur across issues (or discussions), linked when they turn up in
 * the same threads, so themes that travel together sit together ("memory leak" near "large files").
 *
 *   toPhraseData(...)    phrases from the NLP worker -> nodes (sized by threads) and links (shared threads)
 *   mountPhraseMap(...)  an SVG view: pan/zoom, search, hover highlighting, a details panel listing
 *                        the threads, and actions to filter the list or select them for the AI
 *
 * Phrases and titles come from GitHub, so they are only set as text, never as markup.
 */
import { mergeTopics, topicColor, forceLayout } from './issue-graph.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Two phrases are linked when they share at least this many threads... */
export const MIN_SHARED = 2;
/** ...and at least this share of all the threads either appears in (Jaccard). */
export const MIN_JACCARD = 0.15;

/**
 * @param {object} args
 * @param {{ phrase: string, count: number, issueNumbers: number[] }[]} args.phrases
 * @param {object[]} [args.clusters]  topics from the NLP worker
 */
export function toPhraseData({ phrases, clusters = [] }) {
    const { topics, topicOf } = mergeTopics(clusters);
    const nodes = (phrases || []).map((p, id) => {
        const numbers = [...new Set(p.issueNumbers || [])];
        // The phrase's topic: the one most of its threads belong to, if it is a clear majority.
        const tally = new Map();
        for (const n of numbers) if (topicOf.has(n)) tally.set(topicOf.get(n), (tally.get(topicOf.get(n)) || 0) + 1);
        let topic = -1, best = 0;
        for (const [t, c] of tally) if (c > best) { best = c; topic = t; }
        if (best < numbers.length * 0.4) topic = -1;
        return { id, phrase: String(p.phrase || ''), count: numbers.length, issueNumbers: numbers, topic };
    });
    const edges = [];
    const sets = nodes.map(n => new Set(n.issueNumbers));
    for (let a = 0; a < nodes.length; a++) {
        for (let b = a + 1; b < nodes.length; b++) {
            let shared = 0;
            for (const n of sets[a]) if (sets[b].has(n)) shared++;
            if (shared < MIN_SHARED) continue;
            const jaccard = shared / (sets[a].size + sets[b].size - shared);
            if (jaccard < MIN_JACCARD) continue;
            edges.push({ a, b, shared, jaccard, ref: true });
        }
    }
    return { nodes, edges, topics };
}

const radius = n => Math.min(30, 6 + Math.sqrt(n.count) * 3);

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

/**
 * @param {HTMLElement} container
 * @param {object} data  from toPhraseData
 * @param {object} opts
 * @param {{ one: string, noun: string }} opts.words
 * @param {(n: number) => { title: string, url: string } | null} opts.thread
 * @param {(phrase: string, numbers: number[]) => void} opts.showInList
 * @param {(numbers: number[], on: boolean) => void} opts.setSelected
 * @param {(n: number) => boolean} opts.isSelected
 */
export function mountPhraseMap(container, data, opts) {
    const W = opts.words || { one: 'issue', noun: 'issues' };
    const state = { hover: null, selected: null, topic: null, matches: [], tx: 0, ty: 0, scale: 1 };
    const adj = data.nodes.map(() => []);
    for (const e of data.edges) { adj[e.a].push(e.b); adj[e.b].push(e.a); }

    container.textContent = '';
    container.classList.add('dg');
    if (!data.nodes.length) {
        container.appendChild(el('p', { class: 'dg-empty' }, `Not enough phrases repeat across these ${W.noun} to draw a map. Phrases need to appear in at least two ${W.noun}; loading more helps.`));
        return { destroy() { container.textContent = ''; container.classList.remove('dg'); } };
    }
    const pos = forceLayout(data, data.nodes.map(n => n.id), adj, { iterations: 300, seed: 11, spacing: 2.2 });

    const toolbar = el('div', { class: 'dg-toolbar', role: 'toolbar', 'aria-label': 'Phrase map controls' });
    const search = el('input', { type: 'search', class: 'dg-search', placeholder: 'Find a phrase…', 'aria-label': 'Find a phrase on the map' });
    const matchInfo = el('span', { class: 'dg-match', 'aria-live': 'polite' });
    const btn = (text, title) => el('button', { type: 'button', class: 'dg-btn', title }, text);
    const fitBtn = btn('Fit', 'Fit the map to the window (0)');
    const zoomIn = btn('+', 'Zoom in (+)');
    const zoomOut = btn('−', 'Zoom out (−)');
    toolbar.append(search, matchInfo, fitBtn, zoomIn, zoomOut);
    const legend = el('div', { class: 'dg-legend', 'aria-label': 'Legend' });
    const body = el('div', { class: 'dg-body' });
    const stage = el('div', { class: 'dg-stage', tabindex: '0' });
    const canvas = svg('svg', { class: 'dg-svg', 'aria-hidden': 'true' });
    const world = svg('g');
    const edgeLayer = svg('g');
    const nodeLayer = svg('g');
    world.append(edgeLayer, nodeLayer);
    canvas.appendChild(world);
    stage.appendChild(canvas);
    const details = el('aside', { class: 'dg-details', 'aria-live': 'polite' });
    body.append(stage, details);
    container.append(toolbar, legend, body);

    const nodeEls = new Map();
    const edgeEls = [];
    for (const e of data.edges) {
        const p = pos.get(e.a), q = pos.get(e.b);
        const line = svg('line', { x1: p.x, y1: p.y, x2: q.x, y2: q.y, class: 'pm-edge' });
        line.style.strokeWidth = String(1 + e.jaccard * 4);
        edgeLayer.appendChild(line);
        edgeEls.push({ ...e, line });
    }
    for (const n of data.nodes) {
        const p = pos.get(n.id);
        const r = radius(n);
        const g = svg('g', { class: 'pm-node', transform: `translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`, 'data-id': n.id });
        g.style.setProperty('--c', topicColor(data.topics, n.topic));
        const title = svg('title');
        title.textContent = `"${n.phrase}" in ${n.count} ${n.count === 1 ? W.one : W.noun}`;
        g.appendChild(title);
        g.appendChild(svg('circle', { class: 'pm-dot', r }));
        const label = svg('text', { class: 'pm-label', y: r + 12, 'text-anchor': 'middle' });
        label.textContent = n.phrase;
        g.appendChild(label);
        nodeLayer.appendChild(g);
        nodeEls.set(n.id, g);
    }

    function renderLegend() {
        legend.textContent = '';
        data.topics.forEach((t, i) => {
            const item = el('button', { type: 'button', class: `dg-legend-item dg-legend-btn${state.topic === i ? ' active' : ''}`, 'aria-pressed': state.topic === i ? 'true' : 'false', title: 'Highlight the phrases of this topic' });
            const sw = el('span', { class: 'dg-swatch', 'aria-hidden': 'true' });
            sw.style.background = topicColor(data.topics, i);
            item.append(sw, document.createTextNode(t.label));
            item.addEventListener('click', () => { state.topic = state.topic === i ? null : i; renderLegend(); highlight(); });
            legend.appendChild(item);
        });
        const none = el('span', { class: 'dg-legend-item' });
        const sw = el('span', { class: 'dg-swatch', 'aria-hidden': 'true' });
        sw.style.background = 'var(--t-none)';
        none.append(sw, document.createTextNode('Mixed or no topic'));
        legend.append(none, el('span', { class: 'dg-hint' }, `Size = ${W.noun} using the phrase. Lines join phrases that appear in the same ${W.noun}.`));
    }

    const applyTransform = () => world.setAttribute('transform', `translate(${state.tx},${state.ty}) scale(${state.scale})`);
    function highlight() {
        const focus = state.hover !== null ? state.hover : state.selected;
        let near = focus !== null ? new Set([focus, ...adj[focus]]) : null;
        if (!near && state.topic !== null) near = new Set(data.nodes.filter(n => n.topic === state.topic).map(n => n.id));
        canvas.classList.toggle('dg-dimmed', Boolean(near));
        const hits = new Set(state.matches);
        for (const [id, g] of nodeEls) {
            g.classList.toggle('dg-on', Boolean(near && near.has(id)));
            g.classList.toggle('dg-selected', id === state.selected);
            g.classList.toggle('dg-match-hit', hits.has(id));
        }
        for (const e of edgeEls) e.line.classList.toggle('dg-on', Boolean(near && (focus !== null ? (e.a === focus || e.b === focus) : (near.has(e.a) && near.has(e.b)))));
    }
    function fit() {
        const r = stage.getBoundingClientRect();
        if (!r.width || !r.height) return;
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const p of pos.values()) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
        const w = x1 - x0 + 160, h = y1 - y0 + 90;
        state.scale = Math.max(0.15, Math.min(1.6, Math.min(r.width / w, r.height / h)));
        state.tx = r.width / 2 - ((x0 + x1) / 2) * state.scale;
        state.ty = r.height / 2 - ((y0 + y1) / 2) * state.scale;
        applyTransform();
    }
    function zoomAt(f, cx, cy) {
        const next = Math.max(0.15, Math.min(4, state.scale * f));
        const k = next / state.scale;
        state.tx = cx - (cx - state.tx) * k; state.ty = cy - (cy - state.ty) * k; state.scale = next;
        applyTransform();
    }
    const zoomCenter = f => { const r = stage.getBoundingClientRect(); zoomAt(f, r.width / 2, r.height / 2); };

    function renderDetails() {
        details.textContent = '';
        if (state.selected === null) {
            details.append(
                el('h3', {}, `${data.nodes.length} recurring phrases`),
                el('p', {}, `Phrases that appear in at least two ${W.noun}, with ${data.edges.length} links between phrases that turn up in the same ${W.noun}.`),
                el('p', { class: 'dg-muted' }, `Click a phrase to see its ${W.noun}, show them in the list, or select them for the AI output.`)
            );
            return;
        }
        const n = data.nodes[state.selected];
        details.append(el('h3', {}, `"${n.phrase}"`));
        const meta = el('dl', { class: 'dg-meta' });
        meta.append(el('dt', {}, 'Appears in'), el('dd', {}, `${n.count} ${n.count === 1 ? W.one : W.noun}`));
        if (n.topic >= 0) meta.append(el('dt', {}, 'Topic'), el('dd', {}, data.topics[n.topic].label));
        details.appendChild(meta);
        const show = el('button', { type: 'button', class: 'dg-btn' }, 'Show these in the list');
        show.addEventListener('click', () => opts.showInList(n.phrase, n.issueNumbers));
        const allPicked = n.issueNumbers.every(x => opts.isSelected(x));
        const pick = el('button', { type: 'button', class: `dg-btn${allPicked ? ' active' : ''}`, 'aria-pressed': allPicked ? 'true' : 'false' }, allPicked ? 'Selected for the AI' : 'Select these for the AI');
        pick.addEventListener('click', () => { opts.setSelected(n.issueNumbers, !allPicked); renderDetails(); });
        details.append(show, pick);
        const related = adj[n.id].map(id => ({ id, e: edgeEls.find(e => (e.a === n.id && e.b === id) || (e.b === n.id && e.a === id)) }))
            .sort((x, y) => y.e.shared - x.e.shared);
        if (related.length) {
            details.appendChild(el('h4', {}, `Often appears with (${related.length})`));
            const ul = el('ul', { class: 'dg-list' });
            for (const { id, e } of related.slice(0, 20)) {
                const b = el('button', { type: 'button', class: 'dg-link' }, `"${data.nodes[id].phrase}"`);
                b.addEventListener('click', () => select(id));
                const li = el('li');
                li.append(b, document.createTextNode(` · ${e.shared} shared`));
                ul.appendChild(li);
            }
            details.appendChild(ul);
        }
        details.appendChild(el('h4', {}, W.noun.charAt(0).toUpperCase() + W.noun.slice(1)));
        const ul = el('ul', { class: 'dg-list' });
        for (const num of n.issueNumbers.slice(0, 40)) {
            const t = opts.thread(num);
            const li = el('li');
            if (t && t.url) li.appendChild(el('a', { href: t.url, target: '_blank', rel: 'noopener noreferrer' }, `#${num}`));
            else li.appendChild(document.createTextNode(`#${num}`));
            if (t && t.title) li.appendChild(document.createTextNode(` ${t.title.length > 70 ? `${t.title.slice(0, 69)}…` : t.title}`));
            ul.appendChild(li);
        }
        details.appendChild(ul);
        if (n.issueNumbers.length > 40) details.appendChild(el('p', { class: 'dg-muted' }, `and ${n.issueNumbers.length - 40} more: use "Show these in the list".`));
    }
    function select(id) {
        state.selected = id;
        highlight();
        renderDetails();
        if (id !== null) {
            const p = pos.get(id), r = stage.getBoundingClientRect();
            const sx = p.x * state.scale + state.tx, sy = p.y * state.scale + state.ty;
            if (sx < 40 || sy < 40 || sx > r.width - 40 || sy > r.height - 40) { state.tx = r.width / 2 - p.x * state.scale; state.ty = r.height / 2 - p.y * state.scale; applyTransform(); }
        }
    }

    const idFrom = t => { const g = t && t.closest ? t.closest('.pm-node') : null; return g ? Number(g.getAttribute('data-id')) : null; };
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
    stage.addEventListener('pointerup', () => { const d = drag; drag = null; stage.classList.remove('dg-grabbing'); if (d && !d.moved) select(d.id); });
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
    let at = -1;
    search.addEventListener('input', () => {
        const q = search.value.trim().toLowerCase();
        state.matches = q ? data.nodes.filter(n => n.phrase.includes(q)).map(n => n.id) : [];
        at = -1;
        matchInfo.textContent = q ? (state.matches.length ? `${state.matches.length} found, Enter for next` : 'No match') : '';
        highlight();
    });
    search.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || !state.matches.length) return;
        e.preventDefault();
        at = (at + 1) % state.matches.length;
        matchInfo.textContent = `${at + 1} of ${state.matches.length}`;
        select(state.matches[at]);
    });

    renderLegend();
    highlight();
    renderDetails();
    requestAnimationFrame(fit);
    return { destroy() { container.textContent = ''; container.classList.remove('dg'); } };
}
