'use strict';
/* theme toggle: AUTO (follow OS, no data-theme) -> LIGHT -> DARK -> AUTO. The head script applies the saved choice before first paint. */
(function () {
  var KEY = 'aos.theme', NEXT = { auto: 'light', light: 'dark', dark: 'auto' }, LBL = { auto: 'Auto', light: 'Light', dark: 'Dark' };
  var root = document.documentElement, btn = document.getElementById('theme-btn');
  function cur() { var t = root.getAttribute('data-theme'); return t === 'light' || t === 'dark' ? t : 'auto'; }
  function paint() {
    if (!btn) return; var s = cur(), n = NEXT[s];
    btn.setAttribute('data-state', s); btn.querySelector('.theme-l').textContent = LBL[s];
    btn.setAttribute('aria-label', 'Theme: ' + s + (s === 'auto' ? ' (follows system)' : '') + '. Switch to ' + n);
    btn.title = 'Theme: ' + s + (s === 'auto' ? ' (follows system)' : '') + '. Click or press T to switch to ' + n;
  }
  function set(s) {
    if (s === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', s);
    try { if (s === 'auto') localStorage.removeItem(KEY); else localStorage.setItem(KEY, s); } catch (e) {}
    paint();
    try { if (window.AosFx && AosFx.refreshColors) AosFx.refreshColors(); window.dispatchEvent(new CustomEvent('aos-theme', { detail: { theme: s } })); } catch (e) {}
  }
  function cycle() { set(NEXT[cur()]); }
  paint();
  if (btn) btn.addEventListener('click', cycle);
  document.addEventListener('keydown', function (e) {
    if ((e.key !== 't' && e.key !== 'T') || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    var el = e.target, tag = el && el.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || (el && el.isContentEditable)) return;
    cycle();
  });
  window.AosTheme = { get: cur, set: set, cycle: cycle };
})();
/* streams toggle (STREAMS: FULL -> QUIET -> LINES): QUIET stops idle-edge particles; LINES draws static status-coded lines only (no particles, no waves, idle loop). */
/*streams:begin*/
(function () {
  var KEY = 'aos.streams', btn = document.getElementById('streams-btn'), ORDER = ['full', 'quiet', 'lines'], NAME = { full: 'Full', quiet: 'Quiet', lines: 'Lines' }, s = 'full';
  try { var v0 = localStorage.getItem(KEY); if (ORDER.indexOf(v0) >= 0) s = v0; } catch (e) {}
  function paint() {
    if (!btn) return; var n = ORDER[(ORDER.indexOf(s) + 1) % 3];
    btn.setAttribute('data-state', s); btn.querySelector('.theme-l').textContent = 'Streams: ' + NAME[s];
    btn.setAttribute('aria-label', 'Particle streams: ' + s + '. Switch to ' + n);
    btn.title = 'Particle streams: ' + s + '. Click or press Q to switch to ' + n;
  }
  function apply() { try { if (window.AosFx) { if (AosFx.setMode) AosFx.setMode(s); else if (AosFx.setQuiet) AosFx.setQuiet(s === 'quiet'); } } catch (e) {} }
  function set(v) {
    s = v === true ? 'quiet' : ORDER.indexOf(v) >= 0 ? v : 'full';
    try { if (s !== 'full') localStorage.setItem(KEY, s); else localStorage.removeItem(KEY); } catch (e) {}
    paint(); apply();
  }
  function toggle() { set(ORDER[(ORDER.indexOf(s) + 1) % 3]); }
  paint(); apply();
  document.addEventListener('DOMContentLoaded', apply);
  if (btn) btn.addEventListener('click', toggle);
  document.addEventListener('keydown', function (e) {
    if ((e.key !== 'q' && e.key !== 'Q') || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    var el = e.target, tag = el && el.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || (el && el.isContentEditable)) return;
    toggle();
  });
  window.AosStreams = { get: function () { return s; }, set: set, toggle: toggle };
})();
/*streams:end*/
(function () {
  var POLL_MS = 2000, NS = 'http://www.w3.org/2000/svg', CX = 500, CY = 300, GW = 1000, GH = 600;
  var TSTAT = ['running', 'needs_review', 'stalled', 'ready', 'pending', 'failed', 'done', 'cancelled'];
  var state = null, prev = null, lastOk = 0, failed = false, filterVal = '', searchVal = '', knownTypes = {}, showPrompts = false;
  var selected = null, nodes = {}, chips = {}, edges = {}, deps = {}, depInfo = {}, orchEl = null, seenSeq = null, lastFocus = null;
  var evSig = '', taskSig = '', openSeqs = {}, LVL = 0;
  var REDUCED = false;
  try { REDUCED = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion:reduce)').matches); } catch (e0) {}
  /* layout is static now: user pins of older builds are purged */
  try { localStorage.removeItem('aos.pins'); localStorage.removeItem('aos.pins2'); localStorage.removeItem('aos.pins3'); } catch (e1) {}
  var $ = function (id) { return document.getElementById(id); };

  /* panel geometry from the QUANTIZED panel size only (8px buckets); the viewBox is set by the planner (world = panel / fit scale) */
  var mq = window.matchMedia ? window.matchMedia('(max-width:720px)') : null;
  var L = null;
  function computeLayout(q) {
    var m = !!q.m; GW = q.w; GH = m ? 560 : q.h;
    if (!m) $('graph').style.height = '';
    var Rc = m ? 34 : Math.max(40, Math.min(56, Math.round(Math.min(GW, GH) * 0.09)));
    L = m ? { mobile: true, Rc: Rc, rs: 0.9, nameMax: 14, titleMax: 16, chipW: 128 }
          : { mobile: false, Rc: Rc, rs: 1, nameMax: 28, titleMax: 28, chipW: 215 };
    L.cw = L.ch = 2 * (L.rs * 18 + 6);
  }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function sv(tag, attrs, parent) {
    var e = document.createElementNS(NS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e); return e;
  }
  function clear(n) { if (!n) return document.createElement('div'); while (n.firstChild) n.removeChild(n.firstChild); return n; }
  function trunc(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function human(s) { return String(s || 'unknown').replace(/_/g, ' '); }
  function fmtAge(s) {
    if (s == null || isNaN(s)) return 'n/a';
    s = Math.max(0, Math.floor(s));
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
    return Math.floor(s / 3600) + 'h ' + Math.floor(s % 3600 / 60) + 'm';
  }
  function fmtTs(ts) { return ts ? String(ts).replace('T', ' ').replace(/\..*|Z$/, '') : ''; }
  function fmtRel(ts) {
    var s = (Date.now() - Date.parse(ts)) / 1000;
    if (isNaN(s)) return '';
    if (s < 5) return 'just now';
    if (s < 60) return Math.floor(s) + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }
  function fmtDur(s) {
    if (s == null || isNaN(s)) return 'n/a';
    s = Math.max(0, Math.floor(s));
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm ' + ('0' + (s % 60)).slice(-2) + 's';
    return Math.floor(s / 3600) + 'h ' + ('0' + Math.floor(s % 3600 / 60)).slice(-2) + 'm';
  }
  function pill(status) { return el('span', 'pill s-' + status, human(status)); }
  function setPos(e, x, y) { var v = 'translate(' + (Math.round(x * 100) / 100) + ' ' + (Math.round(y * 100) / 100) + ')'; if (e._tf !== v) { e._tf = v; e.setAttribute('transform', v); } }
  /* semantic zoom: node groups are counter-scaled by KN = min(1, 1/z) about their centre, so glyphs and labels keep their z=1 screen size when zoomed in */
  function kNode() { var z = WD.w / VW.w; return z > 1 ? 1 / z : 1; }
  function setNode(e, x, y, k) { var v = 'translate(' + (Math.round(x * 100) / 100) + ' ' + (Math.round(y * 100) / 100) + ')' + (k < 1 ? ' scale(' + (Math.round(k * 100000) / 100000) + ')' : ''); if (e._tf !== v) { e._tf = v; e.setAttribute('transform', v); } }
  function setA(e, k, v) { var c = e._a || (e._a = {}); v = String(v); if (c[k] !== v) { c[k] = v; e.setAttribute(k, v); } }
  function keyAct(fn) { return function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } }; }
  function isLive() { return !!(state && state.mode === 'live'); }
  /* agent ids look like "Claude Code·912b": name before the middle dot, short id after it */
  function splitId(id) {
    var s = String(id || ''), i; if (window.AosMachines) s = AosMachines.strip(s); i = s.lastIndexOf('·');
    if (i < 0) return { name: s.replace(/^agent[-_]/, ''), short: '' };
    return { name: s.slice(0, i).trim(), short: s.slice(i + 1).trim() };
  }
  function setLabel(valueId, txt) {
    var p = $(valueId).parentNode, l = p && p.querySelector('.stat-l');
    if (l && l.textContent !== txt) l.textContent = txt;
  }

  /* ---------- optional per-agent live fields (tool feed, stuck, collisions) ---------- */
  function toolName(a) { var t = a && a.current_tool; return t ? (typeof t === 'string' ? t : t.name || '') : ''; }
  function fmtCompact(s) { s = Math.max(0, Math.floor(+s || 0)); return s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm' : Math.floor(s / 3600) + 'h' + (Math.floor(s % 3600 / 60) ? Math.floor(s % 3600 / 60) + 'm' : ''); }
  function fmtMs(ms) { return ms == null || isNaN(ms) ? '…' : ms < 1000 ? Math.round(ms) + 'ms' : ms < 60000 ? (ms / 1000).toFixed(1) + 's' : fmtDur(ms / 1000); }
  function fmtK(n) { n = +n || 0; return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'k' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n); }
  function baseName(f) { return String(f || '').split(/[\\/]/).filter(Boolean).pop() || String(f || ''); }
  function collOf(id) { return ((state && state.collisions) || []).filter(function (c) { return c && (c.agents || []).indexOf(id) >= 0; }).map(function (c) { return { name: c.name || baseName(c.file), file: c.file, agents: c.agents || [], ts: c.ts }; }); }
  function agentById(id) { return id === '__orch' || id === 'orch' ? mergedMain() : ((state && state.agents) || []).filter(function (a) { return a.id === id; })[0]; }
  function openAgent(id) { if (id === 'orch' || id === '__heart') openDrawer('orch'); else if (nodes[id] || hubEls[id]) openDrawer(id); }

  function liveness(hb) {
    if (!hb || !hb.ts || !hb.interval_s) return { l: 'dead', age: null };
    var age = (Date.now() - Date.parse(hb.ts)) / 1000;
    if (isNaN(age)) return { l: 'dead', age: null };
    if (hb.status && hb.status !== 'running') return { l: hb.status, age: age };
    var i = hb.interval_s;
    return { l: age < 1.5 * i ? 'alive' : age < 3 * i ? 'late' : 'dead', age: age };
  }
  /* live mode: the heartbeat only says when Claude Code last did something, so quiet is STANDBY (neutral), never DEAD */
  function dispLive(l) {
    if (isLive()) { if (l === 'alive') return 'active'; if (l === 'late' || l === 'dead') return 'standby'; }
    return l;
  }
  function liveText(lv, hb) {
    return hb && lv.age != null ? 'last activity ' + (lv.age < 2 ? 'just now' : fmtAge(lv.age) + ' ago') : 'no activity yet';
  }
  function taskById(id) { return state && (state.tasks || []).filter(function (t) { return t.id === id; })[0]; }

  /* ---------- goal bar ---------- */
  function renderGoal(g) {
    var segs = clear($('goal-segs')), gt = $('goal-title'), live = isLive();
    gt.classList.remove('skeleton-text');
    segs.hidden = live; $('goal-count').classList.toggle('sum', live);
    if (!g) {
      gt.textContent = 'No active goal'; $('goal-status').hidden = true; $('goal-count').textContent = '';
      segs.setAttribute('aria-valuenow', 0); return;
    }
    gt.textContent = g.title || '(untitled goal)';
    var st = $('goal-status'); st.hidden = live && g.status === 'active'; st.className = 'pill s-' + g.status; st.textContent = human(g.status);
    var cs = g.success_criteria || [], met = cs.filter(function (c) { return c.met; }).length;
    cs.forEach(function (c) { var i = el('i', c.met ? 'met' : ''); i.title = c.text || c.id; segs.appendChild(i); });
    segs.setAttribute('aria-valuenow', cs.length ? Math.round(met / cs.length * 100) : 0);
    segs.setAttribute('aria-valuetext', met + ' of ' + cs.length + ' criteria met');
    if (live) {
      var ag = state.agents || [], rn = ag.filter(function (a) { return a.status === 'running'; }).length, md0 = MODEL || buildModel();
      $('goal-count').textContent = (md0.implicit ? '' : cnt(md0.hubs.length, 'project', 'projects') + ' · ') + cnt(ag.length, 'agent', 'agents') + ' · ' + rn + ' running';
      $('goalbar').setAttribute('aria-label', (g.title || 'Goal') + '. ' + $('goal-count').textContent + '. Open goal details');
    } else { $('goal-count').textContent = cs.length ? met + '/' + cs.length : 'no criteria'; $('goalbar').setAttribute('aria-label', 'Goal and success criteria. Open goal details'); }
  }

  /* ---------- stat strip ---------- */
  function setStat(id, html, pct) {
    var e = $(id); clear(e);
    if (html && html.length) { e.appendChild(document.createTextNode(html[0])); if (html[1]) e.appendChild(el('small', null, html[1])); }
    var b = $(id + '-bar'); if (b && pct != null) b.style.width = Math.max(0, Math.min(100, pct)) + '%';
  }
  function renderStats() {
    if (!state) return;
    var tasks = state.tasks || [], done = tasks.filter(function (t) { return t.status === 'done'; }).length;
    var g = state.goal, hb = state.heartbeat, b = g && g.budget;
    setStat('st-tasks', [String(done), ' / ' + tasks.length], tasks.length ? done / tasks.length * 100 : 0);
    if (isLive()) {
      var agents = state.agents || [], running = agents.filter(function (a) { return a.status === 'running'; }).length;
      setLabel('st-ticks', 'Events'); setLabel('st-spend', 'Active');
      setStat('st-ticks', [String(hb ? hb.seq : 0)], 0);
      setStat('st-spend', [String(running), ' / ' + agents.length], agents.length ? running / agents.length * 100 : 0);
    } else {
      setLabel('st-ticks', 'Ticks'); setLabel('st-spend', 'Spend');
      if (hb) setStat('st-ticks', [String(hb.seq), b && b.max_ticks ? ' / ' + b.max_ticks : ''], b && b.max_ticks ? hb.seq / b.max_ticks * 100 : 0);
      else setStat('st-ticks', ['0', b && b.max_ticks ? ' / ' + b.max_ticks : ''], 0);
      if (b && b.max_usd != null) setStat('st-spend', ['$' + Number(b.spent_usd || 0).toFixed(2), ' / $' + b.max_usd], b.max_usd ? (b.spent_usd || 0) / b.max_usd * 100 : 0);
      else setStat('st-spend', ['n/a'], 0);
    }
    var start = g && (g.created_at || g.started_at) || (state.events && state.events[0] && state.events[0].ts);
    var term = !g || ['achieved', 'failed', 'cancelled'].indexOf(g.status) >= 0 || (hb && hb.status === 'stopped');
    var t0 = Date.parse(start), t1 = term && hb && hb.ts ? Date.parse(hb.ts) : Date.now();
    setStat('st-uptime', [isNaN(t0) ? 'n/a' : fmtDur((t1 - t0) / 1000)]);
  }

  /* ---------- graph: HEART -> PROJECT hubs -> AGENTS, free physics with hard no-overlap rules ----------
     Layout planning is a pure function of a quantized signature: panel size in 8px buckets (re-planned only when it moves by
     more than 24px), the project / agent SET and their names. Status, tools, tokens, timestamps and DOM text measurement never
     feed the planner, so a poll with unchanged data cannot re-plan, and the chosen label level / fit scale cannot flip. */
  var HEART = '__heart', N = {}, NL = [], EL = [], hubEls = {}, sticky = {}, MODEL = null, SIG = '', applied = null, SIGZ = '', SYNC = { added: [], hard: false };
  var WD = { w: 1000, h: 600, s: 1, hx: 500, hy: 300, fit: -1, obs: [] }, layoutRuns = 0, simFrames = 0;
  var DT = 1 / 120, DAMP = Math.exp(-7 / 120), VMAX = 1400, VREST = 5, KREP = 2.4e6, CUT2 = 760 * 760, KC = 0.12, KW = 28, SECT = 36;
  window.__aosLayoutRuns = 0;
  /* text width estimates (em units, SF/Inter-like, deliberately generous): never measured from the DOM */
  var CWT = {}; (function () { var k, t = { ' ': .3, 'i': .27, 'l': .27, 'j': .29, '.': .3, ',': .3, ':': .3, ';': .3, '|': .3, '!': .3, "'": .25, 'f': .38, 't': .38, 'r': .4, '(': .38, ')': .38, '[': .36, ']': .36, 'I': .3, 'm': .88, 'w': .8, 'M': .92, 'W': 1.0, '·': .34, '…': .94, '-': .44, '_': .58, '/': .4 }; for (k in t) CWT[k] = t[k]; })();
  function sansW(s, fs, bold) { s = String(s); var w = 0, i, c; for (i = 0; i < s.length; i++) { c = s.charAt(i); w += CWT[c] != null ? CWT[c] : c >= 'A' && c <= 'Z' ? .69 : c >= '0' && c <= '9' ? .6 : c >= 'a' && c <= 'z' ? .555 : .7; } return w * fs * (bold ? 1.05 : 1.01) + 2; }
  function monoW(s, fs, ls) { return String(s).length * (0.62 * fs + ls) + 2; }
  var LH = { n: 19, s: 16, c: 18, m: 15 };
  /* label levels: 0 full, 1 no task line, 2 no model line, 3 one-line names (18 chars) + status, 4 one short line */
  var LVS = [{ task: 1, model: 1, sub: 1, lines: 2, fs: 1 }, { task: 0, model: 1, sub: 1, lines: 2, fs: 1 }, { task: 0, model: 0, sub: 1, lines: 2, fs: 0.88 }, { task: 0, model: 0, sub: 1, lines: 1, fs: 0.88, nmax: 18 }, { task: 0, model: 0, sub: 0, lines: 1, fs: 0.85, nmax: 12 }];
  var FITS = [[0, 1], [1, 1], [2, 1], [2, .9], [3, 1], [3, .9], [2, .8], [3, .8], [3, .72], [4, .72], [4, .64], [4, .56], [4, .49], [4, .43], [4, .37], [4, .32], [4, .27], [4, .23], [4, .2]];
  var FITS_M = [[0, 1], [1, 1], [2, 1], [3, 1], [4, 1], [4, 1.3], [4, 1.7]];
  function hash(str) { var h = 2166136261; str = String(str); for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h * 16777619) >>> 0; } return h; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  /* wrap a label into at most 2 balanced lines of <= max chars; ellipsis only beyond that */
  function wrapLabel(t, max) {
    t = String(t || '').replace(/\s+/g, ' ').trim();
    if (t.length <= max) return [t];
    var w = t.split(' '), best = null, bi = 1e9, i, a, b;
    for (i = 1; i < w.length; i++) {
      a = w.slice(0, i).join(' '); b = w.slice(i).join(' ');
      if (a.length <= max && b.length <= max && Math.max(a.length, b.length) < bi) { bi = Math.max(a.length, b.length); best = [a, b]; }
    }
    if (best) return best;
    a = ''; for (i = 0; i < w.length && (a ? a + ' ' + w[i] : w[i]).length <= max; i++) a = a ? a + ' ' + w[i] : w[i];
    if (!a) { a = t.slice(0, max); b = t.slice(max); } else b = w.slice(i).join(' ');
    return [a, trunc(b, max)];
  }
  function isMain(id) { return splitId(id).name === 'Claude Code'; }
  function mainSessions() { return ((state && state.agents) || []).filter(function (a) { return isMain(a.id); }); }
  /* every agent is an orb on its project's cluster: no session is merged into the centre any more */
  function mergedMain() { return null; }
  function sessionDisp(a, lv) {
    if (a.status === 'running') return 'running';
    if (a.status === 'idle') return lv.l === 'alive' ? 'idle' : 'standby';
    return a.status;
  }
  function taskLineFor(a) {
    var ct = chipTask(a); if (!ct) return null;
    var lab = splitId(a.id).name.toLowerCase(), tt = String(ct.t.title || ct.t.id).toLowerCase();
    return (tt === lab || lab.indexOf(tt) >= 0 || tt.indexOf(lab) >= 0) ? null : ct;
  }
  function chipTask(a) {
    if (a.current_task) return { t: taskById(a.current_task) || { id: a.current_task, title: a.current_task, status: 'running' }, dim: false };
    var mine = (state.tasks || []).filter(function (t) { return t.assignee === a.id; })
      .sort(function (x, y) { return String(y.updated_at).localeCompare(String(x.updated_at)); });
    return mine.length ? { t: mine[0], dim: true } : null;
  }
  /* chip title truncated so its estimated width always fits the reserved chip width */
  function chipTitle(t) { var s = String(t || ''), W0 = L.chipW - 16; if (sansW(s, 12) <= W0) return s; while (s.length > 1 && sansW(s + '…', 12) > W0) s = s.slice(0, -1); return s + '…'; }
  function nameFs(lvl) { return lvl < 2 ? (L.mobile ? 14.5 : 15.5) : lvl < 4 ? 13.5 : 13; }
  function subFs(lvl) { return lvl === 2 || lvl === 3 ? 11 : L.mobile ? 11.5 : 12; }

  /* ---- model: projects (from state.projects, else agent.project fields, else implicit: agents hang off the heart) ---- */
  function hubStatus(list) {
    var r = 0, s = 0, e = 0; list.forEach(function (a) { if (a.status === 'running') r++; else if (a.status === 'stalled') s++; else if (a.status === 'errored') e++; });
    return { st: r ? 'running' : s ? 'stalled' : e ? 'errored' : 'idle', running: r, stalled: s, errored: e };
  }
  function buildModel() {
    var ag = (state && state.agents) || [], pr = state && Array.isArray(state.projects) && state.projects.length ? state.projects : null, out = [], idx = {}, owner = {};
    function add(id, name) { var k = String(id); if (idx[k] == null) { idx[k] = out.length; out.push({ id: k, key: 'p:' + k, name: String(name || k), agents: [], src: null }); } return out[idx[k]]; }
    if (pr) pr.forEach(function (p) { if (p && p.id != null) { add(p.id, p.name).src = p; (p.agents || []).forEach(function (id) { if (owner[id] == null) owner[id] = String(p.id); }); } });
    var implicit = !pr && !ag.some(function (a) { return a.project_id != null || a.project; });
    if (!implicit) ag.forEach(function (a) {
      var pid = owner[a.id] != null ? owner[a.id] : a.project_id != null ? String(a.project_id) : a.project ? String(a.project) : 'unknown';
      add(pid, a.project || pid).agents.push(a);
    });
    out = out.filter(function (p) { return p.agents.length; });
    out.forEach(function (p) { p.agents.sort(function (x, y) { return hash(x.id) - hash(y.id) || (x.id < y.id ? -1 : 1); }); });
    return { implicit: implicit, hubs: out, agents: implicit ? ag.slice().sort(function (x, y) { return hash(x.id) - hash(y.id) || (x.id < y.id ? -1 : 1); }) : null };
  }
  function projOfKey(key) { return MODEL && MODEL.hubs.filter(function (p) { return p.key === key; })[0]; }
  function sigOf(md) {
    var parts = [L.mobile ? 'm' : 'd', applied.w, applied.h, md.implicit ? 'i' : 'p'];
    if (md.implicit) md.agents.forEach(function (a) { parts.push(a.id + (sticky[a.id] ? '+' : '')); });
    else md.hubs.forEach(function (p) { parts.push(p.key + '=' + p.name + '#' + p.agents.map(function (a) { return a.id + (sticky[a.id] ? '+' : ''); }).join(',')); });
    return parts.join('|');
  }

  /* model with its reasoning effort when the transcript recorded one: "Opus 5.5 · xhigh" */
  function modelTxt(a) { var ml = a && a.model_label ? String(a.model_label) : ''; return ml && a.effort ? ml + ' · ' + a.effort : ml; }

  /* ---- node metrics (world units == css px at scale 1) ---- */
  function agentLab(a, lvl) {
    var V = LVS[lvl], sp = splitId(a.id), fs = nameFs(lvl), nmax = V.nmax || L.nameMax, w = 0;
    var lines = V.lines === 1 ? [trunc(sp.name, nmax)] : wrapLabel(sp.name, nmax);
    lines.forEach(function (t) { w = Math.max(w, sansW(t, fs, true)); });
    var hasM = !!V.model, hasT = !!V.task && !!sticky[a.id];
    if (V.sub) w = Math.max(w, monoW((sp.short ? sp.short + ' · ' : '') + 'XXXXXXXX' + (hasM ? '' : 'XXXXXXXX'), subFs(lvl), 0.72));
    if (hasM) w = Math.max(w, monoW('● NO SIGNAL 23H59M', 11, 1.1), monoW('● ' + modelTxt(a), 11, 1.1));
    if (hasT) w = Math.max(w, L.chipW);
    var h = lines.length * LH.n * V.fs + (V.sub ? LH.s : 0) + (hasM ? LH.m : 0) + (hasT ? LH.c + 4 : 4);
    return { lines: lines, w: Math.ceil(w) + 6, h: Math.ceil(h) + 2, V: V, hasM: hasM, hasT: hasT };
  }
  function cnt(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function hubLab(p) {
    var lines = wrapLabel(p.name, 20), n = p.agents.length, w = 0;
    lines.forEach(function (t) { w = Math.max(w, sansW(t, 14, true)); });
    w = Math.max(w, monoW(cnt(n, 'agent', 'agents') + ' · ' + n + ' running', 11, 0.66));
    return { lines: lines, w: Math.ceil(w) + 6, h: lines.length * 18 + 21 };
  }
  function orbR(a) { return Math.round((isMain(a.id) ? 16 : 12) * L.rs); }
  function setMetrics(n, lvl) {
    var c = n.kids ? n.kids.length : 0;
    if (n.kind === 'heart') {
      n.R = L.Rc; n.cr = L.Rc + 14; n.lo = L.Rc + 8; n.lw = L.mobile ? 200 : 214; n.lh = 84; n.q = 3; n.ks = 0;
    } else if (n.kind === 'hub') {
      var hl = hubLab(n.p); n.m = hl; n.R = Math.round(15 + 6 * Math.log(1 + c)); n.cr = n.R + 10; n.lo = n.R + 5; n.lw = hl.w; n.lh = hl.h;
      n.q = TU.hq + 0.08 * c; n.ks = TU.hk;

    } else {
      var R0 = orbR(n.a) + 2, par = N[n.parent], pc = par && par.kids ? par.kids.length : 1, m = agentLab(n.a, lvl);
      n.m = m; n.R = R0 + 6; n.cr = R0 + 12; n.lo = R0 + 10; n.lw = m.w; n.lh = m.h; n.q = 1; n.ks = TU.ks;

    }
    setSide(n, n.side || 'b');
  }
  /* rest lengths from the area the children's footprints need, stretched along the panel's long axis */
  function setRests() {
    var ex = L.mobile ? 1 : clamp(Math.sqrt(WD.w / WD.h), 1, 1.8), P = NL.filter(function (n) { return n.kind === 'hub'; }).length;
    NL.forEach(function (n) {
      if (!n.kids || !n.kids.length) { n.rho = n.cr; return; }
      var ar = 0; n.kids.forEach(function (id) { var k = N[id]; ar += (k.lw + k.lo + k.cr + 14) * (Math.max(k.lh, 2 * k.cr) + 14) * 0.5 + k.lw * (k.lh + k.lo + k.cr + 14) * 0.5; });
      n.rho = n.R + 16 + Math.sqrt(ar * 1.15 / Math.PI);
    });
    /* angular sector of each hub around the heart (backend order, weighted by size): used by the initial layout and the sector force */
    var hubsS = NL.filter(function (n) { return n.kind === 'hub'; }), wt = hubsS.map(function (h) { return Math.sqrt(h.kids.length) + 0.8; }), tw0 = 0, acc0 = 0;
    wt.forEach(function (w) { tw0 += w; });
    hubsS.forEach(function (h, i) { var arc = 360 - 2 * 72; h.sa = (90 + 72 + (acc0 + wt[i] / 2) / tw0 * arc) * Math.PI / 180; h.sh = wt[i] / tw0 * arc / 2 * Math.PI / 180; acc0 += wt[i]; });
    NL.forEach(function (n) {
      var p = N[n.parent]; if (!p) return;
      if (n.kind === 'hub') { n.rest = L.mobile ? 0 : P === 1 ? Math.max(L.Rc + n.R + 90, 0.26 * Math.min(WD.w, WD.h), TU.pd * (n.R + 18 + TU.ar * (n.rho - n.R)), TU.pw * WD.w) : Math.max(L.Rc + 40 + TU.hr * n.rho, TU.hw * n.rho / Math.sin(Math.min(n.sh || 1, 1.3))); n.an = ex; }
      else if (p.kind === 'heart') { n.rest = L.Rc + 60 + 0.62 * p.rho; n.an = ex; }
      else { n.rest = p.R + 18 + TU.ar * (p.rho - p.R); n.an = L.mobile ? 0.6 : P === 1 ? TU.pe * ex + (1 - TU.pe) * Math.sqrt(ex) : Math.sqrt(ex); }
    });
    if (L.mobile) {
      /* phone: a column of hubs down the left edge; each hub's agents form a column to its right, starting below the hub label */
      var y = 0, hubsM = NL.filter(function (n) { return n.kind === 'hub'; });
      (hubsM.length ? hubsM : [N[HEART]]).forEach(function (h) {
        if (h.kind === 'hub') { y += 64; h.rest = y; }
        var yy = h.kind === 'hub' ? 0 : 40, top = h.kind === 'hub' ? Math.max(h.lh / 2 + 34, 70) : 40;
        (h.kids || []).forEach(function (id, j) { var k = N[id], row = Math.max(k.lh, 2 * k.cr) + 12; k.mdx = 96 + (j % 2) * 18; k.mdy = top + yy + row / 2; yy += row; k.rest = Math.sqrt(k.mdx * k.mdx + k.mdy * k.mdy); k.an = 1; });
        y += top + yy + 24;
      });
      WD.col = y + 60;
    }
  }
  function setSide(n, sd) {
    var o = n.lo, w = n.lw, h = n.lh; n.side = sd;
    if (sd === 'r') { n.rx1 = o; n.rx2 = o + w; n.ry1 = -h / 2; n.ry2 = h / 2; }
    else if (sd === 'l') { n.rx1 = -o - w; n.rx2 = -o; n.ry1 = -h / 2; n.ry2 = h / 2; }
    else if (sd === 'b') { n.rx1 = -w / 2; n.rx2 = w / 2; n.ry1 = o; n.ry2 = o + h; }
    else if (sd === 't') { n.rx1 = -w / 2; n.rx2 = w / 2; n.ry1 = -o - h; n.ry2 = -o; }
    else { /* hub labels: on the heart-facing side, just above / below the incoming trunk ('ru','rd','lu','ld') */
      var hx0 = sd.charAt(0) === 'r'; n.rx1 = hx0 ? o : -o - w; n.rx2 = hx0 ? o + w : -o;
      if (sd.charAt(1) === 'u') { n.ry1 = -16 - h; n.ry2 = -16; } else { n.ry1 = 16; n.ry2 = 16 + h; }
    }
    n.ty = n.ry1;
    /* text halo (paint-order stroke) counts in some engines' text boxes: inflate the block */
    n.rx1 -= 5; n.rx2 += 5; n.ry1 -= 4; n.ry2 += 4;
    n.bx1 = Math.min(-n.cr, n.rx1); n.bx2 = Math.max(n.cr, n.rx2); n.by1 = Math.min(-n.cr, n.ry1); n.by2 = Math.max(n.cr, n.ry2);
  }
  /* label side: outward from the parent, snapped by angle, with hysteresis so it never flaps */
  function pickSide(n) {
    if (n.kind === 'heart') return L.mobile ? 'r' : 'b';
    var p = N[n.parent]; if (!p) return n.side || 'b';
    var dx = n.x - p.x, dy = n.y - p.y, d = Math.sqrt(dx * dx + dy * dy); if (d < 1) return n.side || 'b';
    var c = dx / d, s = dy / d, cur = n.side, hz = Math.abs(c);
    if (L.mobile) return 'r';
    /* hubs label sideways only: a label above/below a hub would block a wide cone of its own branches */
    if (n.kind === 'hub') {
      /* the hub label faces the heart (the cluster points outward), above or below the trunk */
      var H0 = N[HEART], hx = H0.x - n.x, hy = H0.y - n.y, hd = Math.sqrt(hx * hx + hy * hy) || 1, hc = hx / hd, hs = hy / hd;
      var h1 = cur && cur.length === 2 && Math.abs(hc) < 0.25 ? cur.charAt(0) : hc >= 0 ? 'r' : 'l';
      var h2 = cur && cur.length === 2 && Math.abs(hs) < 0.08 ? cur.charAt(1) : hs >= 0 ? 'u' : 'd';
      return h1 + h2;
    }
    if (cur === 'r' || cur === 'l') { if (hz >= 0.34 && (c > 0) === (cur === 'r')) return cur; }
    else if ((cur === 't' || cur === 'b') && hz < 0.46 && (s < 0) === (cur === 't')) return cur;
    return hz >= 0.4 ? (c > 0 ? 'r' : 'l') : (s < 0 ? 't' : 'b');
  }
  function sidesAll() { for (var i = 0; i < NL.length; i++) { var n = NL[i], sd = pickSide(n); if (sd !== n.side) setSide(n, sd); } }
  function invM(n) { return n.kind === 'heart' ? 0 : n.kind === 'hub' ? TU.hm : 1; }

  /* ---- world: viewBox = quantized panel size / scale; static reservations for HUD chrome (never measured) ---- */
  function setWorld(s, mobH) {
    var ow = WD.w, oh = WD.h, ohx = WD.hx, ohy = WD.hy;
    WD.s = s; WD.w = GW / s; WD.h = L.mobile ? mobH : GH / s;
    WD.hx = L.mobile ? L.Rc + 20 : WD.w / 2; WD.hy = L.mobile ? L.Rc + 36 : WD.h / 2;
    var k = 1 / s, W0 = WD.w, H0 = WD.h, o = [];
    if (L.mobile) o.push([0, H0 - 124, W0, H0]);
    else {
      o.push([0, 0, 760 * k, 92 * k]);                       /* stat strip */
      o.push([W0 - 430 * k, 0, W0, 284 * k]);                /* reset-layout, token readout and the alert toast column */
      o.push([0, H0 - 52 * k, 560 * k, H0]);                 /* legend */
      o.push([W0 - 300 * k, H0 - 52 * k, W0, H0]);           /* updated */
    }
    WD.obs = o; WD.mg = 8 * k;
    var svg = $('graph'); svg.setAttribute('viewBox', '0 0 ' + (Math.round(WD.w * 100) / 100) + ' ' + (Math.round(WD.h * 100) / 100));
    if (L.mobile) svg.style.height = Math.round(WD.h) + 'px';
    return { dx: WD.hx - ohx, dy: WD.hy - ohy, sx: WD.w / ow, sy: WD.h / oh };
  }

  /* ---- forces + position-based constraints ---- */
  function stepPhys() {
    SECK = NL.length && N[HEART].kids.length > 1 && MODEL && !MODEL.implicit ? TU.sk : 0;
    var i, j, a, b, dx, dy, d2, d, f, n = NL.length, e, mw = 40 / WD.s, maxv = 0, p;
    for (i = 0; i < n; i++) { a = NL[i]; a.fx = 0; a.fy = 0; a.ox = a.x; a.oy = a.y; a.w = invM(a); }
    for (i = 0; i < n; i++) {
      a = NL[i]; p = a.parent ? N[a.parent] : null;
      if (p) {
        dx = p.x - a.x; dy = p.y - a.y; d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        var an = a.an || 1, ca = dx / d, sa = dy / d; f = SPRK * a.ks * (d - a.rest / Math.sqrt(ca * ca / (an * an) + sa * sa * an * an)) / d; a.fx += f * dx; a.fy += f * dy; p.fx -= 0.3 * f * dx; p.fy -= 0.3 * f * dy;
        /* cone force: keep children out of the angular shadow of the parent's label (their stream would cross it) */
        var cd = p.kind === 'heart' || p.kind === 'hub' ? SIDEDEG[p.side] : -1;
        if (cd >= 0) {
          var hw = p.side === 't' || p.side === 'b' ? (p.kind === 'heart' ? 74 : 72) : p.side.length === 2 ? 52 : 44, ang = Math.atan2(-dy, -dx) * 180 / Math.PI, da = ((ang - cd + 540) % 360) - 180;
          if (Math.abs(da) < hw) { var sg = da >= 0 ? 1 : -1, tf = 14 * CONEK * (hw - Math.abs(da)) / hw * d; if (da === 0) sg = hash(a.id) % 2 ? 1 : -1; a.fx += sg * (dy / d) * tf; a.fy += sg * (-dx / d) * tf; }
        }
        if (p.kind === 'hub' && !L.mobile) {
          /* back cone: a hub's agents stay off the heart side, so the cluster points outward */
          var Hb = N[HEART], bd0 = Math.atan2(Hb.y - p.y, Hb.x - p.x) * 180 / Math.PI, ang2 = Math.atan2(-dy, -dx) * 180 / Math.PI, db = ((ang2 - bd0 + 540) % 360) - 180, bw = TU.bc;
          if (Math.abs(db) < bw) { var sb = db >= 0 ? 1 : -1, tb = TU.bk * CONEK * (bw - Math.abs(db)) / bw * d; if (db === 0) sb = hash(a.id) % 2 ? 1 : -1; a.fx += sb * (dy / d) * tb; a.fy += sb * (-dx / d) * tb; }
        }
      }
      for (j = i + 1; j < n; j++) {
        b = NL[j]; if (!a.w && !b.w) continue;
        if (b.parent === a.id || a.parent === b.id) { if (a.kind === 'hub' || b.kind === 'hub') continue; }   /* a hub is its cluster's centre: no push from its own agents */
        dx = a.x - b.x; dy = a.y - b.y; d2 = dx * dx + dy * dy; if (d2 > CUT2) continue; if (d2 < 400) d2 = 400;
        d = Math.sqrt(d2); f = REPK * KREP * a.q * b.q * (a.cl === b.cl ? 1 : TU.xr) * ((a.kind === 'heart' && b.kind === 'agent') || (b.kind === 'heart' && a.kind === 'agent') ? TU.ha : 1) / (d2 * d);
        a.fx += f * dx; a.fy += f * dy; b.fx -= f * dx; b.fy -= f * dy;
      }
      if (SECK && a.kind === 'hub' && !L.mobile) {
        /* wedge force: a hub stays inside its own angular sector around the heart (clusters stay apart) */
        var H0 = N[HEART], ax = a.x - H0.x, ay = a.y - H0.y, ra = Math.sqrt(ax * ax + ay * ay) || 1, dd = Math.atan2(ay, ax) - a.sa;
        while (dd > Math.PI) dd -= 2 * Math.PI; while (dd < -Math.PI) dd += 2 * Math.PI;
        var ex0 = Math.abs(dd) - a.sh * 0.6;
        if (ex0 > 0) { var fs0 = -SECK * ex0 * ra * (dd > 0 ? 1 : -1); a.fx += -ay / ra * fs0; a.fy += ax / ra * fs0; }
      }
      if (a.kind === 'agent' && p && p.kind === 'hub' && !L.mobile) {
        /* the cluster points outward: a gentle push along heart -> hub */
        var H1 = N[HEART], ox0 = p.x - H1.x, oy0 = p.y - H1.y, od = Math.sqrt(ox0 * ox0 + oy0 * oy0) || 1; a.fx += TU.ob * ox0 / od; a.fy += TU.ob * oy0 / od;
      }
      if (a.kind === 'hub') { a.fx += (WD.hx - a.x) * KC * (L.mobile ? 20 : 1); if (!L.mobile) a.fy += (WD.hy - a.y) * KC; }
      if ((e = mw - (a.x + a.bx1)) > 0) a.fx += KW * e; if ((e = a.x + a.bx2 - (WD.w - mw)) > 0) a.fx -= KW * e;
      if ((e = mw - (a.y + a.by1)) > 0) a.fy += KW * e; if ((e = a.y + a.by2 - (WD.h - mw)) > 0) a.fy -= KW * e;
    }
    for (i = 0; i < n; i++) {
      a = NL[i]; if (!a.w) { a.vx = a.vy = 0; continue; }
      a.vx = (a.vx + a.fx * DT) * DAMP; a.vy = (a.vy + a.fy * DT) * DAMP;
      var sp = Math.sqrt(a.vx * a.vx + a.vy * a.vy); if (sp > VMAX) { a.vx *= VMAX / sp; a.vy *= VMAX / sp; }
      a.x += a.vx * DT; a.y += a.vy * DT;
    }
    sidesAll();
    for (i = 0; i < 3; i++) if (!relax(1, false)) break;
    for (i = 0; i < n; i++) {
      a = NL[i]; if (!a.w) continue;
      a.vx = (a.x - a.ox) / DT; a.vy = (a.y - a.oy) / DT;
      var v = Math.sqrt(a.vx * a.vx + a.vy * a.vy); if (v > maxv) maxv = v;
    }
    return maxv;
  }
  var TU = { ha: 3, hxm: 0.82, pw: 0.3, hk: 20, hm: 0.2, bc: 80, bk: 30, pe: 0, pd: 1.0, ob: 150, hw: 1.1, sk: 20, ar: 0.45, hr: 0.92, xr: 2.4, js: 0.25, jr: 1.6, ks: 9, hq: 1.5 };
  var SECK = 0, AREAK = 1.35, SPRK = 1, REPK = 1, CONEK = 1, PADO = 6, PADL = 4, SEGM = 12, DBG = null;
  /* one Gauss-Seidel sweep of every hard rule; dry = count only. k scales the clearances (checks use 0.6x) */
  function relax(k, dry) {
    var c = 0, i, j, a, b, n = NL.length, s = WD.s, po = PADO / s * k, pl = PADL / s * k, sm = SEGM / s * k, mg = WD.mg * k;
    for (i = 0; i < n; i++) NL[i].w = invM(NL[i]);
    for (i = 0; i < n; i++) {
      a = NL[i];
      for (j = i + 1; j < n; j++) {
        b = NL[j]; if (!dry && !a.w && !b.w) continue;
        if (a.x + a.bx2 + pl < b.x + b.bx1 || b.x + b.bx2 + pl < a.x + a.bx1 || a.y + a.by2 + pl < b.y + b.by1 || b.y + b.by2 + pl < a.y + a.by1) continue;
        var c0 = c;
        c += orbFix(a, b, po, dry);
        c += rectFix(a, a.x - a.cr, a.y - a.cr, a.x + a.cr, a.y + a.cr, b, b.x + b.rx1, b.y + b.ry1, b.x + b.rx2, b.y + b.ry2, pl, dry);
        c += rectFix(a, a.x + a.rx1, a.y + a.ry1, a.x + a.rx2, a.y + a.ry2, b, b.x - b.cr, b.y - b.cr, b.x + b.cr, b.y + b.cr, pl, dry);
        c += rectFix(a, a.x + a.rx1, a.y + a.ry1, a.x + a.rx2, a.y + a.ry2, b, b.x + b.rx1, b.y + b.ry1, b.x + b.rx2, b.y + b.ry2, pl, dry);
        if (DBG && c > c0) DBG.push('pair ' + a.id + ' ~ ' + b.id);
      }
    }
    for (i = 0; i < n; i++) { a = NL[i]; for (j = 0; j < EL.length; j++) if (EL[j].b !== a.id) { var c1 = segFix(a, EL[j], sm, dry); c += c1; if (DBG && c1) DBG.push('seg ' + a.id + ' x ' + EL[j].a + '>' + EL[j].b); } }
    for (i = 0; i < n; i++) {
      a = NL[i]; if (!a.w && !dry) continue;
      var e, c2 = c;
      if ((e = mg - (a.x + a.bx1)) > 0) { c++; if (!dry && a.w) a.x += e; }
      if ((e = a.x + a.bx2 - (WD.w - mg)) > 0) { c++; if (!dry && a.w) a.x -= e; }
      if ((e = mg - (a.y + a.by1)) > 0) { c++; if (!dry && a.w) a.y += e; }
      if ((e = a.y + a.by2 - (WD.h - mg)) > 0) { c++; if (!dry && a.w) a.y -= e; }
      for (j = 0; j < WD.obs.length; j++) {
        var o = WD.obs[j];
        c += rectFix(a, a.x - a.cr, a.y - a.cr, a.x + a.cr, a.y + a.cr, null, o[0], o[1], o[2], o[3], pl, dry);
        c += rectFix(a, a.x + a.rx1, a.y + a.ry1, a.x + a.rx2, a.y + a.ry2, null, o[0], o[1], o[2], o[3], pl, dry);
      }
      if (DBG && c > c2) DBG.push('bounds/obs ' + a.id);
    }
    return c;
  }
  function orbFix(a, b, pad, dry) {
    var dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy), mn = a.cr + b.cr + pad;
    if (d >= mn) return 0; if (dry) return 1;
    var ws = a.w + b.w; if (!ws) return 0;
    if (d < 0.01) { var hh = (hash(a.id + b.id) % 628) / 100; dx = Math.cos(hh); dy = Math.sin(hh); d = 1; }
    var pen = mn - d, nx = dx / d, ny = dy / d;
    a.x -= nx * pen * a.w / ws; a.y -= ny * pen * a.w / ws; b.x += nx * pen * b.w / ws; b.y += ny * pen * b.w / ws;
    return 1;
  }
  /* AABB minimum-translation separation; b === null means a fixed obstacle */
  function rectFix(a, ax1, ay1, ax2, ay2, b, bx1, by1, bx2, by2, pad, dry) {
    var ox = Math.min(ax2, bx2) - Math.max(ax1, bx1) + pad; if (ox <= 0) return 0;
    var oy = Math.min(ay2, by2) - Math.max(ay1, by1) + pad; if (oy <= 0) return 0;
    if (dry) return 1;
    var wa = a.w, wb = b ? b.w : 0, ws = wa + wb; if (!ws) return 0;
    if (ox < oy) { var sx = (ax1 + ax2) < (bx1 + bx2) ? -1 : 1; a.x += sx * ox * wa / ws; if (b) b.x -= sx * ox * wb / ws; }
    else { var sy = (ay1 + ay2) < (by1 + by2) ? -1 : 1; a.y += sy * oy * wa / ws; if (b) b.y -= sy * oy * wb / ws; }
    return 1;
  }
  /* Liang-Barsky: does segment (x0,y0)-(x1,y1) touch rect [xa,ya,xb,yb] */
  function segHit(x0, y0, x1, y1, xa, ya, xb, yb) {
    var t0 = 0, t1 = 1, dx = x1 - x0, dy = y1 - y0, p = [-dx, dx, -dy, dy], q = [x0 - xa, xb - x0, y0 - ya, yb - y0], k;
    for (k = 0; k < 4; k++) {
      if (p[k] === 0) { if (q[k] < 0) return false; }
      else { var t = q[k] / p[k]; if (p[k] < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; } }
    }
    return true;
  }
  /* label (owner o) vs the visible stream of edge e: push the label off the line and swing the edge's free end the other way */
  function segFix(o, e, M, dry) {
    var A = N[e.a], B = N[e.b]; if (!A || !B) return 0;
    var dx = B.x - A.x, dy = B.y - A.y, len = Math.sqrt(dx * dx + dy * dy); if (len < A.R + B.R + 6) return 0;
    if (o === A || o === B) M = M * 4 / SEGM;   /* the owner's own streams: they start at its rim right next to its label */
    var ux = dx / len, uy = dy / len, x0 = A.x + ux * (A.R + 2), y0 = A.y + uy * (A.R + 2), x1 = B.x - ux * (B.R + 2), y1 = B.y - uy * (B.R + 2);
    var rx1 = o.x + o.rx1 - M, ry1 = o.y + o.ry1 - M, rx2 = o.x + o.rx2 + M, ry2 = o.y + o.ry2 + M;
    if (Math.max(x0, x1) < rx1 || Math.min(x0, x1) > rx2 || Math.max(y0, y1) < ry1 || Math.min(y0, y1) > ry2) return 0;
    if (!segHit(x0, y0, x1, y1, rx1, ry1, rx2, ry2)) return 0;
    if (dry) return 1;
    var cx = (rx1 + rx2) / 2, cy = (ry1 + ry2) / 2, nx = -uy, ny = ux, dc = (cx - x0) * nx + (cy - y0) * ny;
    if (dc < 0) { nx = -nx; ny = -ny; dc = -dc; }
    var pen = Math.abs(nx) * (rx2 - rx1) / 2 + Math.abs(ny) * (ry2 - ry1) / 2 - dc + 0.5; if (pen <= 0) return 0;
    var sl = len - A.R - B.R - 4, t = clamp(((cx - x0) * ux + (cy - y0) * uy) / (sl || 1), 0, 1);
    var cO = 1, cA = -(1 - t), cB = -t, wO = o.w, wA = A.w, wB = B.w;
    if (o === A) { cA += 1; cO = 0; } else if (o === B) { cB += 1; cO = 0; }
    var den = wO * cO * cO + wA * cA * cA + wB * cB * cB; if (den < 1e-6) return 0;
    var lam = pen / den, cap = 14 / WD.s, mv = function (nd, w, cf) { if (!w || !cf) return; var m = clamp(lam * w * cf, -cap, cap); nd.x += m * nx; nd.y += m * ny; };
    mv(o, wO, cO); mv(A, wA, cA); mv(B, wB, cB);
    return 1;
  }
  function solveSync(maxSteps) {
    var still = 0, k, r, bad;
    for (k = 0; k < maxSteps; k++) { if (stepPhys() < VREST) { if (++still >= 8) break; } else still = 0; }
    bad = strictPass();
    if (bad > 6 * Math.sqrt(NL.length) + 10) return bad;   /* hopeless at this fit: let the planner move on */
    if (bad) bad = repair();
    /* jammed: loosen the springs, push harder, let the crowd spread into free space, then tighten again */
    for (r = 0; r < 3 && bad; r++) {
      SPRK = TU.js; REPK = TU.jr; CONEK = 3;
      for (k = 0, still = 0; k < 220; k++) { if (stepPhys() < VREST) { if (++still >= 8) break; } else still = 0; }
      SPRK = 1; REPK = 1; CONEK = 1;
      bad = strictPass();
      if (bad) bad = repair();
    }
    return bad;
  }
  /* does node n violate any hard rule (dry, full clearances)? */
  function nodeBad(n) {
    var s = WD.s, po = PADO / s, pl = PADL / s, sm = SEGM / s, mg = WD.mg, j, b, e;
    for (j = 0; j < NL.length; j++) {
      b = NL[j]; if (b === n) continue;
      if (n.x + n.bx2 + pl < b.x + b.bx1 || b.x + b.bx2 + pl < n.x + n.bx1 || n.y + n.by2 + pl < b.y + b.by1 || b.y + b.by2 + pl < n.y + n.by1) continue;
      if (orbFix(n, b, po, true) || rectFix(n, n.x - n.cr, n.y - n.cr, n.x + n.cr, n.y + n.cr, b, b.x + b.rx1, b.y + b.ry1, b.x + b.rx2, b.y + b.ry2, pl, true) ||
        rectFix(n, n.x + n.rx1, n.y + n.ry1, n.x + n.rx2, n.y + n.ry2, b, b.x - b.cr, b.y - b.cr, b.x + b.cr, b.y + b.cr, pl, true) ||
        rectFix(n, n.x + n.rx1, n.y + n.ry1, n.x + n.rx2, n.y + n.ry2, b, b.x + b.rx1, b.y + b.ry1, b.x + b.rx2, b.y + b.ry2, pl, true)) return true;
    }
    for (j = 0; j < EL.length; j++) {
      e = EL[j];
      if (e.b !== n.id && segFix(n, e, sm, true)) return true;
      if (e.a === n.id || e.b === n.id) { for (var k = 0; k < NL.length; k++) if (NL[k].id !== e.b && segFix(NL[k], e, sm, true)) return true; }
    }
    if (mg - (n.x + n.bx1) > 0 || n.x + n.bx2 - (WD.w - mg) > 0 || mg - (n.y + n.by1) > 0 || n.y + n.by2 - (WD.h - mg) > 0) return true;
    for (j = 0; j < WD.obs.length; j++) {
      var o = WD.obs[j];
      if (rectFix(n, n.x - n.cr, n.y - n.cr, n.x + n.cr, n.y + n.cr, null, o[0], o[1], o[2], o[3], pl, true) || rectFix(n, n.x + n.rx1, n.y + n.ry1, n.x + n.rx2, n.y + n.ry2, null, o[0], o[1], o[2], o[3], pl, true)) return true;
    }
    return false;
  }
  /* local repair: move each still-violating agent to the nearest rule-satisfying spot around its parent (deterministic scan) */
  function clusterBad(h) { var c = nodeBad(h) ? 1 : 0; (h.kids || []).forEach(function (id) { if (nodeBad(N[id])) c++; }); return c; }
  function repair() {
    /* hubs first: move the whole cluster rigidly to the nearest spot (around the heart) where the cluster is clean */
    NL.forEach(function (h) {
      if (h.kind !== 'hub' || !invM(h)) return;
      var c0 = clusterBad(h); if (!c0) return;
      var H0 = N[HEART], ox = h.x, oy = h.y, best = null, bc = c0, bd = 1e18, kids = (h.kids || []).map(function (id) { return N[id]; }).filter(function (k) { return invM(k); });
      var r0 = Math.sqrt((ox - H0.x) * (ox - H0.x) + (oy - H0.y) * (oy - H0.y)), a0 = Math.atan2(oy - H0.y, ox - H0.x);
      function moveTo(x, y) { var dx = x - h.x, dy = y - h.y; h.x = x; h.y = y; kids.forEach(function (k) { k.x += dx; k.y += dy; }); setSide(h, pickSide(h)); kids.forEach(function (k) { setSide(k, pickSide(k)); }); }
      for (var ri = 0; ri < 9; ri++) for (var ai = -12; ai <= 12; ai++) {
        var r = r0 * (0.7 + ri * 0.1), t = a0 + ai * Math.PI / 36;
        moveTo(H0.x + r * Math.cos(t), H0.y + r * Math.sin(t) * (WD.h / WD.w) * 1.4 / ((WD.h / WD.w) * 1.4) );
        var c = clusterBad(h), dd = (h.x - ox) * (h.x - ox) + (h.y - oy) * (h.y - oy);
        if (c < bc || (c === bc && best && dd < bd)) { bc = c; bd = dd; best = [h.x, h.y]; }
      }
      moveTo(best ? best[0] : ox, best ? best[1] : oy);
    });
    for (var round = 0; round < 3; round++) {
      var bads = NL.filter(function (n) { return n.kind === 'agent' && invM(n) && nodeBad(n); });
      if (!bads.length) break;
      bads.forEach(function (n) {
        if (!nodeBad(n)) return;
        var p = N[n.parent], ox = n.x, oy = n.y, best = null, bd = 1e18, an = n.an || 1, sd0 = n.side;
        var Hr = N[HEART], bdir = p.kind === 'hub' && !L.mobile ? Math.atan2(Hr.y - p.y, Hr.x - p.x) : null;
        for (var ri = 0; ri < 12; ri++) {
          var r = n.rest * (0.55 + ri * 0.2);
          for (var ai = 0; ai < 36; ai++) {
            var t = ai * Math.PI / 18;
            if (bdir !== null) { var dt = t - bdir; while (dt > Math.PI) dt -= 2 * Math.PI; while (dt < -Math.PI) dt += 2 * Math.PI; if (Math.abs(dt) < TU.bc * Math.PI / 180 * 0.9) continue; }
            var ca = Math.cos(t), sa = Math.sin(t), ee = 1 / Math.sqrt(ca * ca / (an * an) + sa * sa * an * an);
            n.x = p.x + r * ee * ca; n.y = p.y + r * ee * sa; setSide(n, pickSide(n));
            var dd = (n.x - ox) * (n.x - ox) + (n.y - oy) * (n.y - oy);
            if (dd < bd && !nodeBad(n)) { bd = dd; best = [n.x, n.y, n.side]; }
          }
        }
        if (best) { n.x = best[0]; n.y = best[1]; setSide(n, best[2]); } else { n.x = ox; n.y = oy; setSide(n, sd0); }
        n.vx = n.vy = 0;
      });
    }
    return strictPass();
  }
  function strictPass() {
    for (var k = 0; k < 320; k++) { sidesAll(); if (!relax(1, false)) break; }
    sidesAll(); return relax(0.6, true);
  }
  function violations() { return relax(0.6, true); }

  /* ---- deterministic initial layout: hubs on angular sectors (backend project order), agents on polar slots outward from their hub ---- */
  function slotAngles(n, excl) {
    /* n angles evenly spread over the circle minus the excluded arcs [centre, halfWidth] (degrees) */
    var iv = [[0, 360]], i, j;
    excl.forEach(function (x) {
      var a0 = ((x[0] - x[1]) % 360 + 360) % 360, a1 = a0 + 2 * x[1], cut = [[a0, Math.min(a1, 360)]]; if (a1 > 360) cut.push([0, a1 - 360]);
      cut.forEach(function (c) { var nv = []; iv.forEach(function (v) { if (c[1] <= v[0] || c[0] >= v[1]) nv.push(v); else { if (c[0] > v[0]) nv.push([v[0], c[0]]); if (c[1] < v[1]) nv.push([c[1], v[1]]); } }); iv = nv; });
    });
    var tot = 0; iv.forEach(function (v) { tot += v[1] - v[0]; }); if (tot < 1) { iv = [[0, 360]]; tot = 360; }
    var out = [];
    for (i = 0; i < n; i++) { var m = (i + 0.5) * tot / n; for (j = 0; j < iv.length; j++) { var l = iv[j][1] - iv[j][0]; if (m <= l) { out.push(iv[j][0] + m); break; } m -= l; } }
    return out;
  }
  var SIDEDEG = { r: 0, b: 90, l: 180, t: 270, ru: 330, rd: 30, lu: 210, ld: 150 };
  function placeKids(par, kids, back, ex, ey, more) {
    var n = kids.length; if (!n) return;
    var excl = [[back, par.kind === 'heart' ? 72 : TU.bc]].concat(more || []);
    if (par.kind === 'hub') excl.push([SIDEDEG[par.side], par.side === 't' || par.side === 'b' ? 70 : par.side.length === 2 ? 48 : 40]);
    var an = slotAngles(n, excl);
    kids.forEach(function (k, i) {
      var t = an[i] * Math.PI / 180, r = k.rest * (n > 7 ? (i % 2 ? 1.22 : 0.84) : 1), jt = (hash(k.id) % 1000) / 1000 - 0.5;
      k.x = par.x + r * ex * Math.cos(t) + jt * 4; k.y = par.y + r * ey * Math.sin(t) - jt * 4;
    });
  }
  function initialLayout() {
    var hx = WD.hx, hy = WD.hy, H = N[HEART], hubsL = NL.filter(function (n) { return n.kind === 'hub'; }), P = hubsL.length;
    var ex = L.mobile ? 1 : clamp(Math.sqrt(WD.w / WD.h), 1, 1.7), ey = 1 / ex;
    H.x = hx; H.y = hy;
    if (!P && L.mobile) H.kids.forEach(function (id) { var k = N[id]; k.x = H.x + k.mdx; k.y = H.y + k.mdy; });
    else if (!P) placeKids(H, H.kids.map(function (id) { return N[id]; }), 90, ex, ey);
    else if (L.mobile) {
      /* phone: heart top-left, hubs down the left edge (their trunks run along that edge), agents fan out to the right */
      hubsL.forEach(function (h) {
        h.x = hx; h.y = hy + h.rest; setSide(h, 'r');
        h.kids.forEach(function (id) { var k = N[id]; k.x = h.x + k.mdx; k.y = h.y + k.mdy; });
      });
    } else {
      hubsL.forEach(function (h, i) {
        var th = h.sa;
        if (P === 1) th = Math.PI;
        var ee = 1 / Math.sqrt(Math.cos(th) * Math.cos(th) / (h.an * h.an) + Math.sin(th) * Math.sin(th) * h.an * h.an);
        h.x = hx + h.rest * ee * Math.cos(th); h.y = hy + h.rest * ee * Math.sin(th);
        setSide(h, pickSide(h));
        placeKids(h, h.kids.map(function (id) { return N[id]; }), th * 180 / Math.PI + 180, Math.sqrt(ex), Math.sqrt(ey));
      });
    }
    NL.forEach(function (n) { n.vx = n.vy = 0; setSide(n, pickSide(n)); });
  }
  function areaNeed() { var a = 0, p = 14 / WD.s; NL.forEach(function (n) { a += (n.bx2 - n.bx1 + p) * (n.by2 - n.by1 + p); }); return a * AREAK; }
  function areaAvail() { var a = WD.w * WD.h * 0.8; WD.obs.forEach(function (o) { a -= (o[2] - o[0]) * (o[3] - o[1]); }); return a; }

  /* ---- planner: picks (label level, fit) and runs the solver. fresh = deterministic initial layout, else from current positions ---- */
  function plan(fresh) {
    layoutRuns++; window.__aosLayoutRuns = layoutRuns;
    var F = L.mobile ? FITS_M : FITS, i, cur = WD.fit, start = 0, best = -1, bad = 1, fallback = null;
    var keep = !fresh && cur >= 0 && cur < F.length;
    var old = NL.map(function (n) { return [n.x, n.y]; }), oW = { w: WD.w, h: WD.h, hx: WD.hx, hy: WD.hy };
    for (i = keep ? cur : 0; i < F.length; i++) {
      setFit(F, i);
      if (!keep || i !== cur) { if (!L.mobile && areaNeed() > areaAvail() && i < F.length - 1) { if (window.__aosFitLog) window.__aosFitLog.push([i, 'area', Math.round(areaNeed() / areaAvail() * 100)]); continue; } }
      if (keep) {
        /* incremental: map the previous positions into this world (around the heart), new nodes spawn at their parent */
        NL.forEach(function (n, k) {
          if (n.kind === 'heart') { n.x = WD.hx; n.y = WD.hy; return; }
          if (n.spawn) return;
          n.x = WD.hx + (old[k][0] - oW.hx) * (L.mobile ? 1 : 1); n.y = WD.hy + (old[k][1] - oW.hy);
        });
        NL.forEach(function (n) { if (n.spawn) { var p = N[n.parent], h = (hash(n.id) % 628) / 100; n.x = p.x + Math.cos(h) * (p.cr + 4); n.y = p.y + Math.sin(h) * (p.cr + 4); } n.vx = n.vy = 0; setSide(n, pickSide(n)); });
      }
      /* one project, fresh plan: a few fixed parameter variants; keep the clean one whose cluster sits tightest around its hub */
      var single = !L.mobile && NL.filter(function (n) { return n.kind === 'hub'; }).length === 1, vars = !keep && single ? (NL.length > 30 ? [0, 3, 4, 6] : VARS) : [keep ? -1 : 0], bestV = null;
      for (var vi = 0; vi < vars.length; vi++) {
        if (vars[vi] >= 0) { applyVar(vars[vi]); setFit(F, i); }
        if (!keep) initialLayout();
        var tS = performance.now(); bad = solveSync(L.mobile ? 520 : 440); window.__aosSolveMs = (window.__aosSolveMs || []).slice(-19).concat([Math.round(performance.now() - tS)]);
        if (!bad && vars.length > 1) {
          var rt = clusterRatio();
          if (!bestV || rt < bestV.rt) bestV = { rt: rt, v: vars[vi], pos: NL.map(function (n) { return [n.x, n.y, n.side]; }) };
          if (rt < 0.45) break;
        }
        if (bad && vi === 0) break;   /* variants only refine the composition of a fit that is already feasible */
      }
      if (bestV && bestV.rt >= 0.5 && (!fallback || i < fallback.i + 3) && i < F.length - 1) { if (!fallback || bestV.rt < fallback.b.rt) fallback = { i: i, b: bestV, i0: fallback ? fallback.i0 : i }; bad = 1; keep = false; continue; }   /* loose cluster: try up to 3 smaller fits */
      if (!bestV && fallback && i < fallback.i0 + 3 && i < F.length - 1) { keep = false; continue; }
      if (bestV && fallback && fallback.b.rt <= bestV.rt) { i = fallback.i; bestV = fallback.b; }
      if (bestV) { applyVar(bestV.v); setFit(F, i); NL.forEach(function (n, k) { n.x = bestV.pos[k][0]; n.y = bestV.pos[k][1]; setSide(n, bestV.pos[k][2]); }); bad = 0; }
      else if (fallback && bad) { i = fallback.i; bestV = fallback.b; applyVar(bestV.v); setFit(F, i); NL.forEach(function (n, k) { n.x = bestV.pos[k][0]; n.y = bestV.pos[k][1]; setSide(n, bestV.pos[k][2]); }); bad = 0; }
      best = i;
      if (window.__aosFitLog) { DBG = []; relax(0.6, true); window.__aosFitLog.push([i, bad, DBG.slice(0, 6)]); DBG = null; }
      if (!bad) break;
      keep = false; /* a bigger fit always starts again from the deterministic initial layout */
    }
    if (!bad) centerGraph();
    NL.forEach(function (n) { n.spawn = false; });
    WD.fit = best < 0 ? F.length - 1 : best;
    window.__aosLayoutBad = bad;
    $('graph').setAttribute('class', 'lv' + LVL);
    resetView();
    return bad;
  }
  var VARS = [0, 1, 2, 3, 4, 5, 6, 7], VARV = [{}, { pw: 0.27, ar: 0.42 }, { ar: 0.4 }, { pw: 0.33 }, { pw: 0.36, ar: 0.38 }, { bc: 92, bk: 45, ar: 0.4 }, { pw: 0.4, hxm: 0.86, ar: 0.38 }, { pw: 0.38, bc: 92, bk: 45 }], TU0 = null;
  function applyVar(v) { if (!TU0) { TU0 = {}; for (var k in TU) TU0[k] = TU[k]; } for (var k2 in TU0) TU[k2] = TU0[k2]; var o = VARV[v] || {}; for (var k3 in o) TU[k3] = o[k3]; }
  function clusterRatio() {
    var H = N[HEART], dh = 0, dk = 0;
    NL.forEach(function (n) { if (n.kind !== 'agent') return; var p = N[n.parent]; dh += Math.sqrt((n.x - p.x) * (n.x - p.x) + (n.y - p.y) * (n.y - p.y)); dk += Math.sqrt((n.x - H.x) * (n.x - H.x) + (n.y - H.y) * (n.y - H.y)); });
    return dk ? dh / dk : 0;
  }
  /* balance: translate the whole graph (heart included) so its bounding box is centred in the free panel; kept only if still clean */
  function centerGraph() {
    if (L.mobile) return;
    var x1 = 1e9, y1 = 1e9, x2 = -1e9, y2 = -1e9;
    NL.forEach(function (n) { x1 = Math.min(x1, n.x + n.bx1); x2 = Math.max(x2, n.x + n.bx2); y1 = Math.min(y1, n.y + n.by1); y2 = Math.max(y2, n.y + n.by2); });
    var dx = WD.w / 2 - (x1 + x2) / 2, dy = WD.h / 2 - (y1 + y2) / 2;
    for (var k = 0; k < 4; k++) {
      var f = [1, 0.66, 0.33, 0][k], old = NL.map(function (n) { return [n.x, n.y, n.side]; });
      NL.forEach(function (n) { n.x += dx * f; n.y += dy * f; });
      if (violations()) strictPass();
      if (!violations()) { var H = N[HEART]; WD.hx = H.x; WD.hy = H.y; return; }
      NL.forEach(function (n, i) { n.x = old[i][0]; n.y = old[i][1]; setSide(n, old[i][2]); });
    }
  }
  function setFit(F, i) {
    var f = F[i]; LVL = f[0];
    if (L.mobile) setWorld(1, Math.round(Math.max(GH, 520) * f[1]));
    else setWorld(f[1]);
    NL.forEach(function (n) { setMetrics(n, LVL); }); setRests();
    if (L.mobile && WD.col + 200 > WD.h) setWorld(1, Math.round(WD.col + 200));
    /* one project: the heart moves right so heart + (hub with its outward cluster on the left) is centred */
    var hb = NL.filter(function (n) { return n.kind === 'hub'; });
    if (!L.mobile && hb.length === 1 && hb[0].kids.length) { var k0 = N[hb[0].kids[0]]; WD.hx = clamp(WD.w / 2 + 0.5 * (hb[0].rest + k0.rest * (k0.an || 1)) - 60, WD.w / 2, WD.w * TU.hxm); }
  }

  /* ---- DOM ---- */
  function ensureOrch() {
    if (orchEl) return orchEl;
    var g = sv('g', { 'class': 'node orch', tabindex: 0, role: 'button', 'data-id': '__heart' }, $('g-orch'));
    sv('circle', { 'class': 'halo' }, g);
    sv('circle', { 'class': 'core-bg' }, g);
    sv('circle', { 'class': 'tint' }, g);
    sv('circle', { 'class': 'body' }, g);
    sv('circle', { 'class': 'tickring' }, g);
    sv('circle', { 'class': 'focus-ring' }, g);
    var t = sv('text', { 'class': 'name' }, g); t.textContent = 'Orchestrator';
    sv('text', { 'class': 'big' }, g);
    sv('text', { 'class': 'seq' }, g);
    sv('text', { 'class': 'sub' }, g);
    g.addEventListener('keydown', keyAct(function () { openDrawer('orch'); }));
    g.addEventListener('click', function () { openDrawer('orch'); });
    orchEl = g; return g;
  }
  function setT(e, t) { t = String(t); if (e.textContent !== t) e.textContent = t; }
  function renderOrch() {
    var g = ensureOrch(), hb = state && state.heartbeat, lv = liveness(hb), Rc = L.Rc, H = N[HEART];
    var tx = g.querySelectorAll('text'), live = isLive();
    var l = hb ? dispLive(lv.l) : (live ? 'standby' : 'dead'), oname = live ? 'Claude Code' : 'Orchestrator';
    var sess = live ? mainSessions() : [];
    if (H) setNode(g, H.dx, H.dy, kNode()); else setNode(g, WD.hx, WD.hy, kNode());
    setA(g.querySelector('.halo'), 'r', Rc + 22);
    setA(g.querySelector('.core-bg'), 'r', Rc);
    setA(g.querySelector('.tint'), 'r', Math.round(Rc * 0.36));
    setA(g.querySelector('.body'), 'r', Rc);
    setA(g.querySelector('.focus-ring'), 'r', Rc + 14);
    setA(g.querySelector('.tickring'), 'r', Rc + 3);
    var y0 = L.mobile ? -24 : Rc + 26;
    [y0, y0 + 22, y0 + 42, y0 + 60].forEach(function (y, i) { setA(tx[i], 'y', y); setA(tx[i], 'x', L.mobile ? Rc + 10 : 0); });
    var anc = L.mobile ? 'start' : 'middle'; for (var ti = 0; ti < 4; ti++) if (tx[ti].style.textAnchor !== anc) tx[ti].style.textAnchor = anc;
    var cls = 'node orch s-' + l + (selected === 'orch' ? ' sel' : '') + (g.classList.contains('flash') ? ' flash' : '');
    if (g.getAttribute('class') !== cls) g.setAttribute('class', cls);
    setT(tx[0], oname);
    if (live && sess.length) {
      setT(tx[1], sess.length + (sess.length === 1 ? ' SESSION' : ' SESSIONS'));
      setT(tx[2], sess.filter(function (x) { return x.status === 'running'; }).length + ' running');
      setT(tx[3], trunc(hb ? liveText(lv, hb) : '', 26));
    } else {
      setT(tx[1], hb ? l.toUpperCase() : (live ? 'STANDBY' : 'NO PULSE'));
      if (live) {
        setT(tx[2], trunc(liveText(lv, hb), 26));
        setT(tx[3], hb && hb.status && hb.status !== 'running' ? hb.status : '');
      } else {
        setT(tx[2], trunc(hb ? 'seq ' + hb.seq + (hb.status !== 'running' ? ' · ' + hb.status : '') : '', 26));
        setT(tx[3], hb ? 'age ' + fmtAge(lv.age) : 'no pulse yet');
      }
    }
    var al = oname + ', ' + tx[1].textContent.toLowerCase() + (hb ? (live ? ', ' + liveText(lv, hb) + ', status ' + hb.status : ', seq ' + hb.seq + ', age ' + fmtAge(lv.age) + ', status ' + hb.status) : '') + '. Open details';
    if (g.getAttribute('aria-label') !== al) g.setAttribute('aria-label', al);
  }
  function tickPulse() {
    var r = orchEl && orchEl.querySelector('.tickring'); if (!r) return;
    r.classList.remove('go'); void r.getBoundingClientRect(); r.classList.add('go');
  }
  function flash(g) {
    if (!g) return; g.classList.remove('flash'); void g.getBoundingClientRect(); g.classList.add('flash');
    setTimeout(function () { g.classList.remove('flash'); }, 1200);
  }
  function resetGraph() {
    ['g-agents', 'g-edges', 'g-deps'].forEach(function (id) { clear($(id)); }); if ($('g-hubs')) clear($('g-hubs'));
    N = {}; NL = []; EL = []; nodes = {}; hubEls = {}; chips = {}; edges = {}; deps = {}; depInfo = {}; SIG = ''; WD.fit = -1;
  }
  function mkAgentEl(id) {
    var g = sv('g', { 'class': 'node agent', tabindex: 0, role: 'button', 'data-id': id }, $('g-agents'));
    sv('circle', { 'class': 'halo' }, g);
    sv('circle', { 'class': 'av' }, g);
    sv('circle', { 'class': 'card' }, g);
    sv('circle', { 'class': 'tint' }, g);
    sv('circle', { 'class': 'led', cx: 0, cy: 0, r: 2 }, g);
    sv('path', { 'class': 'collmark', d: 'M0,-4.6L4.6,0L0,4.6L-4.6,0Z' }, g);
    sv('circle', { 'class': 'guardmark', cx: 0, cy: 0, r: 3.6 }, g); /* guard verdict (ui/guard.js): shown via the g-* node class */
    sv('text', { 'class': 'name' }, g);
    var sb = sv('text', { 'class': 'sub' }, g);
    sv('tspan', { 'class': 'sid' }, sb); sv('tspan', { 'class': 'st' }, sb); sv('tspan', { 'class': 'ns' }, sb);
    var md = sv('text', { 'class': 'model' }, g); sv('tspan', { 'class': 'dot' }, md); sv('tspan', { 'class': 'mt' }, md);
    sv('circle', { 'class': 'focus-ring' }, g);
    wireNode(g, id, function () { openDrawer(id); });
    g.classList.add('enter');
    return g;
  }
  function mkHubEl(key) {
    var gh = $('g-hubs'); if (!gh) { gh = sv('g', { id: 'g-hubs' }); $('graph').insertBefore(gh, $('g-agents')); }
    var g = sv('g', { 'class': 'node hub', tabindex: 0, role: 'button', 'data-id': key }, gh);
    sv('circle', { 'class': 'halo' }, g);
    sv('circle', { 'class': 'card' }, g);
    sv('circle', { 'class': 'ring2' }, g);
    sv('circle', { 'class': 'tint' }, g);
    sv('path', { 'class': 'collmark', d: 'M0,-5L5,0L0,5L-5,0Z' }, g);
    sv('text', { 'class': 'name' }, g);
    sv('text', { 'class': 'sub' }, g);
    sv('circle', { 'class': 'focus-ring' }, g);
    wireNode(g, key, function () { openDrawer(key); });
    return g;
  }
  function mkEdge(id, kind) { return { id: id, kind: kind, el: sv('line', { 'class': 'edge ' + kind }, $('g-edges')) }; }
  /* build / update node records from the model; returns true if the node SET changed */
  function syncNodes(md) {
    var keep = {}, list = [], changed = false, H = N[HEART];
    if (!H) { H = N[HEART] = { id: HEART, kind: 'heart', x: WD.hx, y: WD.hy, dx: WD.hx, dy: WD.hy, vx: 0, vy: 0, side: 'b', cl: HEART }; changed = true; }
    H.kids = []; keep[HEART] = 1; list.push(H);
    function node(id, kind, parent, cl, extra) {
      var n = N[id];
      if (!n) { n = N[id] = { id: id, kind: kind, x: 0, y: 0, dx: 0, dy: 0, vx: 0, vy: 0, side: 'b', spawn: true }; changed = true; if (kind === 'agent' && N[parent] && !N[parent].spawn) SYNC.added.push(n); else SYNC.hard = true; }
      else if (n.parent !== parent) { changed = true; SYNC.hard = true; }
      n.parent = parent; n.cl = cl; for (var k in extra) n[k] = extra[k];
      keep[id] = 1; list.push(n); N[parent].kids.push(id); return n;
    }
    if (md.implicit) md.agents.forEach(function (a) { node(a.id, 'agent', HEART, HEART, { a: a }); });
    else {
      md.hubs.forEach(function (p) { var h = node(p.key, 'hub', HEART, p.key, { p: p }); h.kids = []; });
      md.hubs.forEach(function (p) { p.agents.forEach(function (a) { node(a.id, 'agent', p.key, p.key, { a: a }); }); });
    }
    Object.keys(N).forEach(function (id) {
      if (keep[id]) return; changed = true; SYNC.hard = true;
      var n = N[id], g = n.el, ch = chips[id]; delete N[id];
      if (g) { g.classList.add('leaving'); setTimeout(function () { g.remove(); }, 520); }
      if (ch) { ch.classList.add('leaving'); setTimeout(function () { ch.remove(); }, 520); delete chips[id]; }
      delete nodes[id]; delete hubEls[id];
      var eg = edges[id]; if (eg) { eg.el.remove(); delete edges[id]; }
    });
    NL = list;
    EL = [];
    NL.forEach(function (n) {
      if (n.kind === 'heart') return;
      if (!n.el) { n.el = n.kind === 'hub' ? (hubEls[n.id] = mkHubEl(n.id)) : (nodes[n.id] = mkAgentEl(n.id)); }
      var kind = n.kind === 'hub' ? 'trunk' : 'branch', e = edges[n.id];
      if (!e || e.kind !== kind) { if (e) e.el.remove(); e = edges[n.id] = mkEdge(n.id, kind); }
      e.a = n.parent; e.b = n.id; EL.push(e);
    });
    return changed;
  }
  /* status / text content only: never positions */
  function updateContent() {
    NL.forEach(function (n) {
      if (n.kind === 'agent') updAgent(n); else if (n.kind === 'hub') updHub(n);
    });
  }
  /* guard verdict on a session (monitor `agent.guard`): verified | integrity | capability; text from ui/guard.js when loaded */
  function guardSt(a) { var v = a.guard && a.guard.verdict; return v === 'verified' || v === 'integrity' || v === 'capability' ? v : 'none'; }
  function guardTxt(a) { return window.AOSGuard ? AOSGuard.badge(a.guard).text : guardSt(a); }
  function clsSet(g, c) { if (g._cls !== c) { g._cls = c; g.setAttribute('class', c); } }
  function updAgent(n) {
    var a = n.a, g = n.el, R = orbR(a) + (a.status === 'running' ? 2 : 0), sp = splitId(a.id), ml = a.model_label ? String(a.model_label) : '', cl = collOf(a.id);
    clsSet(g, 'node agent s-' + a.status + (selected === a.id ? ' sel' : '') + (g.classList.contains('flash') ? ' flash' : '') + (g.classList.contains('enter') ? ' enter' : '') + (a.stuck ? ' stuck' : '') + (cl.length ? ' coll' : '') + (a.guard ? ' g-' + guardSt(a) : ''));
    setPos(g.querySelector('.collmark'), -(orbR(a) + 8) * 0.72, -(orbR(a) + 8) * 0.72);
    setPos(g.querySelector('.guardmark'), (orbR(a) + 8) * 0.72, -(orbR(a) + 8) * 0.72);
    setA(g.querySelector('.halo'), 'r', R + 14); setA(g.querySelector('.av'), 'r', R + 9); setA(g.querySelector('.card'), 'r', R + 6);
    setA(g.querySelector('.tint'), 'r', R); setA(g.querySelector('.focus-ring'), 'r', R + 12);
    var m = n.m, mt = g.querySelector('text.model'), R1 = orbR(a) + 2, fam = /opus/i.test(ml) ? 'opus' : /sonnet/i.test(ml) ? 'sonnet' : /haiku/i.test(ml) ? 'haiku' : 'other';
    var nsT = a.stuck ? 'NO SIGNAL ' + fmtCompact(a.stuck_for_s) : '', nsEl = g.querySelector('tspan.ns');
    setT(g.querySelector('tspan.sid'), sp.short ? sp.short + ' · ' : '');
    setT(g.querySelector('tspan.st'), nsT && !m.hasM ? nsT : trunc(human(a.status), 8));
    if (nsT && m.hasM) { clsSet(mt, 'model nosig fam-' + fam); setT(mt.querySelector('tspan.dot'), ''); setT(mt.querySelector('tspan.mt'), nsT); setT(nsEl, ''); }
    else { clsSet(mt, 'model fam-' + fam); setT(mt.querySelector('tspan.dot'), ml ? '● ' : ''); setT(mt.querySelector('tspan.mt'), trunc(modelTxt(a).toUpperCase(), 24)); setT(nsEl, ''); }
    var al = 'Agent ' + a.id + ', ' + a.status + (a.stuck ? ', no signal for ' + fmtCompact(a.stuck_for_s) : '') + (cl.length ? ', file conflict ' + cl[0].name : '') + (a.guard ? ', guard ' + guardTxt(a) : '') + (toolName(a) ? ', using ' + toolName(a) : '') + (ml ? ', model ' + ml : '') + (a.effort ? ', effort ' + a.effort : '') + (a.current_task ? ', working on ' + a.current_task : '') + '. Open details.';
    if (g.getAttribute('aria-label') !== al) g.setAttribute('aria-label', al);
    /* task chip */
    var ct = m.hasT ? taskLineFor(a) : null, c = chips[a.id];
    if (ct) {
      var W = L.chipW, H = LH.c;
      if (!c) {
        c = chips[a.id] = sv('g', { 'class': 'chip', tabindex: 0, role: 'button' }, $('g-agents'));
        sv('rect', { 'class': 'pill-bg', height: H }, c);
        var ct1 = sv('text', { 'class': 't', y: 13 }, c);
        sv('tspan', { 'class': 'cd' }, ct1); sv('tspan', { 'class': 'tt' }, ct1);
        sv('rect', { 'class': 'focus-ring', x: -3, y: -3, height: H + 6, rx: 4 }, c);
        c.addEventListener('click', function () { openDrawer(c.dataset.agent); });
        c.addEventListener('keydown', keyAct(function () { openDrawer(c.dataset.agent); }));
        c._lk = '';
      }
      setA(c.querySelector('rect.pill-bg'), 'width', W); setA(c.querySelector('rect.focus-ring'), 'width', W + 6);
      if (c.dataset.agent !== a.id) c.dataset.agent = a.id;
      clsSet(c, 'chip s-' + ct.t.status + (ct.dim ? ' dim' : ''));
      var icon = { done: '✓', failed: '✕', cancelled: '✕', needs_review: '!', stalled: '!' }[ct.t.status] || '●';
      setT(c.querySelector('tspan.cd'), icon + ' ');
      setT(c.querySelector('tspan.tt'), chipTitle(ct.t.title || ct.t.id));
      var cal = (ct.dim ? 'Last task ' : 'Current task ') + (ct.t.title || ct.t.id) + ', ' + ct.t.status;
      if (c.getAttribute('aria-label') !== cal) c.setAttribute('aria-label', cal);
      n.ct = ct;
    } else { if (c) { c.parentNode.removeChild(c); delete chips[a.id]; } n.ct = null; }
  }
  function updHub(n) {
    var p = n.p, g = n.el, hs = hubStatus(p.agents), R = n.R, anyColl = p.agents.some(function (a) { return collOf(a.id).length; });
    clsSet(g, 'node hub s-' + hs.st + (selected === n.id ? ' sel' : '') + (g.classList.contains('flash') ? ' flash' : '') + (anyColl ? ' coll' : ''));
    setA(g.querySelector('.halo'), 'r', R + 12); setA(g.querySelector('.card'), 'r', R); setA(g.querySelector('.ring2'), 'r', R + 5);
    setA(g.querySelector('.tint'), 'r', Math.round(R * 0.42)); setA(g.querySelector('.focus-ring'), 'r', R + 9);
    setPos(g.querySelector('.collmark'), -R * 0.74, -R * 0.74);
    var tot = p.agents.length;
    setT(g.querySelector('text.sub'), cnt(tot, 'agent', 'agents') + ' · ' + hs.running + ' running');
    var al = 'Project ' + p.name + ', ' + cnt(tot, 'agent', 'agents') + ', ' + hs.running + ' running' + (hs.stalled ? ', ' + hs.stalled + ' stalled' : '') + (hs.errored ? ', ' + hs.errored + ' errored' : '') + '. Open project details.';
    if (g.getAttribute('aria-label') !== al) g.setAttribute('aria-label', al);
  }
  /* label text positions for the node's current side (rebuilt only when side / level / text change) */
  function applyLabel(n) {
    var g = n.el, m = n.m, sd = n.side; if (!g || !m) return;
    var key = sd + '|' + LVL + '|' + m.lines.join('/') + '|' + n.lo + '|' + n.ty; if (g._lk === key) return; g._lk = key;
    var s0 = sd.charAt(0), anc = s0 === 'r' ? 'start' : s0 === 'l' ? 'end' : 'middle', x0 = s0 === 'r' ? n.lo + 2 : s0 === 'l' ? -(n.lo + 2) : 0;
    var top = n.ty;
    var nm = g.querySelector('text.name'), sb = g.querySelector('text.sub');
    while (nm.firstChild) nm.removeChild(nm.firstChild);
    if (n.kind === 'hub') {
      m.lines.forEach(function (ln, li) { var ts = sv('tspan', { x: x0, y: top + 15 + li * 18 }, nm); ts.textContent = ln; });
      sb.setAttribute('x', x0); sb.setAttribute('y', top + m.lines.length * 18 + 14); nm.style.textAnchor = anc; sb.style.textAnchor = anc;
      var tt = g.querySelector('title') || sv('title', {}, g); tt.textContent = n.p.name;
      return;
    }
    var V = m.V, lh = LH.n * V.fs, md = g.querySelector('text.model');
    m.lines.forEach(function (ln, li) { var ts = sv('tspan', { x: x0, y: top + 15 * V.fs + li * lh }, nm); ts.textContent = ln; });
    var yS = top + m.lines.length * lh + 13;
    sb.setAttribute('x', x0); sb.setAttribute('y', yS); sb.style.display = V.sub ? '' : 'none';
    nm.style.textAnchor = anc; sb.style.textAnchor = anc;
    md.setAttribute('x', x0); md.setAttribute('y', yS + (V.sub ? LH.m : 0)); md.style.textAnchor = anc; md.style.display = m.hasM ? '' : 'none';
  }
  function chipPlace(n, chipPos) {
    var c = chips[n.id]; if (!c || !n.ct) return;
    var W = L.chipW, sd = n.side, m = n.m, V = m.V, x0 = sd === 'r' ? n.lo + 2 : sd === 'l' ? -(n.lo + 2) : 0;
    var top = n.ty;
    var cx = sd === 'r' ? n.dx + x0 : sd === 'l' ? n.dx + x0 - W : n.dx - W / 2, cy = n.dy + top + m.lines.length * LH.n * V.fs + (V.sub ? LH.s : 0) + (m.hasM ? LH.m : 0) + 2;
    var KC = kNode(), ccy = n.dy + KC * (cy - n.dy); setNode(c, n.dx + KC * (cx - n.dx), ccy, KC); cy = ccy;
    var ctt = c.querySelector('text.t'); setA(ctt, 'x', sd === 'r' ? 0 : sd === 'l' ? W : W / 2); var an = sd === 'r' ? 'start' : sd === 'l' ? 'end' : 'middle'; if (ctt.style.textAnchor !== an) ctt.style.textAnchor = an;
    chipPos[n.ct.t.id] = { x: n.dx, y: cy + KC * LH.c / 2 };
  }
  /* write displayed geometry to the DOM (cached setters: an unchanged frame writes nothing) */
  function writeDom() {
    var chipPos = {}, H = N[HEART];
    var KN = kNode();
    if (orchEl && H) setNode(orchEl, H.dx, H.dy, KN);
    NL.forEach(function (n) {
      if (n.kind === 'heart') return;
      setNode(n.el, n.dx, n.dy, KN); applyLabel(n);
      var e = edges[n.id], p = N[n.parent];
      if (e && p) { setA(e.el, 'x1', r2(p.dx)); setA(e.el, 'y1', r2(p.dy)); setA(e.el, 'x2', r2(n.dx)); setA(e.el, 'y2', r2(n.dy)); }
      if (n.kind === 'agent') chipPlace(n, chipPos);
    });
    updateDeps(chipPos);
  }
  function r2(v) { return Math.round(v * 100) / 100; }
  function updateDeps(chipPos) {
    var gD = $('g-deps'), dk = {}, H = N[HEART] || { dx: WD.hx, dy: WD.hy };
    ((state && state.tasks) || []).forEach(function (t) {
      (t.depends_on || []).forEach(function (d) {
        var a = chipPos[d], b = chipPos[t.id]; if (!a || !b) return;
        var key = d + '>' + t.id; dk[key] = 1;
        var up = taskById(d); depInfo[key] = up ? up.status : '';
        var path = deps[key] || (deps[key] = sv('path', { 'class': 'dep' }, gD));
        var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        setA(path, 'd', 'M' + r2(a.x) + ',' + r2(a.y) + ' Q' + r2(mx + (H.dx - mx) * 0.35) + ',' + r2(my + (H.dy - my) * 0.35) + ' ' + r2(b.x) + ',' + r2(b.y));
      });
    });
    Object.keys(deps).forEach(function (k) { if (!dk[k]) { deps[k].remove(); delete deps[k]; delete depInfo[k]; } });
  }

  /* ---- static layout: the solver runs to completion synchronously; the settled result is drawn directly (no tween, no rAF loop) ---- */
  function commit() { NL.forEach(function (n) { n.dx = n.x; n.dy = n.y; }); writeDom(); fxSync(); }

  /* ---- render ---- */
  function panelQ() {
    var svg = $('graph'), r = svg.getBoundingClientRect();
    return quant(svg.clientWidth || r.width, svg.clientHeight || r.height, mq && mq.matches);
  }
  function renderGraph() {
    if (!applied) { var q0 = panelQ(); applied = q0; computeLayout(q0); }
    MODEL = buildModel();
    var ag = (state.agents || []);
    ag.forEach(function (a) { if (!sticky[a.id] && taskLineFor(a)) sticky[a.id] = 1; });
    SYNC = { added: [], hard: false };
    var setChanged = syncNodes(MODEL);
    $('empty').hidden = ag.length > 0; if (!ag.length) $('empty').textContent = 'Waiting for your first Claude Code session — start one in any project and it appears here.';
    var sig = sigOf(MODEL), first = WD.fit < 0;
    if (sig !== SIG || first) {
      var szKey = [L.mobile ? 'm' : 'd', applied.w, applied.h].join('|'), sizeChanged = szKey !== SIGZ;
      SIG = sig; SIGZ = szKey;
      if (first) { NL.forEach(function (n) { n.spawn = false; }); plan(true); }
      else if (sizeChanged) plan(true);                 /* panel size / mode changed: deterministic re-plan, view back to FIT */
      else if (setChanged) {
        if (SYNC.hard || !SYNC.added.length) plan(false);   /* agents/projects left or moved: re-plan from the current positions */
        else if (!placeAdded()) plan(true);                 /* new agents only: existing nodes stay EXACTLY where they are */
        NL.forEach(function (n) { n.spawn = false; });
      } else {
        /* text only (task line appeared, project renamed): keep every position unless a label no longer fits */
        NL.forEach(function (n) { setMetrics(n, LVL); }); setRests();
        if (violations()) plan(false);
      }
      updateContent(); commit();
    }
    updateContent();
    renderOrch();
    writeDom(); fxSync();
  }

  /* ---------- drag / pin / nudge ---------- */
  /* new agents only: put each at the nearest clean free spot around its parent (deterministic, label-aware); nothing else moves */
  function placeAdded() {
    if (L.mobile || SYNC.hard) return false;
    var add = SYNC.added.slice().sort(function (a, b) { return hash(a.id) - hash(b.id) || (a.id < b.id ? -1 : 1); }), H = N[HEART], ok = true;
    NL.forEach(function (n) { setMetrics(n, LVL); }); setRests();
    add.forEach(function (a) {
      if (!ok) return;
      var p = N[a.parent], found = null, cand = [], st = 6 / WD.s, x, y, dd, k;
      for (x = WD.mg; x < WD.w - WD.mg; x += st) for (y = WD.mg; y < WD.h - WD.mg; y += st) { dd = (x - p.x) * (x - p.x) + (y - p.y) * (y - p.y); if (dd > (p.R + a.cr) * (p.R + a.cr)) cand.push([dd, x, y]); }
      cand.sort(function (u, v) { return u[0] - v[0] || u[1] - v[1] || u[2] - v[2]; });
      for (k = 0; k < cand.length && !found; k++) {
        a.x = cand[k][1]; a.y = cand[k][2]; a.vx = a.vy = 0;
        var sds = [pickSide(a), 'r', 'l', 'b', 't'];
        for (var si = 0; si < sds.length && !found; si++) { setSide(a, sds[si]); if (!nodeBad(a)) found = [a.x, a.y, a.side]; }
      }
      if (!found) { ok = false; return; }
      a.x = found[0]; a.y = found[1]; setSide(a, found[2]); a.dx = a.x; a.dy = a.y; a.spawn = false;
    });
    return ok && !violations();
  }
  /* ---------- pointer: nodes are NOT draggable; a click / Enter opens the drawer ---------- */
  function wireClick(g, id, open) {
    g.addEventListener('click', function () { open(); });
  }
  /* ---------- pan / zoom: only the SVG viewBox changes (nodes never move); particles.js follows through getScreenCTM ---------- */
  var VW = { x: 0, y: 0, w: 1000, h: 600 }, ZMIN = 0.5, ZMAX = 8, vbLast = '', fxRaf = 0, zoomUi = null;
  function svgPt(e) {
    var svg = $('graph'), m = svg.getScreenCTM && svg.getScreenCTM();
    if (m) { var pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY; var q = pt.matrixTransform(m.inverse()); return { x: q.x, y: q.y }; }
    var r = svg.getBoundingClientRect(); return { x: VW.x + (e.clientX - r.left) / r.width * VW.w, y: VW.y + (e.clientY - r.top) / r.height * VW.h };
  }
  function pxPerUnit() { var m = $('graph').getScreenCTM && $('graph').getScreenCTM(); return m && m.a ? m.a : ($('graph').clientWidth || 1) / VW.w; }
  function graphBox() {
    var x1 = 1e9, y1 = 1e9, x2 = -1e9, y2 = -1e9;
    NL.forEach(function (n) { x1 = Math.min(x1, n.x + n.bx1); x2 = Math.max(x2, n.x + n.bx2); y1 = Math.min(y1, n.y + n.by1); y2 = Math.max(y2, n.y + n.by2); });
    return x1 > x2 ? { x1: 0, y1: 0, x2: WD.w, y2: WD.h } : { x1: x1, y1: y1, x2: x2, y2: y2 };
  }
  function clampView(v) {
    var z = clamp(WD.w / v.w, ZMIN, ZMAX), w = WD.w / z, h = WD.h / z, b = graphBox();
    var ow = 0.25 * Math.min(b.x2 - b.x1, w), oh = 0.25 * Math.min(b.y2 - b.y1, h);
    return { x: clamp(v.x, b.x1 + ow - w, b.x2 - ow), y: clamp(v.y, b.y1 + oh - h, b.y2 - oh), w: w, h: h };
  }
  function paintView(hard) {
    var svg = $('graph'), z = WD.w / VW.w, r4 = function (v) { return Math.round(v * 10000) / 10000; };
    var vb = r4(VW.x) + ' ' + r4(VW.y) + ' ' + r4(VW.w) + ' ' + r4(VW.h);
    if (hard || vb !== vbLast) { vbLast = vb; svg.setAttribute('viewBox', vb); }
    var zoomed = Math.abs(VW.w - WD.w) > 0.01 || Math.abs(VW.x) > 0.01 || Math.abs(VW.y) > 0.01;
    svg.classList.toggle('zoomed', zoomed); svg.classList.toggle('zlow', z < 0.6);
    var kz = z > 1 ? Math.round(10000 / z) / 10000 : 1;
    if (svg._kz !== kz) { svg._kz = kz; svg.style.setProperty('--kz', kz); if (NL.length) writeDom(); }
    if (zoomUi) {
      zoomUi.pct.textContent = Math.round(z * 100) + '%';
      zoomUi.out.disabled = z <= ZMIN + 1e-6; zoomUi.in.disabled = z >= ZMAX - 1e-6; zoomUi.fit.disabled = !zoomed;
    }
  }
  function viewChanged() {
    hideTip(); paintView(false);
    if (window.AosFx) { if (AosFx.refreshView) AosFx.refreshView(); if (!fxRaf) fxRaf = requestAnimationFrame(function () { fxRaf = 0; fxSync(); }); }
  }
  function setView(v) { VW = clampView(v); viewChanged(); }
  function resetView() { VW = { x: 0, y: 0, w: WD.w, h: WD.h }; paintView(true); hideTip(); }
  function zoomAt(z, cx, cy) {
    z = clamp(z, ZMIN, ZMAX); var p = svgPt({ clientX: cx, clientY: cy }), w = WD.w / z, k = w / VW.w;
    setView({ x: p.x - (p.x - VW.x) * k, y: p.y - (p.y - VW.y) * k, w: w, h: WD.h / z });
  }
  function zoomMid(f) { var r = $('graph').getBoundingClientRect(); zoomAt(WD.w / VW.w * f, r.left + r.width / 2, r.top + r.height / 2); }
  function panPx(dx, dy) { var k = pxPerUnit(); setView({ x: VW.x - dx / k, y: VW.y - dy / k, w: VW.w, h: VW.h }); }
  function onBg(t) { return !(t && t.closest && t.closest('.node, .orch, .chip, [tabindex], button, a')); }
  (function wireView() {
    var svg = $('graph'), ptr = {}, pan = null, pinch = null, g0 = 1;
    function ids() { return Object.keys(ptr); }
    function dist(a, b) { return Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y)) || 1; }
    svg.addEventListener('wheel', function (e) {
      e.preventDefault();
      var dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
      var f = clamp(Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015)), 0.7, 1.43);
      zoomAt(WD.w / VW.w * f, e.clientX, e.clientY);
    }, { passive: false });
    svg.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (!onBg(e.target)) return;
      ptr[e.pointerId] = { x: e.clientX, y: e.clientY };
      var k = ids();
      if (k.length === 1) pan = { id: e.pointerId, sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY, on: false };
      else if (k.length === 2) {
        var a = ptr[k[0]], b = ptr[k[1]]; pan = null;
        pinch = { d: dist(a, b), z: WD.w / VW.w, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
        try { svg.setPointerCapture(e.pointerId); } catch (er) {}
      }
    });
    svg.addEventListener('pointermove', function (e) {
      if (!ptr[e.pointerId]) return;
      ptr[e.pointerId] = { x: e.clientX, y: e.clientY };
      if (pinch && ids().length >= 2) {
        var k = ids(), a = ptr[k[0]], b = ptr[k[1]], cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
        zoomAt(pinch.z * dist(a, b) / pinch.d, cx, cy); panPx(cx - pinch.cx, cy - pinch.cy);
        e.preventDefault(); return;
      }
      if (pan && e.pointerId === pan.id) {
        if (!pan.on) {
          var ddx = e.clientX - pan.sx, ddy = e.clientY - pan.sy; if (ddx * ddx + ddy * ddy <= 16) return;
          pan.on = true; svg.classList.add('panning'); try { svg.setPointerCapture(e.pointerId); } catch (er) {}
        }
        panPx(e.clientX - pan.lx, e.clientY - pan.ly); pan.lx = e.clientX; pan.ly = e.clientY; e.preventDefault();
      }
    });
    function up(e) {
      if (!ptr[e.pointerId]) return;
      delete ptr[e.pointerId];
      try { svg.releasePointerCapture(e.pointerId); } catch (er) {}
      if (pinch && ids().length < 2) { pinch = null; var k = ids(); if (k.length === 1) { var q = ptr[k[0]]; pan = { id: +k[0], sx: q.x, sy: q.y, lx: q.x, ly: q.y, on: true }; } }
      if (pan && e.pointerId === pan.id) pan = null;
      if (!ids().length) { pan = null; pinch = null; svg.classList.remove('panning'); }
    }
    svg.addEventListener('pointerup', up); svg.addEventListener('pointercancel', up); svg.addEventListener('lostpointercapture', up);
    window.addEventListener('blur', function () { ptr = {}; pan = null; pinch = null; svg.classList.remove('panning'); });
    svg.addEventListener('dblclick', function (e) { if (!onBg(e.target)) return; e.preventDefault(); zoomAt(WD.w / VW.w * (e.shiftKey ? 0.5 : 2), e.clientX, e.clientY); });
    /* Safari trackpad pinch */
    svg.addEventListener('gesturestart', function (e) { e.preventDefault(); g0 = WD.w / VW.w; });
    svg.addEventListener('gesturechange', function (e) { e.preventDefault(); zoomAt(g0 * e.scale, e.clientX, e.clientY); });
    svg.addEventListener('gestureend', function (e) { e.preventDefault(); });
    /* keyboard: + - 0 and arrows, only when focus is on the page body or inside the graph */
    document.addEventListener('keydown', function (e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      var t = e.target, tag = t && t.tagName;
      if (!(t === document.body || t === document.documentElement || svg.contains(t))) return;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      var k = e.key, d = e.shiftKey ? 120 : 40;
      if (k === '+' || k === '=') zoomMid(1.25);
      else if (k === '-' || k === '_') zoomMid(0.8);
      else if (k === '0') { VW = { x: 0, y: 0, w: WD.w, h: WD.h }; viewChanged(); }
      else if (/^Arrow(Left|Right|Up|Down)$/.test(k) && !document.body.classList.contains('aos-replay-open')) panPx(k === 'ArrowLeft' ? d : k === 'ArrowRight' ? -d : 0, k === 'ArrowUp' ? d : k === 'ArrowDown' ? -d : 0);
      else return;
      e.preventDefault();
    });
    /* on-screen controls, lower right of the graph panel */
    var box = document.createElement('div'); box.className = 'zoom-ctl'; box.id = 'zoom-ctl'; box.setAttribute('role', 'group'); box.setAttribute('aria-label', 'Graph zoom');
    function mk(txt, label, fn) { var b = document.createElement('button'); b.type = 'button'; b.textContent = txt; b.setAttribute('aria-label', label); b.title = label; b.addEventListener('click', fn); return b; }
    var out = mk('\u2212', 'Zoom out (-)', function () { zoomMid(0.8); }), inn = mk('+', 'Zoom in (+)', function () { zoomMid(1.25); }),
      fit = mk('Fit', 'Fit the whole graph to the view (0)', function () { VW = { x: 0, y: 0, w: WD.w, h: WD.h }; viewChanged(); }),
      pct = document.createElement('span'); pct.className = 'zoom-pct'; pct.textContent = '100%'; pct.setAttribute('aria-hidden', 'true');
    box.appendChild(out); box.appendChild(pct); box.appendChild(inn); box.appendChild(fit);
    $('stage').appendChild(box);
    zoomUi = { out: out, in: inn, fit: fit, pct: pct }; paintView(false);
  })();
  window.__aosZoomTo = function (z) { var r = $('graph').getBoundingClientRect(); zoomAt(z, r.left + r.width / 2, r.top + r.height / 2); return WD.w / VW.w; };
  /* ---------- hover / focus tooltip: fixed-position, pointer-events none, no layout effect ---------- */
  var tipEl = null, tipT = 0, tipFor = null;
  function hideTip() { clearTimeout(tipT); tipT = 0; tipFor = null; if (tipEl) tipEl.classList.remove('show'); }
  function tipLines(id) {
    var n = N[id];
    if (n && n.kind === 'hub') {
      var p = n.p, hs = hubStatus(p.agents), rt = projRan(p);
      return [p.name, cnt(p.agents.length, 'agent', 'agents') + ' · ' + hs.running + ' running' + (hs.stalled ? ' · ' + hs.stalled + ' stalled' : '') + (hs.errored ? ' · ' + hs.errored + ' errored' : '') + (rt != null ? ' · ran ' + fmtRan(rt) : '')];
    }
    var a = agentById(id), ml = a ? modelTxt(a) : '', tn = toolName(a), t = a && a.current_tool, rn = a ? ranTxt(a) : '';
    if (!a || (!tn && !ml && !rn && !a.guard)) return null;
    if (a.model_mismatch) ml = (ml || 'model') + ' (asked ' + a.requested_tier + ')';
    if (a.out_of_scope) ml = (ml ? ml + ' · ' : '') + 'OUT OF SCOPE';
    if (a.guard) ml = (ml ? ml + ' · ' : '') + 'GUARD: ' + guardTxt(a).toUpperCase();
    return [tn ? tn + (t && t.summary ? ' · ' + trunc(baseName(t.summary), 44) : '') : 'no active tool', (ml || '') + (rn ? (ml ? ' · ' : '') + rn : '')];
  }
  function showTip(g, id) {
    var ls = tipLines(id); if (!ls) return;
    if (!tipEl) { tipEl = el('div', 'aos-tip'); tipEl.setAttribute('role', 'tooltip'); tipEl.id = 'aos-tip'; document.body.appendChild(tipEl); }
    clear(tipEl);
    tipEl.appendChild(el('div', 'tip-t', ls[0]));
    if (ls[1]) tipEl.appendChild(el('div', 'tip-m', ls[1]));
    tipEl.style.left = '0px'; tipEl.style.top = '0px'; tipEl.classList.add('show');
    var r = (g.querySelector('.card') || g).getBoundingClientRect(), w = tipEl.offsetWidth, h = tipEl.offsetHeight, vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    var x = r.left + r.width / 2 - w / 2, y = r.top - h - 8;
    if (y < 6) y = r.bottom + 8;
    x = Math.max(6, Math.min(vw - w - 6, x)); y = Math.max(6, Math.min(vh - h - 6, y));
    tipEl.style.left = Math.round(x) + 'px'; tipEl.style.top = Math.round(y) + 'px'; tipFor = id;
  }
  function wireTip(g, id) {
    function arm() { hideTip(); tipT = setTimeout(function () { showTip(g, id); }, 200); }
    g.addEventListener('pointerenter', function (e) { if (e.pointerType === 'touch') return; arm(); });
    g.addEventListener('pointerleave', hideTip);
    g.addEventListener('pointerdown', hideTip);
    g.addEventListener('focus', arm);
    g.addEventListener('blur', hideTip);
    g.addEventListener('keydown', function (e) { if (e.key === 'Escape') hideTip(); });
  }
  document.addEventListener('scroll', hideTip, true);

  /* ---------- time ran (optional backend fields) ---------- */
  function fmtRan(s) { s = Math.max(0, Math.floor(+s || 0)); if (s < 60) return s + 's'; if (s < 3600) return Math.floor(s / 60) + 'm'; return Math.floor(s / 3600) + 'h ' + ('0' + Math.floor(s % 3600 / 60)).slice(-2) + 'm'; }
  function fmtRanLong(s) { s = Math.max(0, Math.floor(+s || 0)); return s < 3600 ? (s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's') : fmtRan(s); }
  function fmtTpm(n) { n = +n; return n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(Math.round(n)); }
  function hasRan(a) { return a && a.ran_s != null && isFinite(+a.ran_s); }
  function ranTxt(a) { if (!hasRan(a)) return ''; return 'ran ' + fmtRan(a.ran_s) + (a.tok_per_min != null && isFinite(+a.tok_per_min) ? ' · ' + fmtTpm(a.tok_per_min) + ' tok/min' : ''); }
  function newTok(a) { var u = a && a.usage; return u && typeof u === 'object' ? (+u.input || 0) + (+u.output || 0) + (+u.cache_write || 0) : null; }
  function projRan(p) {
    if (p.src && p.src.ran_s_total != null && isFinite(+p.src.ran_s_total)) return +p.src.ran_s_total;
    var any = false, t = 0; p.agents.forEach(function (a) { if (hasRan(a)) { any = true; t += +a.ran_s; } }); return any ? t : null;
  }

  /* ---------- file-conflict summary chip + popover ---------- */
  var conflictChip = null, conflictPop = null;
  function ensureConflict() {
    if (conflictChip) return;
    conflictChip = el('button', 'conflict-chip'); conflictChip.type = 'button'; conflictChip.hidden = true; conflictChip.id = 'conflict-chip'; conflictChip.setAttribute('aria-haspopup', 'true'); conflictChip.setAttribute('aria-expanded', 'false');
    conflictPop = el('div', 'conflict-pop'); conflictPop.id = 'conflict-pop'; conflictPop.hidden = true;
    var gb = $('goalbar'); gb.parentNode.insertBefore(conflictChip, gb.nextSibling); gb.parentNode.appendChild(conflictPop);
    conflictChip.addEventListener('click', function (e) { e.stopPropagation(); toggleConflict(conflictPop.hidden); });
    document.addEventListener('click', function (e) { if (!conflictPop.hidden && !conflictPop.contains(e.target)) toggleConflict(false); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !conflictPop.hidden) { toggleConflict(false); conflictChip.focus(); } });
  }
  function toggleConflict(on) {
    conflictPop.hidden = !on; conflictChip.setAttribute('aria-expanded', String(!!on));
    if (on) { var r = conflictChip.getBoundingClientRect(); conflictPop.style.top = Math.round(r.bottom + 6) + 'px'; conflictPop.style.left = Math.max(8, Math.min(document.documentElement.clientWidth - 328, Math.round(r.left))) + 'px'; }
  }
  function renderConflicts() {
    ensureConflict();
    var cs = (state && state.collisions) || [], n = cs.length;
    conflictChip.hidden = !n; if (!n) { conflictPop.hidden = true; return; }
    conflictChip.textContent = n + (n === 1 ? ' file conflict' : ' file conflicts');
    clear(conflictPop);
    cs.forEach(function (c) {
      var row = el('div', 'cp-row'); row.appendChild(el('b', null, c.name || baseName(c.file))); row.title = c.file || '';
      var ag = el('div', 'cp-ag');
      (c.agents || []).forEach(function (id) {
        var b = el('button', 'cp-a', splitId(id).name + (splitId(id).short ? ' ' + splitId(id).short : '')); b.type = 'button';
        b.addEventListener('click', function () { toggleConflict(false); openAgent(id); }); ag.appendChild(b);
      });
      row.appendChild(ag); conflictPop.appendChild(row);
    });
  }

  function wireNode(g, id, open) {
    wireTip(g, id);
    wireClick(g, id, open);
    g.addEventListener('keydown', keyAct(open));
  }
  /* ---------- diff / animate ---------- */
  function diff() {
    if (!prev) return;
    var old = {}; (prev.agents || []).forEach(function (a) { old[a.id] = a; });
    (state.agents || []).forEach(function (a) {
      if (old[a.id] && (old[a.id].status !== a.status || old[a.id].current_task !== a.current_task)) flash(nodes[a.id]);
    });
    if (prev.goal && state.goal && prev.goal.status !== state.goal.status) flash(orchEl);
    if (prev.heartbeat && state.heartbeat && prev.heartbeat.seq !== state.heartbeat.seq) { flash(orchEl); tickPulse(); }
    var ps = {}; (prev.tasks || []).forEach(function (t) { ps[t.id] = t.status; });
    (state.tasks || []).forEach(function (t) { if (ps[t.id] && ps[t.id] !== t.status && chips[t.assignee]) flash(chips[t.assignee]); });
  }

  /* ---------- dock ---------- */
  function evClass(type) {
    var t = String(type || ''), head = t.split('.')[0];
    if (/fail|error|dead|cancel|stall/.test(t)) return 'ev-bad';
    return { goal: 'ev-goal', agent: 'ev-agent', task: 'ev-task', heartbeat: 'ev-heartbeat', control: 'ev-control', human: 'ev-human' }[head] || 'ev-heartbeat';
  }
  function evPayload(e) { return e.data && Object.keys(e.data).length ? JSON.stringify(e.data) : ''; }
  function toggleDetail(tr, e) {
    var next = tr.nextSibling, isOpen = next && next.classList && next.classList.contains('detail');
    if (isOpen) { next.parentNode.removeChild(next); tr.classList.remove('open'); tr.setAttribute('aria-expanded', 'false'); delete openSeqs[e.seq]; return; }
    tr.parentNode.insertBefore(detailRow(e), tr.nextSibling); tr.classList.add('open'); tr.setAttribute('aria-expanded', 'true'); openSeqs[e.seq] = 1;
  }
  function detailRow(e) {
    var r = el('tr', 'detail'), td = el('td'); td.colSpan = 4;
    var pre = el('pre', null, JSON.stringify({ seq: e.seq, ts: e.ts, type: e.type, actor: e.actor, goal_id: e.goal_id, task_id: e.task_id, data: e.data }, null, 2));
    td.appendChild(pre); r.appendChild(td); return r;
  }
  var KEYEV = { 'agent.spawned': 1, 'task.started': 1, 'task.completed': 1 };
  function evSource(e) {
    var d = e.data || {}, id = e.type === 'agent.spawned' && d.agent ? d.agent : (e.actor || ''), nm = splitId(id).name || id;
    var tid = e.task_id ? splitId(String(e.task_id).replace(/^t-/, '')).name : '';
    return { text: nm, full: e.type === 'agent.spawned' && d.agent ? d.agent + (e.actor ? ' (spawned by ' + e.actor + ')' : '') : id, task: tid && tid !== nm && !/·/.test(String(e.task_id)) ? e.task_id : '' };
  }
  function renderEvents(events) {
    var sel = $('ev-filter');
    (events || []).forEach(function (e) {
      if (e.type && !knownTypes[e.type]) { knownTypes[e.type] = 1; var o = el('option', null, e.type); o.value = e.type; sel.appendChild(o); }
    });
    var all = events || [], last = all.length ? all[all.length - 1].seq : 0;
    var hideP = !showPrompts && filterVal !== 'human.note';
    var q = searchVal.toLowerCase(), maxSeq = seenSeq;
    var list = all.filter(function (e) {
      if (hideP && e.type === 'human.note') return false;
      if (filterVal && e.type !== filterVal) return false;
      if (q && (e.type + ' ' + (e.actor || '') + ' ' + (e.task_id || '') + ' ' + evPayload(e)).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var nPrompts = all.filter(function (e) { return e.type === 'human.note'; }).length;
    $('cnt-events').textContent = list.length === all.length ? String(all.length) : list.length + ' / ' + all.length;
    var pb = $('ev-prompts');
    if (pb) {
      pb.hidden = !nPrompts; pb.setAttribute('aria-pressed', String(showPrompts));
      pb.textContent = showPrompts ? 'hide prompts' : 'show prompts (' + nPrompts + ')';
    }
    var sig = filterVal + '|' + searchVal + '|' + showPrompts + '|' + all.length + '|' + last;
    if (sig === evSig) return; evSig = sig;
    var box = $('events'), atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 30;
    clear(box);
    $('ev-count').textContent = list.length === all.length ? all.length + ' events' : list.length + ' of ' + all.length + ' events';
    if (!list.length) { box.appendChild(el('div', 'empty-row', all.length ? 'No telemetry matches this filter.' : 'No telemetry yet.')); return; }
    var table = el('table', 'ev'), cg = el('colgroup');
    ['c-t', 'c-ty', 'c-a', ''].forEach(function (c) { cg.appendChild(el('col', c)); }); table.appendChild(cg);
    var th = el('thead'), hr = el('tr');
    [['Time', ''], ['Type', ''], ['Source', 'c-a-h'], ['Payload', '']].forEach(function (h) { hr.appendChild(el('th', h[1], h[0])); });
    th.appendChild(hr); table.appendChild(th);
    var tb = el('tbody');
    list.forEach(function (e) {
      var tr = el('tr', 'row' + (e.type === 'human.note' ? ' prompt' : '') + (KEYEV[e.type] ? ' key' : '') + (seenSeq != null && e.seq > seenSeq ? ' new' : '')); tr.tabIndex = 0; tr.setAttribute('role', 'button'); tr.setAttribute('aria-expanded', 'false');
      var tt = el('td', 't', fmtRel(e.ts)); tt.title = fmtTs(e.ts); tt.setAttribute('data-ts', e.ts); tr.appendChild(tt);
      var ty = el('td'); ty.appendChild(el('span', 'badge ' + evClass(e.type), e.type)); tr.appendChild(ty);
      var src = evSource(e), ac = el('td', 'a', src.text); ac.title = src.full;
      if (src.task) { ac.appendChild(el('em', null, ' ' + src.task)); } tr.appendChild(ac);
      var d = evPayload(e), dd = el('td', 'd', d || '—'); tr.appendChild(dd);
      var act = function () { toggleDetail(tr, e); };
      tr.addEventListener('click', act); tr.addEventListener('keydown', keyAct(act));
      tb.appendChild(tr);
      if (openSeqs[e.seq]) { tr.classList.add('open'); tr.setAttribute('aria-expanded', 'true'); tb.appendChild(detailRow(e)); }
      if (maxSeq == null || e.seq > maxSeq) maxSeq = e.seq;
    });
    table.appendChild(tb); box.appendChild(table);
    seenSeq = maxSeq;
    if (atBottom || !box.dataset.init) { box.scrollTop = box.scrollHeight; box.dataset.init = '1'; }
  }
  function updateRel() {
    var cells = document.querySelectorAll('#events td[data-ts]');
    for (var i = 0; i < cells.length; i++) { var t = fmtRel(cells[i].getAttribute('data-ts')); if (cells[i].textContent !== t) cells[i].textContent = t; }
  }
  function renderTasks(tasks) {
    $('cnt-tasks').textContent = (tasks || []).length;
    var sig = JSON.stringify((tasks || []).map(function (t) { var a0 = agentById(t.assignee); return [t.id, t.status, t.title, t.assignee, t.attempts, a0 && a0.ran_s, a0 && a0.tok_per_min]; }));
    if (sig === taskSig) return; taskSig = sig;
    var b = clear($('tasks'));
    if (!tasks || !tasks.length) { b.appendChild(el('div', 'empty-row', 'Manifest is empty.')); return; }
    var by = {}; tasks.forEach(function (t) { (by[t.status] = by[t.status] || []).push(t); });
    var cols = TSTAT.filter(function (s) { return by[s]; }).concat(Object.keys(by).filter(function (k) { return TSTAT.indexOf(k) < 0; }));
    cols.forEach(function (s, ci) {
      var col = el('section', 'col s-' + s); col.style.animationDelay = (ci * 40) + 'ms';
      var h = el('h3', 'col-h'); h.appendChild(el('span', null, human(s))); h.appendChild(el('span', 'count tnum', String(by[s].length))); col.appendChild(h);
      by[s].forEach(function (t) {
        var r = el('div', 'tcard'); r.tabIndex = 0; r.setAttribute('role', 'button');
        r.appendChild(el('div', 'tcard-t', t.title || t.id));
        var m = el('div', 'tcard-m'); m.appendChild(el('span', 'id', t.id));
        if (t.max_attempts) m.appendChild(el('span', null, (t.attempts || 0) + '/' + t.max_attempts));
        if (t.assignee) m.appendChild(el('span', 'who', t.assignee.replace(/^agent[-_]/, '')));
        var ta = agentById(t.assignee);
        if (hasRan(ta)) { m.appendChild(el('span', 'ran', 'ran ' + fmtRan(ta.ran_s))); if (ta.tok_per_min != null && isFinite(+ta.tok_per_min)) m.appendChild(el('span', 'tpm', fmtTpm(ta.tok_per_min) + ' tok/min')); }
        r.appendChild(m);
        var open = function () { if (t.assignee && nodes[t.assignee]) openDrawer(t.assignee); };
        r.addEventListener('click', open); r.addEventListener('keydown', keyAct(open));
        col.appendChild(r);
      });
      b.appendChild(col);
    });
  }
  function renderDockSum() { $('dock-sum').textContent = ((state && state.tasks) || []).length + ' tasks · ' + ((state && state.events) || []).length + ' events'; }

  function selectTab(name, focus) {
    ['events', 'tasks'].forEach(function (k) {
      var on = k === name, tb = $('tab-' + k);
      tb.setAttribute('aria-selected', String(on)); tb.tabIndex = on ? 0 : -1; $('pane-' + k).hidden = !on;
      if (on && focus) tb.focus();
    });
    if (name === 'events') { var bx = $('events'); bx.scrollTop = bx.scrollHeight; }
  }

  /* ---------- drawer ---------- */
  function section(body, title) { body.appendChild(el('h3', null, title)); }
  function kv(body, rows) {
    var dl = el('dl', 'kv');
    rows.forEach(function (r) { dl.appendChild(el('dt', null, r[0])); dl.appendChild(el('dd', null, String(r[1]))); });
    body.appendChild(dl);
  }
  function toolFeed(body, a) {
    var ct = a.current_tool, rt = a.recent_tools, u = a.usage, fl = a.files, cl = collOf(a.id);
    if (a.stuck) body.appendChild(el('p', 'tf-warn', 'NO SIGNAL ' + fmtCompact(a.stuck_for_s)));
    cl.forEach(function (c) {
      var o = c.agents.filter(function (x) { return x !== a.id; }).map(function (x) { return splitId(x).name + (splitId(x).short ? ' ' + splitId(x).short : ''); });
      body.appendChild(el('p', 'tf-conflict', 'FILE CONFLICT: ' + c.name + (o.length ? ' (with ' + o.join(', ') + ')' : '')));
    });
    if (ct && typeof ct === 'object' && ct.name) {
      section(body, 'Now');
      var now = el('div', 'tf-now'); now.appendChild(el('b', null, ct.name)); now.appendChild(el('span', 'tf-sum', ct.summary || ''));
      var es = el('span', 'tf-el'); es.setAttribute('data-since', ct.ts || ''); es.textContent = elapsedTxt(ct.ts); now.appendChild(es); body.appendChild(now);
    }
    if (rt && rt.length) {
      section(body, 'Recent tools');
      var box = el('div', 'tf-list');
      rt.slice(0, 15).forEach(function (r) {
        var row = el('div', 'tf-row'), t = el('span', 'tf-t', fmtRel(r.ts)); t.setAttribute('data-rts', r.ts || '');
        row.appendChild(t); row.appendChild(el('b', 'tf-n', r.name || '')); row.appendChild(el('span', 'tf-s', r.summary || '')); row.appendChild(el('span', 'tf-ms', fmtMs(r.ms)));
        row.title = (r.name || '') + ' ' + (r.summary || '') + (r.ts ? ' · ' + fmtTs(r.ts) : ''); box.appendChild(row);
      });
      body.appendChild(box);
    }
    if ((u && typeof u === 'object') || hasRan(a)) {
      section(body, 'Usage');
      if (u && typeof u === 'object') body.appendChild(el('p', 'tf-usage', 'in ' + fmtK(u.input) + ' · out ' + fmtK(u.output) + ' · cache ' + fmtK(u.cache_read) + ' read / ' + fmtK(u.cache_write) + ' write' + (u.usd_est != null ? ' · ~$' + Number(u.usd_est).toFixed(2) : '')));
      if (hasRan(a)) {
        body.appendChild(el('p', 'tf-usage tf-ran', 'RAN ' + fmtRanLong(a.ran_s) + (a.tok_per_min != null && isFinite(+a.tok_per_min) ? ' · ' + fmtTpm(a.tok_per_min) + ' new tok/min' : '')));
        if (a.started_at) body.appendChild(el('p', 'tf-usage tf-when', 'started ' + fmtTs(a.started_at) + (a.ended_at ? ' · ended ' + fmtTs(a.ended_at) : ' · still open')));
      }
    }
    if (fl && fl.length) {
      section(body, 'Files touched');
      var fb = el('div', 'tf-files'); fl.forEach(function (f) { fb.appendChild(el('span', null, baseName(f))); }); body.appendChild(fb);
    }
  }
  function elapsedTxt(ts) { var s = (Date.now() - Date.parse(ts)) / 1000; return isNaN(s) ? '' : fmtMs(Math.max(0, s) * 1000); }
  function tickDrawer() {
    var d = $('dr-body'), i, n = d.querySelectorAll('[data-since]'), r = d.querySelectorAll('[data-rts]'), t;
    for (i = 0; i < n.length; i++) { t = elapsedTxt(n[i].getAttribute('data-since')); if (n[i].textContent !== t) n[i].textContent = t; }
    for (i = 0; i < r.length; i++) { t = fmtRel(r[i].getAttribute('data-rts')); if (r[i].textContent !== t) r[i].textContent = t; }
  }
  function renderDrawer() {
    var dr = $('drawer');
    if (!selected || !state) { dr.hidden = true; return; }
    var sc = $('dr-body').scrollTop, body = clear($('dr-body')), title = $('dr-title');
    if (String(selected).indexOf('p:') === 0) {
      var pj = projOfKey(selected);
      if (!pj) { title.textContent = selected.slice(2); body.appendChild(el('p', 'muted', 'This project has no agents in view.')); dr.hidden = false; return; }
      title.textContent = pj.name;
      var hs = hubStatus(pj.agents), pp = el('p', 'dr-pills'); pp.appendChild(pill(hs.st)); body.appendChild(pp);
      var tokS = 0, tokAny = false; pj.agents.forEach(function (x) { var t0 = newTok(x); if (t0 != null) { tokAny = true; tokS += t0; } });
      var rt = projRan(pj);
      kv(body, [['Project', pj.name], ['Agents', pj.agents.length], ['Running', hs.running], ['Stalled', hs.stalled], ['Errored', hs.errored]]
        .concat(tokAny ? [['New tokens', fmtK(tokS)]] : [], rt != null ? [['Total ran', fmtRanLong(rt)]] : [], pj.src && pj.src.last_event_at ? [['Last event', fmtTs(pj.src.last_event_at)]] : []));
      section(body, 'Agents');
      var ulp = el('ul', 'proj-agents');
      pj.agents.forEach(function (x) {
        var li = el('li'), b = el('button', 'linkbtn pa-row'); b.type = 'button';
        b.appendChild(pill(x.status)); b.appendChild(el('b', null, splitId(x.id).name));
        b.appendChild(el('small', null, [splitId(x.id).short, modelTxt(x), toolName(x) ? 'using ' + toolName(x) : '', hasRan(x) ? 'ran ' + fmtRan(x.ran_s) : ''].filter(Boolean).join(' · ')));
        b.addEventListener('click', function () { window.AosApp.selectAgent(x.id); });
        li.appendChild(b); ulp.appendChild(li);
      });
      body.appendChild(ulp);
      var pc = ((state && state.collisions) || []).filter(function (c) { return (c.agents || []).some(function (id) { return pj.agents.some(function (x) { return x.id === id; }); }); });
      if (pc.length) { section(body, 'Files in conflict'); pc.forEach(function (c) { body.appendChild(el('p', 'tf-conflict', (c.name || baseName(c.file)) + ' (' + (c.agents || []).map(function (id) { return splitId(id).name; }).join(', ') + ')')); }); }
    } else if (selected === 'orch') {
      var live = isLive(); title.textContent = live ? 'Claude Code' : 'Orchestrator';
      var hb = state.heartbeat, lv = liveness(hb), g = state.goal;
      if (hb) {
        var mm = mergedMain(), r = el('p', 'dr-pills');
        r.appendChild(pill(mm ? sessionDisp(mm, lv) : dispLive(lv.l))); if (!live || hb.status !== 'running') r.appendChild(pill(hb.status)); body.appendChild(r);
        if (mm) {
          if (mm.role) { var rp0 = el('p', null, mm.role); rp0.style.overflowWrap = 'anywhere'; body.appendChild(rp0); }
          kv(body, [['Session', mm.id], ['Status', mm.status]].concat(mm.model_label ? [['Model', mm.model_label + (mm.model && mm.model !== mm.model_label ? ' (' + mm.model + ')' : '')]] : [], mm.effort ? [['Effort', mm.effort]] : [],
            [['Current task', mm.current_task || 'none'], ['Last event', fmtTs(mm.last_event_at) || 'n/a']]));
        }
        kv(body, [['Seq', hb.seq], [live ? 'Last activity' : 'Age', live ? (lv.age < 2 ? 'just now' : fmtAge(lv.age) + ' ago') : fmtAge(lv.age)], ['Interval', hb.interval_s + 's'],
          ['Last tick', hb.last_tick_ms != null ? hb.last_tick_ms + ' ms' : 'n/a'], ['Consecutive errors', hb.consecutive_errors || 0],
          ['Mode', state.mode || 'n/a']].concat((function () { var m0 = (state.agents || []).filter(function (x) { return isMain(x.id) && x.model_label; })[0]; return m0 ? [['Model', m0.model_label]] : []; })()));
      } else body.appendChild(el('p', 'muted', 'No pulse recorded yet.'));
      if (g) {
        section(body, 'Goal'); body.appendChild(el('strong', null, g.title)); if (g.description) body.appendChild(el('p', null, g.description));
        var ul = el('ul'); (g.success_criteria || []).forEach(function (c) {
          var li = el('li', 'crit' + (c.met ? ' met' : '')); li.appendChild(el('span', 'sr-only', c.met ? 'Met: ' : 'Not met: '));
          li.appendChild(document.createTextNode((c.met ? '✓ ' : '○ ') + (c.text || c.id))); ul.appendChild(li);
        });
        body.appendChild(ul);
        if (g.budget) {
          section(body, 'Budget');
          var brows = [['Ticks', g.budget.max_ticks]];
          if (g.budget.max_usd != null) brows.push(['Spent', '$' + Number(g.budget.spent_usd || 0).toFixed(2) + ' / $' + g.budget.max_usd]);
          kv(body, brows);
        }
      }
      var mmF = mergedMain(); if (mmF) toolFeed(body, mmF);
      section(body, 'Recent telemetry'); var mmE = mergedMain(); evList(body, (state.events || []).filter(function (e) { return e.actor === 'orchestrator' || (mmE && e.actor === mmE.id); }));
    } else {
      var a = (state.agents || []).filter(function (x) { return x.id === selected; })[0];
      if (!a) { title.textContent = selected; body.appendChild(el('p', 'muted', 'This crew member is no longer registered.')); dr.hidden = false; return; }
      title.textContent = a.id;
      var p = el('p', 'dr-pills'); p.appendChild(pill(a.status));
      if (a.model_mismatch) { var mb = el('span', 'tag mm-badge', 'asked ' + a.requested_tier + ', got ' + (a.model_label || a.model || '?')); mb.title = 'The orchestrator requested the ' + a.requested_tier + ' tier for this task but a different model was served'; p.appendChild(mb); }
      if (a.out_of_scope) { var sb = el('span', 'tag oos-badge', 'out of scope'); sb.title = 'An attempt at this task changed files outside its declared path_scope and was rejected by the orchestrator'; p.appendChild(sb); }
      if (window.AOSGuard && AOSGuard.badgeEl) { var gb = AOSGuard.badgeEl(a, state); if (gb) p.appendChild(gb); }
      body.appendChild(p);
      if (a.role) { var rp = el('p', null, a.role); rp.style.overflowWrap = 'anywhere'; body.appendChild(rp); }
      kv(body, [['Full id', a.id]].concat(a.machine ? [['Machine', a.machine]] : []).concat(a.model_label ? [['Model', a.model_label + (a.model && a.model !== a.model_label ? ' (' + a.model + ')' : '')]] : [], a.effort ? [['Effort', a.effort]] : [], [['Current task', a.current_task || 'none'], ['Can delegate', a.can_delegate ? 'yes' : 'no'], ['Last event', fmtTs(a.last_event_at) || 'n/a']]));
      toolFeed(body, a);
      if ((a.capabilities || []).length) { section(body, 'Capabilities'); var c = el('div'); a.capabilities.forEach(function (x) { c.appendChild(el('span', 'tag', x)); }); body.appendChild(c); }
      section(body, 'Tasks');
      var mine = (state.tasks || []).filter(function (t) { return t.assignee === a.id; }), ul2 = el('ul');
      if (!mine.length) ul2.appendChild(el('li', 'muted', 'No tasks assigned.'));
      mine.forEach(function (t) {
        var li = el('li'); li.appendChild(pill(t.status)); li.appendChild(document.createTextNode(t.title || t.id));
        li.appendChild(el('small', null, t.id + ' · attempt ' + (t.attempts || 0) + '/' + (t.max_attempts || '?') + ((t.depends_on || []).length ? ' · after ' + t.depends_on.join(', ') : '')));
        ul2.appendChild(li);
      });
      body.appendChild(ul2);
      section(body, 'Recent telemetry');
      var ids = {}; mine.forEach(function (t) { ids[t.id] = 1; });
      evList(body, (state.events || []).filter(function (e) { return e.actor === a.id || (e.task_id && ids[e.task_id]); }));
    }
    var wasHidden = dr.hidden; dr.hidden = false; $('dr-body').scrollTop = sc;
    if (!wasHidden) { var kids = body.children; for (var i = 0; i < kids.length; i++) kids[i].style.animation = 'none'; }
  }
  function evList(body, list) {
    var ul = el('ul'); list = list.slice(-8).reverse();
    if (!list.length) ul.appendChild(el('li', 'muted', 'No telemetry.'));
    list.forEach(function (e) {
      var li = el('li', null, e.type); li.appendChild(el('small', null, fmtTs(e.ts) + (e.task_id ? ' · ' + e.task_id : '')));
      ul.appendChild(li);
    });
    body.appendChild(ul);
  }
  function openDrawer(id) {
    lastFocus = document.activeElement; selected = id; $('drawer').hidden = true; renderDrawer(); markSel(); $('dr-close').focus();
  }
  function closeDrawer() {
    selected = null; $('drawer').hidden = true; markSel();
    if (lastFocus && document.body.contains(lastFocus)) lastFocus.focus();
  }
  function markSel() {
    if (orchEl) orchEl.classList.toggle('sel', selected === 'orch');
    Object.keys(nodes).forEach(function (k) { nodes[k].classList.toggle('sel', selected === k); nodes[k]._cls = nodes[k].getAttribute('class'); });
    Object.keys(hubEls).forEach(function (k) { hubEls[k].classList.toggle('sel', selected === k); hubEls[k]._cls = hubEls[k].getAttribute('class'); });
  }

  /* ---------- state (read-only view) ---------- */
  function renderControls() {
    var live = isLive();
    document.body.classList.toggle('mode-live', live);
    $('live-ind').hidden = !live;
  }
  function setBanner(msg) { var b = $('banner'); if (msg) { if (b.hidden || b.textContent !== msg) { b.textContent = msg; b.hidden = false; } } else b.hidden = true; }

  function render() {
    renderGoal(state.goal); renderGraph(); renderStats(); renderEvents(state.events); renderTasks(state.tasks); renderDockSum();
    renderControls(); renderConflicts(); renderDrawer(); markSel();
  }
  function setUpdated(txt, off) { $('updated-t').textContent = txt; $('updated').classList.toggle('off', !!off); }
  function poll() {
    fetch('/api/state', { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status); return r.json();
    }).then(function (s) {
      lastOk = Date.now(); failed = false; setBanner(null);
      liveState = s;
      subs.forEach(function (f) { try { f(s); } catch (e3) { if (window.console) console.error(e3); } });
      if (override) { setUpdated('Updated ' + new Date().toLocaleTimeString()); return; }
      applyState(s, true);
      setUpdated('Updated ' + new Date().toLocaleTimeString());
    }, function (err) {
      failed = true;
      setBanner('Cannot reach the orchestrator server (' + err.message + '). Retrying every 2s' +
        (lastOk ? '; showing stale data from ' + new Date(lastOk).toLocaleTimeString() + '.' : '.'));
      setUpdated('Disconnected', true);
      try {
        if (!state) {
          var gt = $('goal-title'); gt.classList.remove('skeleton-text'); gt.textContent = 'No data: server unreachable';
          $('empty').hidden = false; $('empty').textContent = 'No data: server unreachable.';
          clear($('events')).appendChild(el('div', 'empty-row', 'No data: server unreachable.'));
          clear($('tasks')).appendChild(el('div', 'empty-row', 'No data: server unreachable.'));
          ensureOrch(); renderOrch();
        }
        renderControls();
      } catch (e2) { if (window.console) console.error(e2); }
    });
  }
  var liveState = null, override = null, subs = [];
  function applyState(s, fromPoll) {
    if (window.AosMachines) { try { AosMachines.render(s); s = AosMachines.filter(s); } catch (e0) { if (window.console) console.error(e0); } }
    if (window.AosDone) { try { s = AosDone.filter(s); } catch (e1) { if (window.console) console.error(e1); } }
    prev = fromPoll ? state : null; state = s;
      try { render(); diff(); if (fromPoll && window.AosFx) AosFx.onState(state, prev); }
      catch (err) {
        if (window.console) console.error(err);
        setBanner('Dashboard render error: ' + (err && err.message ? err.message : err) + '. Data was received; try a hard refresh.');
      }
  }
  window.AosApp = {
    getState: function () { return state; },
    refresh: function () { var r = override || liveState; if (r) applyState(r, false); },
    setOverride: function (s) {
      if (s) { override = s; applyState(s, false); }
      else { override = null; if (liveState) applyState(liveState, false); }
    },
    onState: function (cb) { if (typeof cb === 'function') subs.push(cb); return function () { subs = subs.filter(function (f) { return f !== cb; }); }; },
    selectAgent: function (id) { if (id === 'orch') openDrawer('orch'); else openAgent(id); },
    selectProject: function (id) { openAgent(String(id).indexOf('p:') === 0 ? id : 'p:' + id); },
    isLive: function () { return !override; }
  };
  $('ev-filter').addEventListener('change', function (e) { filterVal = e.target.value; if (state) renderEvents(state.events); });
  if ($('ev-prompts')) $('ev-prompts').addEventListener('click', function () { showPrompts = !showPrompts; if (state) renderEvents(state.events); });
  $('ev-search').addEventListener('input', function (e) { searchVal = e.target.value.trim(); if (state) renderEvents(state.events); });
  $('goalbar').addEventListener('click', function () { openDrawer('orch'); });
  $('dr-close').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && selected) closeDrawer();
  });
  function setDock(open, save) {
    $('dock-toggle').setAttribute('aria-expanded', String(open)); $('dock').classList.toggle('collapsed', !open);
    $('dock-toggle').setAttribute('aria-label', open ? 'Collapse telemetry and manifest' : 'Expand telemetry and manifest');
    if (save) { try { localStorage.setItem('aos.dock', open ? 'open' : 'closed'); } catch (e) {} }
    if (open) { var bx = $('events'); bx.scrollTop = bx.scrollHeight; }
    setTimeout(function () { try { window.dispatchEvent(new Event('resize')); } catch (e) {} }, 30);
  }
  function dockOpen() { return $('dock-toggle').getAttribute('aria-expanded') === 'true'; }
  var dockPref = null; try { dockPref = localStorage.getItem('aos.dock'); } catch (e) {}
  setDock(dockPref === 'open', false);
  $('dock-toggle').addEventListener('click', function (e) { e.stopPropagation(); setDock(!dockOpen(), true); });
  $('dock').querySelector('.dock-bar').addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('#dock-toggle')) return;
    var tab = e.target.closest && e.target.closest('.tab');
    if (tab) { if (!dockOpen()) setDock(true, true); } else setDock(!dockOpen(), true);
  });
  $('tab-events').addEventListener('click', function () { selectTab('events'); });
  $('tab-tasks').addEventListener('click', function () { selectTab('tasks'); });
  $('dock').querySelector('.tabs').addEventListener('keydown', function (e) {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); selectTab(e.target.id === 'tab-events' ? 'tasks' : 'events', true); }
  });
  /* re-plan only when the quantized panel moves by more than 24px (scrollbars, sub-pixel jitter and feedback loops cannot re-plan) */
  /* pure gate: does a measured (quantized) panel size differ enough from the applied one to re-plan? */
  function sizeGate(ap, q) { return !ap || q.m !== ap.m || Math.abs(q.w - ap.w) > 24 || (!q.m && Math.abs(q.h - ap.h) > 24); }
  function quant(w, h, m) { return { w: Math.max(296, Math.round(w / 8) * 8), h: m ? 0 : Math.max(296, Math.round(h / 8) * 8), m: !!m }; }
  window.__aosSizeGate = sizeGate; window.__aosQuant = quant; window.__aosFmtRan = fmtRan;
  window.__aosReplan = function () { plan(true); commit(); return { fit: WD.fit, lvl: LVL, s: WD.s }; };
  function onResize() {
    var q = panelQ();
    if (!sizeGate(applied, q)) return;
    var modeFlip = !applied || q.m !== applied.m;
    applied = q; computeLayout(q);
    if (modeFlip) resetGraph();
    if (state) { try { renderGraph(); } catch (e) { if (window.console) console.error(e); } } else renderOrch();
  }
  if (mq) { if (mq.addEventListener) mq.addEventListener('change', onResize); else if (mq.addListener) mq.addListener(onResize); }
  var rzT = null;
  window.addEventListener('resize', function () { clearTimeout(rzT); rzT = setTimeout(onResize, 120); });

  /* hand the graph to particles.js: endpoints in SVG user units, heart/hub as endpoint 1. Called every frame while anything moves. */
  function fxSync() {
    if (!window.AosFx || !state) return;
    var ed = [], nd = [], dp = [], H = N[HEART], KN = kNode();
    NL.forEach(function (n) {
      nd.push({ id: n.id, x: n.dx, y: n.dy, r: (n.R || 0) * KN });
      if (n.kind === 'heart') return;
      var p = N[n.parent], e = edges[n.id]; if (!p || !e) return;
      if (n.kind === 'hub') {
        var hs = hubStatus(n.p.agents);
        ed.push({ id: 'T:' + n.id, el: e.el, kind: 'trunk', x1: p.dx, y1: p.dy, x2: n.dx, y2: n.dy, r1: p.R * KN, r2: n.R * KN, status: hs.st, activity: hs.running + 0.5 * hs.stalled });
      } else {
        var st = n.a.status || 'idle';
        ed.push({ id: 'B:' + n.id, el: e.el, kind: 'branch', x1: p.dx, y1: p.dy, x2: n.dx, y2: n.dy, r1: p.R * KN, r2: n.R * KN, status: st, activity: st === 'running' ? 1 : 0, agent: n.id });
      }
    });
    Object.keys(deps).forEach(function (k) { dp.push({ id: k, el: deps[k], status: depInfo[k] || '' }); });
    AosFx.sync({ state: state, edges: ed, nodes: nd, deps: dp, cx: H ? H.dx : WD.hx, cy: H ? H.dy : WD.hy, mobile: !!L.mobile, cw: L.cw, ch: L.ch, k: KN, graph: $('graph') });
    if (AosFx.invalidate) AosFx.invalidate();
  }
  window.__aosGraph = function () { return { fit: WD.fit, lvl: LVL, s: WD.s, w: WD.w, h: WD.h, runs: layoutRuns, frames: 0, sleeping: true, view: { x: VW.x, y: VW.y, w: VW.w, h: VW.h, z: WD.w / VW.w }, bad: violations(), sig: SIG, why: (function () { DBG = []; relax(0.6, true); var d = DBG; DBG = null; return d; })(),
    nodes: NL.map(function (n) { return { id: n.id, kind: n.kind, x: n.x, y: n.y, dx: n.dx, dy: n.dy, side: n.side, lab: [n.x + n.rx1, n.y + n.ry1, n.x + n.rx2, n.y + n.ry2], R: n.R }; }) }; };
  applied = panelQ(); computeLayout(applied); ensureOrch(); renderOrch();
  setInterval(function () { if (state) { renderOrch(); renderStats(); updateRel(); if (selected === 'orch') renderDrawer(); if (selected) tickDrawer(); } }, 1000);
  setInterval(function () { if (!document.hidden || !state) poll(); }, POLL_MS); /* no polling in a background tab */
  document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });
  poll();
})();
