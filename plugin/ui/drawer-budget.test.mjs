// node ui/drawer-budget.test.mjs : the live drawer spend row follows the stats bar.
// A ticks-only budget (the live Claude Code goal) must not print $undefined.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
let fails = 0;
const ok = (n, c) => { if (!c) fails++; console.log((c ? 'ok   ' : 'FAIL ') + n); };

function classes(el) { return String(el.className || (el.attrs && el.attrs.class) || '').split(/\s+/).filter(Boolean); }
function matches(el, sel) {
  if (sel.startsWith('.')) return classes(el).includes(sel.slice(1));
  const dot = sel.indexOf('.');
  if (dot > 0) return el.tag === sel.slice(0, dot) && classes(el).includes(sel.slice(dot + 1));
  return el.tag === sel;
}
function query(root, sel, all) {
  const out = [];
  (function walk(n) {
    for (const c of n.children || []) { if (matches(c, sel)) out.push(c); walk(c); }
  })(root);
  return all ? out : (out[0] || null);
}
function mk(tag) {
  const el = {
    tag, id: '', className: '', hidden: false, children: [], attrs: {}, parentNode: null,
    type: '', value: '', scrollTop: 0, scrollHeight: 0, clientWidth: 1000, clientHeight: 600, _text: '',
    style: { setProperty(k, v) { this[k] = v; }, getPropertyValue(k) { return this[k] || ''; } },
  };
  el.classList = {
    add(c) { const s = new Set(classes(el)); s.add(c); el.className = [...s].join(' '); },
    remove(c) { el.className = classes(el).filter((x) => x !== c).join(' '); },
    toggle(c, force) { const on = force === undefined ? !classes(el).includes(c) : !!force; if (on) this.add(c); else this.remove(c); return on; },
    contains(c) { return classes(el).includes(c); },
  };
  el.appendChild = (c) => { if (c) { c.parentNode = el; el.children.push(c); } return c; };
  el.insertBefore = (node, ref) => {
    if (!node) return node;
    node.parentNode = el;
    const i = ref ? el.children.indexOf(ref) : el.children.length;
    el.children.splice(i < 0 ? el.children.length : i, 0, node);
    return node;
  };
  Object.defineProperty(el, 'nextSibling', { get() { if (!el.parentNode) return null; const i = el.parentNode.children.indexOf(el); return el.parentNode.children[i + 1] || null; } });
  el.removeChild = (c) => { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); return c; };
  Object.defineProperty(el, 'firstChild', { get() { return el.children[0] || null; } });
  el.setAttribute = (k, v) => { el.attrs[k] = String(v); if (k === 'class') el.className = String(v); if (k === 'id') el.id = String(v); };
  el.getAttribute = (k) => (k === 'class' ? el.className : (el.attrs[k] ?? null));
  el.removeAttribute = (k) => { delete el.attrs[k]; if (k === 'class') el.className = ''; };
  el.addEventListener = () => {};
  el.querySelector = (sel) => query(el, sel, false);
  el.querySelectorAll = (sel) => query(el, sel, true);
  el.getBoundingClientRect = () => ({ width: 1000, height: 600, left: 0, top: 0, right: 1000, bottom: 600 });
  el.getScreenCTM = () => null;
  el.focus = () => {};
  el.contains = (n) => n === el || el.children.some((c) => c.contains && c.contains(n));
  el.closest = () => null;
  el.dispatchEvent = () => true;
  Object.defineProperty(el, 'textContent', {
    get() { return el._text; },
    set(v) { el._text = v == null ? '' : String(v); el.children = []; },
  });
  return el;
}
function texts(n, acc = []) {
  if (n._text) acc.push(n._text);
  for (const c of n.children || []) texts(c, acc);
  return acc;
}

const ids = {};
function byId(id) { if (!ids[id]) ids[id] = mk(id); return ids[id]; }
function seed(id, el) { el.id = id; ids[id] = el; return el; }
const themeL = mk('span'); themeL.className = 'theme-l';
const streamsL = mk('span'); streamsL.className = 'theme-l';
seed('theme-btn', mk('button')).appendChild(themeL);
seed('streams-btn', mk('button')).appendChild(streamsL);
const dock = seed('dock', mk('section'));
const bar = mk('div'); bar.className = 'dock-bar';
const tabs = mk('div'); tabs.className = 'tabs';
bar.appendChild(tabs); dock.appendChild(bar);
const header = mk('header');
const goalbar = seed('goalbar', mk('button'));
header.appendChild(goalbar);
seed('graph', mk('svg'));
seed('dr-body', mk('div'));
seed('drawer', mk('aside'));
seed('dr-title', mk('h2'));
seed('dr-close', mk('button'));

const document = {
  documentElement: mk('html'),
  body: mk('body'),
  hidden: true,
  readyState: 'complete',
  activeElement: null,
  createElement: mk,
  createElementNS: (_ns, tag) => mk(tag),
  createTextNode: (t) => { const n = mk('#text'); n.textContent = String(t); return n; },
  getElementById: byId,
  addEventListener() {},
  querySelector: (sel) => query({ children: Object.values(ids) }, sel, false),
};
document.documentElement.clientWidth = 1200;
document.documentElement.clientHeight = 800;
const store = {};
const localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
const timers = [];
const window = {
  document, localStorage,
  matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
  addEventListener() {},
  dispatchEvent() { return true; },
  innerWidth: 1200, innerHeight: 800,
  setTimeout(fn, ms) { const id = setTimeout(fn, ms); if (id.unref) id.unref(); return id; },
  setInterval(fn, ms) { const id = setInterval(fn, ms); if (id.unref) id.unref(); timers.push(id); return id; },
  clearTimeout, clearInterval,
  performance: { now: () => 0 },
  CustomEvent: globalThis.CustomEvent || function CustomEvent() {},
  Event: globalThis.Event || function Event() {},
  console,
  fetch: () => Promise.reject(new Error('offline')),
  location: { href: 'http://127.0.0.1/' },
};
window.window = window;
const ctx = vm.createContext(window);
try {
  vm.runInContext(fs.readFileSync(path.join(dir, 'app.js'), 'utf8'), ctx, { filename: 'app.js' });
} catch (e) {
  console.log('FAIL app.js did not load: ' + (e && e.stack || e));
  process.exit(1);
}

function budgetText(budget) {
  const st = {
    mode: 'live', server_time: new Date().toISOString(),
    goal: { id: 'g-live', title: 'Live Claude Code activity', status: 'active', success_criteria: [], budget },
    heartbeat: { seq: 3, ts: new Date().toISOString(), interval_s: 30, status: 'running', consecutive_errors: 0 },
    agents: [], tasks: [], events: [], projects: [], collisions: [], alerts: [],
  };
  window.AosApp.setOverride(st);
  window.AosApp.selectAgent('orch');
  return texts(ids['dr-body']).join('\n');
}

const ticksOnly = budgetText({ max_ticks: 1000000 });
ok('ticks-only budget keeps the tick row', ticksOnly.includes('Ticks') && ticksOnly.includes('1000000'));
ok('ticks-only budget does not print an undefined spend', !ticksOnly.includes('Spent') && !ticksOnly.includes('undefined'));

const priced = budgetText({ max_ticks: 10, max_usd: 50, spent_usd: 1.5 });
ok('a dollar budget still shows spend', priced.includes('Spent') && priced.includes('$1.50 / $50'));

const noSpent = budgetText({ max_ticks: 10, max_usd: 12 });
ok('missing spent_usd with a cap shows zero', noSpent.includes('$0.00 / $12') && !noSpent.includes('undefined'));

for (const id of timers) clearInterval(id);
console.log(fails ? fails + ' FAILED' : 'drawer budget: all ok');
process.exit(fails ? 1 : 0);
