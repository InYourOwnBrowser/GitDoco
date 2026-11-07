/**
 * Topic timeline: how many issues (or discussions) were opened each month (or week), split by
 * topic, to answer "is this getting worse?".
 *
 *   toTimelineData(...)     threads -> periods with counts and thread numbers per topic
 *   mountTopicTimeline(...) a stacked bar chart (SVG) with hover details, a clickable legend,
 *                           click-to-list, and a table view of the same numbers
 *
 * Titles and topic names come from GitHub, so they are only set as text, never as markup.
 */
import { mergeTopics, topicColor } from './issue-graph.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const DAY = 86400000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function periodStart(t, unit) {
    const d = new Date(t);
    if (unit === 'week') {
        const day = (d.getUTCDay() + 6) % 7; // Monday first
        return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
    }
    if (unit === 'quarter') return Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}
function nextPeriod(t, unit) {
    const d = new Date(t);
    if (unit === 'week') return t + 7 * DAY;
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + (unit === 'quarter' ? 3 : 1), 1);
}
export function periodLabel(t, unit) {
    const d = new Date(t);
    if (unit === 'week') return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    if (unit === 'quarter') return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`;
    return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * @param {object} args
 * @param {object[]} args.issues  { number, createdAtIso | createdAt }
 * @param {object[]} [args.clusters]
 * @returns {{ unit, topics, periods: { start, label, counts: number[], numbers: number[][], total }[], undated: number }}
 *   counts/numbers have one entry per topic, then one for "no topic" (last).
 */
export function toTimelineData({ issues, clusters = [] }) {
    const { topics, topicOf } = mergeTopics(clusters);
    const dated = [];
    let undated = 0;
    const seen = new Set();
    for (const iss of issues || []) {
        if (!iss || seen.has(iss.number)) continue;
        seen.add(iss.number);
        const t = Date.parse(iss.createdAtIso || iss.createdAt || '');
        if (Number.isFinite(t)) dated.push({ n: iss.number, t }); else undated++;
    }
    if (!dated.length) return { unit: 'month', topics, periods: [], undated };
    const first = Math.min(...dated.map(d => d.t)), last = Math.max(...dated.map(d => d.t));
    const spanDays = (last - first) / DAY;
    const unit = spanDays <= 120 ? 'week' : spanDays > 6 * 365 ? 'quarter' : 'month';
    const slots = topics.length + 1;
    const periods = [];
    const index = new Map();
    for (let t = periodStart(first, unit); t <= last; t = nextPeriod(t, unit)) {
        index.set(t, periods.length);
        periods.push({ start: t, label: periodLabel(t, unit), counts: new Array(slots).fill(0), numbers: Array.from({ length: slots }, () => []), total: 0 });
    }
    for (const d of dated) {
        const p = periods[index.get(periodStart(d.t, unit))];
        const slot = topicOf.has(d.n) ? topicOf.get(d.n) : topics.length;
        p.counts[slot]++;
        p.numbers[slot].push(d.n);
        p.total++;
    }
    return { unit, topics, periods, undated };
}

/** Round axis maximum and step (1, 2, 5 x 10^n) for about four gridlines. */
export function niceScale(max) {
    if (max <= 0) return { top: 1, step: 1 };
    const raw = max / 4;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 5, 10].map(m => m * mag).find(s => s >= raw);
    return { top: Math.ceil(max / step) * step, step: Math.max(1, step) };
}

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
/** A bar segment; the top one of a stack gets 4px rounded upper corners. */
function segmentPath(x, y, w, h, round) {
    const r = round ? Math.min(4, w / 2, h) : 0;
    if (!r) return `M${x},${y}h${w}v${h}h${-w}Z`;
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/**
 * @param {HTMLElement} container
 * @param {object} data  from toTimelineData
 * @param {object} opts  { words, thread(n), showInList(label, numbers), setSelected(numbers, on), isSelected(n) }
 */
export function mountTopicTimeline(container, data, opts) {
    const W = opts.words || { one: 'issue', noun: 'issues' };
    const unitWord = data.unit === 'week' ? 'week' : data.unit === 'quarter' ? 'quarter' : 'month';
    const state = { topic: null, picked: null, table: false };
    const slotName = s => (s < data.topics.length ? data.topics[s].label : 'No topic');
    const slotColor = s => (s < data.topics.length ? topicColor(data.topics, s) : 'var(--t-none)');

    container.textContent = '';
    container.classList.add('dg');
    if (!data.periods.length) {
        container.appendChild(el('p', { class: 'dg-empty' }, `No dates to plot for these ${W.noun}.`));
        return { destroy() { container.textContent = ''; container.classList.remove('dg'); } };
    }
    const toolbar = el('div', { class: 'dg-toolbar', role: 'toolbar', 'aria-label': 'Timeline controls' });
    const heading = el('span', { class: 'tl-heading' }, `New ${W.noun} per ${unitWord}, by topic`);
    const tableBtn = el('button', { type: 'button', class: 'dg-btn dg-toggle', 'aria-pressed': 'false' }, 'Table');
    toolbar.append(heading, tableBtn);
    const legend = el('div', { class: 'dg-legend', 'aria-label': 'Legend' });
    const body = el('div', { class: 'dg-body' });
    const stage = el('div', { class: 'tl-stage' });
    const tip = el('div', { class: 'tl-tip', role: 'status' });
    tip.hidden = true;
    const details = el('aside', { class: 'dg-details', 'aria-live': 'polite' });
    body.append(stage, details);
    container.append(toolbar, legend, body);

    function renderLegend() {
        legend.textContent = '';
        for (let s = 0; s <= data.topics.length; s++) {
            if (s === data.topics.length && !data.periods.some(p => p.counts[s])) continue;
            const item = el('button', { type: 'button', class: `dg-legend-item dg-legend-btn${state.topic === s ? ' active' : ''}`, 'aria-pressed': state.topic === s ? 'true' : 'false', title: 'Highlight this topic' });
            const sw = el('span', { class: 'dg-swatch', 'aria-hidden': 'true' });
            sw.style.background = slotColor(s);
            item.append(sw, document.createTextNode(slotName(s)));
            item.addEventListener('click', () => { state.topic = state.topic === s ? null : s; renderLegend(); render(); });
            legend.appendChild(item);
        }
        if (data.undated) legend.appendChild(el('span', { class: 'dg-hint' }, `${data.undated} without a date are not shown.`));
    }

    function showTip(e, p, s) {
        tip.textContent = '';
        tip.append(el('strong', {}, p.label), el('br'),
            document.createTextNode(`${slotName(s)}: ${p.counts[s]}`), el('br'),
            document.createTextNode(`All topics: ${p.total}`));
        tip.hidden = false;
        const r = stage.getBoundingClientRect();
        const x = Math.min(e.clientX - r.left + 12, r.width - 180);
        tip.style.left = `${Math.max(4, x)}px`;
        tip.style.top = `${Math.max(4, e.clientY - r.top - 60)}px`;
    }

    function renderChart() {
        const r = stage.getBoundingClientRect();
        const width = Math.max(320, r.width || 800), height = Math.max(220, (r.height || 400));
        const m = { top: 16, right: 16, bottom: 36, left: 40 };
        const cw = width - m.left - m.right, ch = height - m.top - m.bottom;
        const max = Math.max(...data.periods.map(p => p.total));
        const { top, step } = niceScale(max);
        const n = data.periods.length;
        const band = cw / n;
        const bw = Math.max(2, Math.min(48, band * 0.72));
        const chart = svg('svg', { class: 'tl-svg', width, height, role: 'img', 'aria-label': `Bar chart of new ${W.noun} per ${unitWord} by topic. The table view lists the same numbers.` });
        const g = svg('g', { transform: `translate(${m.left},${m.top})` });
        chart.appendChild(g);
        for (let v = 0; v <= top; v += step) {
            const y = ch - (v / top) * ch;
            g.appendChild(svg('line', { x1: 0, x2: cw, y1: y, y2: y, class: v === 0 ? 'tl-base' : 'tl-grid' }));
            const t = svg('text', { x: -6, y: y + 4, 'text-anchor': 'end', class: 'tl-axis' });
            t.textContent = String(v);
            g.appendChild(t);
        }
        const labelEvery = Math.ceil(70 / band);
        data.periods.forEach((p, i) => {
            const x = i * band + (band - bw) / 2;
            let y = ch;
            const order = [];
            for (let s = 0; s <= data.topics.length; s++) if (p.counts[s]) order.push(s);
            order.forEach((s, k) => {
                const h = (p.counts[s] / top) * ch;
                y -= h;
                const seg = svg('path', { d: segmentPath(x, y, bw, h, k === order.length - 1), class: `tl-seg${state.topic !== null && state.topic !== s ? ' tl-dim' : ''}${state.picked && state.picked.i === i && state.picked.s === s ? ' tl-picked' : ''}` });
                seg.style.fill = slotColor(s);
                seg.addEventListener('pointermove', e => showTip(e, p, s));
                seg.addEventListener('pointerleave', () => { tip.hidden = true; });
                seg.addEventListener('click', () => { state.picked = { i, s }; render(); renderDetails(); });
                g.appendChild(seg);
            });
            if (i % labelEvery === 0) {
                const t = svg('text', { x: i * band + band / 2, y: ch + 16, 'text-anchor': 'middle', class: 'tl-axis' });
                t.textContent = data.unit === 'week' ? p.label.replace(/ \d{4}$/, '') : p.label;
                g.appendChild(t);
            }
        });
        return chart;
    }

    function renderTable() {
        const wrap = el('div', { class: 'tl-table-wrap' });
        const table = el('table', { class: 'tl-table' });
        const head = el('tr');
        head.appendChild(el('th', { scope: 'col' }, unitWord.charAt(0).toUpperCase() + unitWord.slice(1)));
        const slots = [];
        for (let s = 0; s <= data.topics.length; s++) if (data.periods.some(p => p.counts[s])) slots.push(s);
        for (const s of slots) head.appendChild(el('th', { scope: 'col' }, slotName(s)));
        head.appendChild(el('th', { scope: 'col' }, 'Total'));
        const thead = el('thead'); thead.appendChild(head); table.appendChild(thead);
        const tbody = el('tbody');
        for (const p of [...data.periods].reverse()) {
            const tr = el('tr');
            tr.appendChild(el('th', { scope: 'row' }, p.label));
            for (const s of slots) tr.appendChild(el('td', {}, String(p.counts[s])));
            tr.appendChild(el('td', {}, String(p.total)));
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        wrap.appendChild(table);
        return wrap;
    }

    function render() {
        stage.textContent = '';
        stage.appendChild(state.table ? renderTable() : renderChart());
        stage.appendChild(tip);
    }

    function renderDetails() {
        details.textContent = '';
        if (!state.picked) {
            const total = data.periods.reduce((s, p) => s + p.total, 0);
            const busiest = data.periods.reduce((a, p) => (p.total > a.total ? p : a), data.periods[0]);
            const recent = data.periods.slice(-3).reduce((s, p) => s + p.total, 0);
            const before = data.periods.slice(-6, -3).reduce((s, p) => s + p.total, 0);
            details.append(
                el('h3', {}, `${total} ${W.noun} over ${data.periods.length} ${unitWord}${data.periods.length === 1 ? '' : 's'}`),
                el('p', {}, `Busiest ${unitWord}: ${busiest.label} (${busiest.total}).`)
            );
            if (data.periods.length >= 6) details.append(el('p', {}, `Last three ${unitWord}s: ${recent}, against ${before} in the three before${before ? ` (${recent >= before ? '+' : ''}${Math.round(((recent - before) / before) * 100)}%)` : ''}.`));
            details.append(el('p', { class: 'dg-muted' }, `Only loaded ${W.noun} are counted. Click a bar segment to see its ${W.noun}; click a topic in the legend to highlight it.`));
            return;
        }
        const p = data.periods[state.picked.i];
        const s = state.picked.s;
        const nums = p.numbers[s];
        details.append(el('h3', {}, `${slotName(s)}, ${p.label}`), el('p', {}, `${nums.length} new ${nums.length === 1 ? W.one : W.noun}.`));
        const show = el('button', { type: 'button', class: 'dg-btn' }, 'Show these in the list');
        show.addEventListener('click', () => opts.showInList(`${slotName(s)}, ${p.label}`, nums));
        const allPicked = nums.every(x => opts.isSelected(x));
        const pick = el('button', { type: 'button', class: `dg-btn${allPicked ? ' active' : ''}`, 'aria-pressed': allPicked ? 'true' : 'false' }, allPicked ? 'Selected for the AI' : 'Select these for the AI');
        pick.addEventListener('click', () => { opts.setSelected(nums, !allPicked); renderDetails(); });
        const clear = el('button', { type: 'button', class: 'dg-btn' }, 'Back to summary');
        clear.addEventListener('click', () => { state.picked = null; render(); renderDetails(); });
        details.append(show, pick, clear);
        const ul = el('ul', { class: 'dg-list' });
        for (const num of nums.slice(0, 50)) {
            const t = opts.thread(num);
            const li = el('li');
            if (t && t.url) li.appendChild(el('a', { href: t.url, target: '_blank', rel: 'noopener noreferrer' }, `#${num}`));
            else li.appendChild(document.createTextNode(`#${num}`));
            if (t && t.title) li.appendChild(document.createTextNode(` ${t.title.length > 70 ? `${t.title.slice(0, 69)}…` : t.title}`));
            ul.appendChild(li);
        }
        details.appendChild(ul);
    }

    tableBtn.addEventListener('click', () => {
        state.table = !state.table;
        tableBtn.classList.toggle('active', state.table);
        tableBtn.setAttribute('aria-pressed', state.table ? 'true' : 'false');
        render();
    });
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { if (!state.table) render(); }) : null;
    if (ro) ro.observe(stage);
    renderLegend();
    renderDetails();
    requestAnimationFrame(render);
    return { destroy() { if (ro) ro.disconnect(); container.textContent = ''; container.classList.remove('dg'); } };
}
