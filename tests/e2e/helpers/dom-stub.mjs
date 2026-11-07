/**
 * Minimal DOM stub so the real js/issues-app.js can run under node:test.
 * Element defaults (values, checked, selected options) are parsed from issues.html.
 * If you rename element ids in the HTML, nothing breaks: unknown ids get an inert stub.
 * But if you change a control's default or remove one that the app reads, update the assertions.
 */
import fs from 'fs';
const ROOT = new URL('../../../', import.meta.url).pathname.replace(/\/$/, '');
// Page to parse; set DOM_STUB_PAGE (e.g. via helpers/discussions-mode.mjs) before importing.
const html = fs.readFileSync(ROOT + '/' + (process.env.DOM_STUB_PAGE || 'issues.html'), 'utf8');
const registry = new Map();      // id -> El
const listeners = new Map();     // id -> {type: [fn]}

class El {
  constructor(id) { this.id = id; this.value = ''; this.checked = false; this.disabled = false; this.textContent = ''; this._innerHTML = '';
    this.style = {}; this.dataset = {}; this.children = []; this.className = ''; this.href = '#'; this.hidden = false;
    this.classList = { add(){}, remove(){}, toggle(){}, contains(){ return false; } }; }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(v) { this._innerHTML = v; if (v === '') this.children = []; }
  addEventListener(type, fn) { const m = listeners.get(this.id) || {}; (m[type] ||= []).push(fn); listeners.set(this.id, m); }
  removeEventListener() {}
  async click() { for (const fn of (listeners.get(this.id)?.click || [])) await fn({ target: this, preventDefault(){}, stopPropagation(){} }); }
  dispatchEvent() { return true; } setAttribute(){} getAttribute(){ return null; } removeAttribute(){}
  appendChild(c){ this.children.push(c); return c; } append(){} prepend(){} insertAdjacentHTML(){} remove(){} focus(){} blur(){} select(){} scrollIntoView(){}
  querySelector(){ return null; } querySelectorAll(){ return []; } closest(){ return null; } getBoundingClientRect(){ return {}; }
  set onclick(fn){ this.addEventListener('click', fn); } get options(){ return []; }
}
for (const m of html.matchAll(/<(input|select|textarea|button|div|span|a|section|pre|ul|table|tbody|p|label|header|nav)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
  const [tag, kind, id] = [m[0], m[1], m[2]]; const el = new El(id);
  if (kind === 'input') { const v = /\bvalue="([^"]*)"/.exec(tag); el.value = v ? v[1] : ''; el.checked = /\bchecked\b/.test(tag); }
  if (kind === 'select') { const block = html.slice(m.index, html.indexOf('</select>', m.index)); const sel = /<option[^>]*value="([^"]*)"[^>]*selected/.exec(block) || /<option[^>]*value="([^"]*)"/.exec(block); el.value = sel ? sel[1] : ''; }
  if (kind === 'textarea') el.value = '';
  registry.set(id, el);
}
globalThis.document = { getElementById: id => { if (!registry.has(id)) registry.set(id, new El(id)); return registry.get(id); }, createElement: () => new El('_c' + Math.random()), querySelector: () => null, querySelectorAll: () => [], createDocumentFragment: () => new El('frag'), createTextNode: t => ({ textContent: t }),
  addEventListener(){}, body: new El('body'), documentElement: new El('html'), head: new El('head') };
globalThis.window = globalThis; globalThis.location = { search: '', href: 'http://localhost/issues.html', origin: 'http://localhost' };
globalThis.localStorage = { getItem: () => null, setItem(){}, removeItem(){} };
globalThis.matchMedia = () => ({ matches: false, addEventListener(){} });
Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async () => {} } }, configurable: true });
const tok = await import(ROOT + '/js/tokenizer.js');
globalThis.Worker = class { constructor(url) { this.url = String(url); }
  postMessage(msg) { if (this.url.includes('tokenizer')) setTimeout(() => this.onmessage && this.onmessage({ data: { id: msg.id, tokens: tok.estimateTokens(msg.text) } }), 0); }
  terminate(){} };
export const fire = async (id, type, extraProps = {}) => {
  for (const fn of (listeners.get(id)?.[type] || [])) {
    const targetObj = Object.assign({}, registry.get(id), extraProps.target || {});
    const baseEvent = { target: targetObj, preventDefault(){}, stopPropagation(){} };
    await fn(Object.assign(baseEvent, extraProps, { target: targetObj }));
  }
};
export const el = (id) => document.getElementById(id);
export const wait = (ms) => new Promise(r => setTimeout(r, ms));
export { registry, listeners, ROOT };
