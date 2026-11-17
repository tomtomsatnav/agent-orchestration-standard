import assert from 'node:assert/strict';
import { render, renderModel, cleanup, _resetCleanup, detectColor, handleKey, initialUi, fmtDur, snapshotJson } from './dash.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const STAT = ['running', 'idle', 'stalled', 'errored', 'idle'];
// ran: add the monitor's run-time fields (ran_s, tok_per_min); omitted = an older monitor
function fixture(n, mains = 1, ran = false) {
  const agents = [];
  for (let i = 0; i < mains; i++) agents.push({ id: 'Claude Code·' + (912 + i) + 'b', role: 'orchestrator', status: i ? 'idle' : 'running', model_label: 'Sonnet 5.5', usage: { input: 10, output: 500, cache_read: 1e6, cache_write: 4000 }, current_tool: null, ...(ran ? { ran_s: 720, tok_per_min: 4100 } : {}) });
  for (let i = 0; i < n; i++) agents.push({ id: (i % 3 ? 'Build the terminal ASCII dashboard renderer ' + i : 'Short ' + i) + '·a' + (100 + i), role: 'general-purpose', status: STAT[i % 5], model_label: i % 2 ? 'Haiku 5.5' : 'Sonnet 5.5', usage: { input: 5, output: 90, cache_read: 5000, cache_write: 700 }, current_tool: i % 5 ? null : { name: 'Bash', summary: 'node' }, ...(ran ? { ran_s: 45 + 61 * i, tok_per_min: i ? null : 35 } : {}) });
  return { goal: { title: 'Test goal' }, agents, cost: { tokens_total: 1e6, by_model: { m: { input: 10, output: 20, cache_read: 1e6, cache_write: 5 } } }, collisions: [], alerts: [{ text: 'needs input' }] };
}
const ov = (a, b) => a.x0 < b.x0 + b.w && b.x0 < a.x0 + a.w && a.y0 < b.y0 + b.h && b.y0 < a.y0 + a.h;
let ringCases = 0, listCases = 0;

for (const [c, r] of [[100, 30], [140, 40], [80, 24]]) for (const n of [1, 2, 5, 9, 12]) for (const mains of [1, 2]) {
  const st = fixture(n, mains);
  for (const frame of [0, 3, 17]) {
    const m = renderModel(st, c, r, { frame });
    assert.equal(m.plain.length, r, 'row count');
    for (const l of m.plain) assert.ok([...l].length <= c, `line too wide ${c}x${r}`);
    if (m.mode === 'ring') {
      ringCases++;
      const boxes = m.labels.map((l) => ({ x0: l.x0, y0: l.y0, w: l.w, h: l.h }));
      const orbs = m.orbs.map((o) => ({ x0: o.x, y0: o.y, w: 1, h: 1 }));
      const fixed = [{ x0: m.centre.x, y0: m.centre.y, w: 1, h: 1 }, m.centreLabel];
      assert.equal(m.orbs.length, n);
      for (const b of [...boxes, ...orbs, ...fixed]) assert.ok(b.x0 >= 0 && b.y0 >= 2 && b.x0 + b.w <= c && b.y0 + b.h <= r - 1, `clipped ${JSON.stringify(b)}`);
      const all = [...boxes, ...orbs, ...fixed];
      for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) assert.ok(!ov(all[i], all[j]), `overlap ${c}x${r} n=${n}`);
      for (const p of m.particles) { assert.ok(!m.reserved.has(p.y * c + p.x), 'particle on reserved'); assert.ok(p.x >= 0 && p.x < c && p.y >= 2 && p.y < r - 1); assert.ok(!(p.x === m.centre.x && p.y === m.centre.y)); }
      if (frame === 0 && n >= 2) assert.ok(m.particles.length > 0, 'has particles');
    } else listCases++;
  }
}
assert.ok(ringCases > 30, 'ring view used for most cases: ' + ringCases);

// list thresholds
assert.equal(renderModel(fixture(5), 79, 30).mode, 'list');
assert.equal(renderModel(fixture(5), 100, 23).mode, 'list');
// auto ring follows the area, not a fixed agent count
assert.equal(renderModel(fixture(15), 160, 50).mode, 'ring', 'auto ring when 15 fit at 160x50');
assert.equal(renderModel(fixture(60), 100, 30).mode, 'list', 'auto list when 60 cannot fit');
assert.equal(renderModel(fixture(5), 100, 30).mode, 'ring');
assert.equal(renderModel(fixture(5), 100, 30, { list: true }).mode, 'list');

// ---- view override, key handling, and text-cell safety
const tags = (m) => m.plain[m.plain.length - 1];
const textBoxes = (m) => {
  const b = [...m.labels.map((l) => ({ x0: l.x0, y0: l.y0, w: l.w, h: l.h, k: 'label' }))];
  if (m.centreLabel) b.push({ ...m.centreLabel, k: 'centre-label' });
  if (m.notice) b.push({ x0: 1, y0: m.rows - 2, w: Math.min([...m.notice].length, m.cols - 1), h: 1, k: 'notice' });
  return b;
};
function assertNoTextOverlap(m, label) {
  const tb = textBoxes(m);
  for (let i = 0; i < tb.length; i++) for (let j = i + 1; j < tb.length; j++) assert.ok(!ov(tb[i], tb[j]), `text overlap ${label} ${tb[i].k}/${tb[j].k}`);
  const orbs = m.orbs.map((o) => ({ x0: o.x, y0: o.y, w: 1, h: 1 }));
  const fixed = [...orbs, { x0: m.centre.x, y0: m.centre.y, w: 1, h: 1 }];
  for (const f of fixed) for (const t of tb) assert.ok(!ov(f, t), `orb/centre on text ${label} ${t.k}`);
  for (const p of m.particles) {
    for (const t of tb) assert.ok(!ov({ x0: p.x, y0: p.y, w: 1, h: 1 }, t), `particle on text ${label}`);
    assert.ok(!orbs.some((o) => o.x0 === p.x && o.y0 === p.y) && !(p.x === m.centre.x && p.y === m.centre.y), `particle on orb ${label}`);
  }
  for (const l of m.plain) assert.ok([...l].length <= m.cols, `too wide ${label}`);
  assert.equal(m.plain.length, m.rows, 'row count ' + label);
}

// key cycle: auto -> list (forced) -> ring (forced) -> auto, and the choice persists across redraws
for (const [c, r, n] of [[100, 30, 16], [177, 91, 16], [177, 91, 30]]) {
  const st = fixture(n);
  let ui = initialUi({});
  const seen = [];
  const draw = () => { const m = renderModel(st, c, r, { view: ui.view, frame: 4 }); seen.push([ui.view, m.mode, m.labelMode, tags(m)]); return m; };
  assert.equal(draw().mode, renderModel(st, c, r).mode, 'auto matches default');
  ui = handleKey(ui, 'l').ui; const ml = draw(); assert.equal(ml.mode, 'list', 'forced list');
  assert.ok(tags(ml).includes('view: list (forced)'), tags(ml));
  ui = handleKey(ui, 'l').ui; const mr = draw(); assert.equal(mr.mode, 'ring', `forced ring ${c}x${r} n=${n}`);
  assert.ok(tags(mr).includes('view: ring (forced'), tags(mr));
  assertNoTextOverlap(mr, `forced ring ${c}x${r} n=${n}`);
  assert.equal(mr.orbs.length, n, 'all orbs drawn in forced ring');
  ui = handleKey(ui, 'l').ui; assert.equal(ui.view, 'auto'); const ma = draw();
  assert.ok(tags(ma).includes('view: ' + ma.mode + ' (auto)'), tags(ma));
  assert.equal(handleKey(ui, 'x').handled, false, 'unknown key ignored');
  // the forced list stays list at any size
  assert.equal(renderModel(st, c, r, { view: 'list' }).mode, 'list');
}
// auto at 177x91 with 16 agents must be ring, forced list must be list
{
  const m = renderModel(fixture(16), 177, 91, { view: 'auto' });
  assert.equal(m.mode, 'ring'); assert.equal(m.labelMode, 'full');
  assert.ok(tags(m).includes('view: ring (auto)'), tags(m));
  assertNoTextOverlap(m, '177x91 auto');
}
// forced ring degrades: full -> compact -> orbs only with one notice line, never text on text
{
  const seen = new Set();
  for (const [c, r] of [[100, 30], [84, 24], [60, 20], [40, 12], [30, 8], [20, 5]]) for (const n of [4, 9, 16, 30]) {
    const m = renderModel(fixture(n), c, r, { view: 'ring' });
    seen.add(m.labelMode);
    assertNoTextOverlap(m, `forced ${c}x${r} n=${n}`);
    if (m.labelMode === null) {
      assert.equal(m.notice, `ring: ${n} agents too many for this size, labels hidden: press l for list`);
      const want = [...m.notice].length <= c - 1 ? m.notice : [...m.notice].slice(0, c - 2).join('') + '…';
      assert.equal(m.plain[r - 2].slice(1), want, 'notice line drawn');
      assert.equal(m.labels.length, 0);
    }
    if (m.labelMode === 'compact') for (const l of m.labels) assert.ok(l.lines.every((s) => s.every((seg) => [...seg[0]].length <= 14)), 'compact names <= 14');
  }
  assert.ok(seen.has(null) && seen.has('compact'), 'degradation reached: ' + [...seen]);
}
assert.ok(renderModel(fixture(30), 40, 12, { view: 'ring' }).plain[10].includes('ring: 30 agents'));
// existing cases must not change: list at narrow/short, auto ring with 5 agents
assert.equal(renderModel(fixture(16), 79, 30, { view: 'auto' }).mode, 'list');
assert.equal(renderModel(fixture(16), 177, 91, { view: 'list' }).mode, 'list');
assert.ok(render(fixture(5), 60, 24).includes('SONNET') === false && render(fixture(5), 60, 24).includes('STATUS'));
// header, centre label, down state
const t = render(fixture(5, 2), 100, 30);
assert.ok(t.includes('8 agents · 2 running') || /\d+ agents · \d+ running/.test(t));
assert.ok(t.includes('CLAUDE CODE · 2 SESSIONS'));
assert.ok(t.includes('new tokens 1.0k') || /new tokens/.test(t));
assert.ok(render(null, 80, 24).includes('monitor not reachable'));
// new-token total excludes cache reads
assert.ok(render(fixture(1), 100, 30).includes('new tokens 35'), 'new = 10+20+5');
// colour modes
assert.ok(!/\x1b/.test(render(fixture(5), 100, 30, { color: 'none' })));
for (const mode of ['16', '256', 'true']) assert.ok(/\x1b\[/.test(render(fixture(5), 100, 30, { color: mode })));
assert.ok(/38;2;/.test(render(fixture(5), 100, 30, { color: 'true' })));
assert.equal(detectColor({ NO_COLOR: '1', COLORTERM: 'truecolor' }, { isTTY: true }, []), 'none');
assert.equal(detectColor({ COLORTERM: 'truecolor' }, { isTTY: true }, ['--no-color']), 'none');
assert.equal(detectColor({ COLORTERM: 'truecolor' }, { isTTY: true }, []), 'true');
assert.equal(detectColor({ TERM: 'xterm-256color' }, { isTTY: true }, []), '256');
assert.equal(detectColor({ TERM: 'xterm' }, { isTTY: true }, []), '16');
// particles advance
assert.notEqual(render(fixture(5), 100, 30, { frame: 0 }), render(fixture(5), 100, 30, { frame: 1 }));

// --once with NO_COLOR, unreachable monitor (port 9 is closed), no ANSI
const script = fileURLToPath(new URL('./dash.mjs', import.meta.url));
const res = spawnSync(process.execPath, [script, '--once', '--port', '9'], { env: { ...process.env, NO_COLOR: '1', COLORTERM: 'truecolor' }, encoding: 'utf8' });
assert.equal(res.status, 0); assert.ok(!/\x1b/.test(res.stdout)); assert.ok(res.stdout.includes('monitor not reachable'));

// ---- --json snapshot
{
  const st = { agents: [
    { id: 'a1', role: 'orchestrator', status: 'running', model_label: 'Sonnet 5.5', usage: { input: 10, output: 500, cache_read: 1e6, cache_write: 4000 }, current_tool: { name: 'Bash' } },
    { id: 'a2', role: 'general-purpose', status: 'idle', model_label: 'Haiku 5.5', usage: { input: 5, output: 90, cache_read: 5000, cache_write: 700 }, current_tool: null },
  ] };
  const snap = snapshotJson(st);
  assert.equal(snap.agents.length, 2);
  for (const a of snap.agents) assert.deepEqual(Object.keys(a).sort(), ['id', 'model_label', 'role', 'status']);
  assert.ok(!('tasks' in snap), 'no tasks key without tasks');
  assert.equal(snap.totals.agents, 2);
  assert.equal(snap.totals.tokens_total, (10 + 500 + 4000) + (5 + 90 + 700), 'input+output+cache_write, no cache_read');
  const withTasks = snapshotJson({ agents: [], tasks: [{ id: 't1', title: 'x' }] });
  assert.deepEqual(withTasks.tasks, [{ id: 't1', title: 'x' }]);
  assert.ok(!('tasks' in snapshotJson({ agents: [], tasks: [] })), 'empty tasks omitted');
  const empty = { agents: [], totals: { agents: 0, tokens_total: 0 } };
  assert.deepEqual(snapshotJson(null), empty);
  assert.deepEqual(snapshotJson(undefined), empty);
  const frozen = JSON.parse(JSON.stringify({ ...st, tasks: [{ id: 't1' }] }));
  snapshotJson(frozen);
  assert.deepEqual(frozen, JSON.parse(JSON.stringify({ ...st, tasks: [{ id: 't1' }] })), 'input not mutated');
  const jr = spawnSync(process.execPath, [fileURLToPath(new URL('./dash.mjs', import.meta.url)), '--json', '--port', '9'], { encoding: 'utf8' });
  assert.equal(jr.stdout.trim(), '{"error":"monitor unreachable"}'); assert.equal(jr.status, 1);
}

// ---- run time (ran_s / tok_per_min): formatting, list columns, ring labels, zero overlap with them present
assert.equal(fmtDur(45), '45s'); assert.equal(fmtDur(0), '0s'); assert.equal(fmtDur(720), '12m'); assert.equal(fmtDur(3900), '1h 05m');
assert.equal(fmtDur(59.6), '1m'); assert.equal(fmtDur(undefined), '-'); assert.equal(fmtDur(null), '-'); assert.equal(fmtDur(-5), '-');
{
  const pl = renderModel(fixture(5, 1, true), 120, 30, { view: 'list' }).plain;
  assert.ok(/ RAN /.test(pl[2]) && /TOK\/MIN/.test(pl[2]), 'run + tok/min headers at 120: ' + pl[2]);
  assert.ok(/12m/.test(pl[3]) && /4\.1k/.test(pl[3]), 'main row ran + tok/min: ' + pl[3]);
  assert.ok(/45s/.test(pl[4]), 'sub row ran 45s: ' + pl[4]);
  const w100 = renderModel(fixture(5, 1, true), 100, 30, { view: 'list' }).plain;
  assert.ok(/RAN/.test(w100[2]) && !/TOK\/MIN/.test(w100[2]), 'tok/min hidden under 120 cols');
  assert.ok(!/RAN/.test(renderModel(fixture(5, 1, true), 50, 30, { view: 'list' }).plain[2]), 'run column hidden under 56 cols');
  const old = renderModel(fixture(5), 120, 30, { view: 'list' }).plain.join('\n'); // older monitor: no run fields
  assert.ok(/RAN/.test(old) && !/NaN|undefined/.test(old), 'missing run fields render as -');
  for (const [c, r] of [[120, 30], [100, 30], [56, 20], [40, 20]]) for (const l of renderModel(fixture(9, 2, true), c, r, { view: 'list' }).plain) assert.ok([...l].length <= c, `list too wide ${c}`);
}
for (const [c, r] of [[177, 91], [140, 40], [100, 30]]) for (const n of [1, 5, 9, 16]) for (const mains of [1, 2]) for (const frame of [0, 9]) {
  const m = renderModel(fixture(n, mains, true), c, r, { frame });
  if (m.mode === 'ring') { assertNoTextOverlap(m, `ran ${c}x${r} n=${n}`); assert.equal(m.orbs.length, n); }
}
{
  const m = renderModel(fixture(16, 1, true), 177, 91);
  assert.equal(m.mode, 'ring');
  assert.ok(/ran (\d+s|\d+m|\d+h \d\dm)/.test(m.plain.join('\n')), 'ring labels show ran');
  assert.ok(m.labels.some((l) => l.lines.some((segs) => segs.some((seg) => /^ · ran /.test(seg[0])))), 'ran sits on a label status line');
  assert.ok(!/\bran \d/.test(renderModel(fixture(16), 177, 91).plain.join('\n')), 'no ran text without run fields');
  for (const [c, r] of [[100, 30], [84, 24], [60, 20], [40, 12], [30, 8], [20, 5]]) for (const n of [4, 9, 16, 30]) assertNoTextOverlap(renderModel(fixture(n, 1, true), c, r, { view: 'ring' }), `forced ran ${c}x${r} n=${n}`);
}


// ---- project graph: heart -> project hubs -> agents
function pfix(counts, { names, ran = true } = {}) {
  const agents = [], projects = [];
  counts.forEach((n, pi) => {
    const ids = [];
    for (let i = 0; i < n; i++) {
      const id = (i === 0 ? 'Claude Code' : i % 3 ? 'Build the terminal ASCII dashboard renderer ' + i : 'Short ' + i) + '·p' + pi + 'a' + String(i).padStart(2, '0');
      ids.push(id);
      agents.push({ id, project: 'proj' + pi, project_id: 'p' + pi, role: 'general-purpose', status: STAT[(i + pi) % 5], model_label: i % 2 ? 'Haiku 5.5' : 'Sonnet 5.5', started_at: '2026-01-01T00:' + String(59 - i).padStart(2, '0') + ':00Z',
        usage: { input: 5, output: 90, cache_read: 5000, cache_write: 700 }, current_tool: null, ...(ran ? { ran_s: 45 + 61 * i, tok_per_min: 100 } : {}) });
    }
    projects.push({ id: 'p' + pi, name: names ? names[pi] : (pi ? 'project-' + pi : 'agent-orchestration-standard'), agents: ids, total: n, running: 1, stalled: 0, errored: 0, ran_s_total: 57600 + pi });
  });
  return { goal: { title: 'Test goal' }, agents, projects, cost: { by_model: {} }, collisions: [], alerts: [] };
}
function assertGraph(m, st, label) {
  assertNoTextOverlap(m, label);
  const n = st.agents.length;
  assert.equal(m.orbs.length, n, 'all agent orbs ' + label);
  assert.equal(m.hubs.length, st.projects.length, 'one hub per project ' + label);
  const fixed = [...m.orbs.map((o) => ({ x0: o.x, y0: o.y })), ...m.hubs.map((h) => ({ x0: h.x, y0: h.y })), { x0: m.centre.x, y0: m.centre.y }];
  const boxes = [...m.labels.map((l) => ({ x0: l.x0, y0: l.y0, w: l.w, h: l.h })), m.centreLabel, ...fixed.map((f) => ({ ...f, w: 1, h: 1 }))];
  for (const b of boxes) assert.ok(b.x0 >= 0 && b.y0 >= 2 && b.x0 + b.w <= m.cols && b.y0 + b.h <= m.rows - 1, `clipped ${label} ${JSON.stringify(b)}`);
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) assert.ok(!ov(boxes[i], boxes[j]), `overlap ${label}`);
  for (const h of m.hubs) { // hub labels exist as labels
    assert.ok(m.labels.some((l) => l.hub && l.id === 'hub:' + h.id), 'hub label ' + label);
  }
  for (const p of m.particles) assert.ok(!m.reserved.has(p.y * m.cols + p.x), 'particle on reserved ' + label);
  const d2 = (o, h) => (o.x - h.x) ** 2 + ((o.y - h.y) * 2) ** 2;
  for (const o of m.orbs) {
    const own = m.hubs.find((h) => h.id === o.hub);
    for (const h of m.hubs) if (h !== own) assert.ok(d2(o, own) < d2(o, h), `agent nearer its own hub ${label}`);
  }
}
const GRAPH_CASES = [[14], [21], [40], [12, 5], [5, 4, 3], [20, 3, 2, 8, 1, 4], [21, 1]];
let graphRing = 0, graphList = 0; const seenGraph = {};
for (const counts of GRAPH_CASES) for (const [c, r] of [[100, 30], [140, 40], [177, 91], [360, 91]]) {
  const st = pfix(counts);
  for (const frame of [0, 7]) {
    const m = renderModel(st, c, r, { frame });
    const label = `${counts.join('+')} @${c}x${r}`;
    assert.equal(m.plain.length, r);
    for (const l of m.plain) assert.ok([...l].length <= c, 'wide ' + label);
    if (m.mode === 'ring') { graphRing++; assertGraph(m, st, label); if (frame === 0) assert.ok(m.particles.length > 0, 'particles ' + label); }
    else {
      graphList++;
      const txt = m.plain.join('\n');
      assert.ok(m.plain[2] && /AGENT/.test(m.plain[2]));
      assert.ok(txt.includes('▸ ' + st.projects[0].name.slice(0, 10)), 'list project header ' + label);
    }
    if (frame === 0) seenGraph[label] = m.mode;
    // forced ring: always some ring, never text on text
    const f = renderModel(st, c, r, { view: 'ring', frame });
    assert.equal(f.mode, 'ring', 'forced ring ' + label);
    assertNoTextOverlap(f, 'forced ' + label);
  }
}
for (const k of ['14 @140x40', '21 @177x91', '14 @360x91', '21 @360x91', '40 @360x91', '12+5 @177x91', '5+4+3 @177x91', '5+4+3 @140x40', '21+1 @177x91', '20+3+2+8+1+4 @360x91']) assert.equal(seenGraph[k], 'ring', 'ring expected ' + k + ' ' + JSON.stringify(seenGraph));
assert.equal(seenGraph['40 @100x30'], 'list', 'too many for 100x30 falls back to list');
assert.equal(renderModel(pfix([21, 1]), 177, 60, { view: 'ring' }).mode, 'ring');
// label content
{
  const st = pfix([14, 3]); const m = renderModel(st, 177, 91);
  assert.equal(m.mode, 'ring');
  const txt = m.plain.join('\n');
  assert.ok(txt.includes('CLAUDE CODE · 5 SESSIONS') || txt.includes('CLAUDE CODE · 2 SESSIONS'), 'heart label');
  assert.ok(/\d+ running/.test(txt) && /14 agents · \d+ running/.test(txt) && /3 agents · \d+ running/.test(txt), 'hub labels');
  assert.ok(txt.includes('agent-orchestration-s'), 'hub name (truncated at 22)');
}
// no projects (old monitor / demo) -> flat ring, unchanged
for (const [c, r] of [[100, 30], [177, 91]]) { const m = renderModel(fixture(9), c, r); assert.equal(m.mode, 'ring'); assert.equal(m.hubs.length, 0); }
// agents missing from every project still render (one extra hub)
{ const st = pfix([5, 2]); st.agents.push({ id: 'Loose·zz', status: 'idle', model_label: 'x' }); const m = renderModel(st, 177, 91); assert.equal(m.mode, 'ring'); assert.equal(m.hubs.length, 3); assert.equal(m.orbs.length, 8); }
// stability: positions identical across refreshes, and a new agent never moves an existing node
for (const [counts, c, r] of [[[14], 177, 91], [[21, 1], 177, 91], [[5, 4, 3], 140, 40], [[12, 5], 360, 91]]) {
  const cache = { layouts: new Map(), fails: new Map() };
  const st = pfix(counts); const a = renderModel(st, c, r, { cache, frame: 0 });
  assert.equal(a.mode, 'ring');
  const b = renderModel(st, c, r, { cache, frame: 5 });
  assert.deepEqual(b.orbs.map((o) => [o.id, o.x, o.y]), a.orbs.map((o) => [o.id, o.x, o.y]), 'same cells on refresh');
  assert.deepEqual(b.labels.map((l) => [l.id, l.x0, l.y0, l.w, l.h]), a.labels.map((l) => [l.id, l.x0, l.y0, l.w, l.h]), 'same label boxes on refresh');
  // a new agent joins the first project
  const st2 = pfix(counts.map((n, i) => (i === 0 ? n + 1 : n)));
  st2.agents.forEach((ag) => { const old = st.agents.find((x) => x.id === ag.id); if (old) Object.assign(ag, { status: old.status, ran_s: old.ran_s + 60 }); });
  const m2 = renderModel(st2, c, r, { cache, frame: 9 });
  assert.equal(m2.mode, 'ring');
  assertGraph(m2, st2, `arrival ${counts} @${c}x${r}`);
  for (const o of a.orbs) { const q = m2.orbs.find((x) => x.id === o.id); assert.deepEqual([q.x, q.y], [o.x, o.y], 'existing orb keeps its cell'); }
  for (const l of a.labels) { const q = m2.labels.find((x) => x.id === l.id); assert.deepEqual([q.x0, q.y0, q.w, q.h], [l.x0, l.y0, l.w, l.h], 'existing label keeps its box'); }
  for (const h of a.hubs) { const q = m2.hubs.find((x) => x.id === h.id); assert.deepEqual([q.x, q.y], [h.x, h.y], 'hub keeps its cell'); }
  assert.equal(m2.orbs.length, a.orbs.length + 1);
  // and an agent leaving frees only its own cell
  const m3 = renderModel(st, c, r, { cache });
  for (const o of a.orbs) { const q = m3.orbs.find((x) => x.id === o.id); assert.deepEqual([q.x, q.y], [o.x, o.y]); }
}
// list grouping: project headers (state order), agents indented and sorted by start time, RAN and TOK/MIN kept
{
  const st = pfix([4, 2, 3]);
  const m = renderModel(st, 140, 40, { view: 'list' }); assert.equal(m.mode, 'list');
  const pl = m.plain; const hdrs = pl.filter((l) => l.includes('▸'));
  assert.equal(hdrs.length, 3);
  assert.ok(hdrs[0].includes('▸ agent-orchestration-standard · 4 agents · ') && hdrs[0].includes(' running · ran 16h'), hdrs[0]);
  assert.ok(hdrs[1].includes('▸ project-1 · 2 agents') && hdrs[2].includes('▸ project-2 · 3 agents'));
  assert.ok(/RAN/.test(pl[2]) && /TOK\/MIN/.test(pl[2]));
  const i0 = pl.findIndex((l) => l.includes('▸ agent-orchestration-standard'));
  assert.ok(/^   [●○◆■] /.test(pl[i0 + 1]) && pl[i0 + 1].startsWith('   '), 'agents indented: ' + pl[i0 + 1]);
  // started_at: later index = earlier start, so p0a03 comes first
  assert.ok(pl[i0 + 1].includes('p0a03') && pl[i0 + 4].includes('p0a00'), 'sorted by start time');
  assert.ok(/45s/.test(pl[i0 + 4]) && /100/.test(pl[i0 + 4]), 'ran + tok/min columns kept');
  for (const [c, r] of [[120, 30], [80, 24], [56, 12], [40, 10]]) for (const l of renderModel(st, c, r, { view: 'list' }).plain) assert.ok([...l].length <= c, 'list wide ' + c);
  assert.ok(/more \(enlarge/.test(renderModel(pfix([30, 5]), 100, 20, { view: 'list' }).plain.join('\n')));
}
// l override still three-state with projects; NO_COLOR/colour modes
{
  const st = pfix([14, 3]); let ui = initialUi({});
  assert.equal(renderModel(st, 177, 91, { view: ui.view }).mode, 'ring');
  ui = handleKey(ui, 'l').ui; assert.equal(renderModel(st, 177, 91, { view: ui.view }).mode, 'list');
  ui = handleKey(ui, 'l').ui; assert.equal(renderModel(st, 100, 20, { view: ui.view }).mode, 'ring');
  assert.ok(!/\x1b/.test(render(st, 177, 91, { color: 'none' })));
  assert.ok(/\x1b\[/.test(render(st, 177, 91, { color: 'true' })));
  const tiny = renderModel(pfix([30, 10]), 40, 12, { view: 'ring' }); assert.equal(tiny.mode, 'ring'); assertNoTextOverlap(tiny, 'tiny');
}
// ---- scaling: the graph spreads with the terminal (distances only; labels keep their size)
const cellSig = (m) => { const str = JSON.stringify([m.mode, m.labelMode, m.orbs.map((o) => [o.id, o.x, o.y]), m.labels.map((l) => [l.id, l.x0, l.y0, l.w, l.h]), m.hubs.map((h) => [h.id, h.x, h.y]), m.centre]); let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return m.mode + ':' + h.toString(16); };
// fixtures captured from the previous (unscaled) algorithm: at <= 100x30 nothing moves
const OLD_FIX = {"14@100x30":"list:3d5341d9","14@100x30f":"ring:e0b29b","14@90x28":"list:3d5341d9","14@90x28f":"ring:108f02e5","14@80x24":"list:3d5341d9","14@80x24f":"ring:b8cb9b73","21@100x30":"list:3d5341d9","21@100x30f":"ring:a2db2c3a","21@90x28":"list:3d5341d9","21@90x28f":"ring:fa8fe1f0","21@80x24":"list:3d5341d9","21@80x24f":"ring:13fe4ba3","40@100x30":"list:3d5341d9","40@100x30f":"ring:60235023","40@90x28":"list:3d5341d9","40@90x28f":"ring:58b0332f","40@80x24":"list:3d5341d9","40@80x24f":"ring:63a395ed","12+5@100x30":"ring:27540a62","12+5@100x30f":"ring:27540a62","12+5@90x28":"list:3d5341d9","12+5@90x28f":"ring:d978862a","12+5@80x24":"list:3d5341d9","12+5@80x24f":"ring:ec37190d","5+4+3@100x30":"ring:281c2912","5+4+3@100x30f":"ring:281c2912","5+4+3@90x28":"ring:8538bf99","5+4+3@90x28f":"ring:8538bf99","5+4+3@80x24":"ring:5c35565a","5+4+3@80x24f":"ring:5c35565a","20+3+2+8+1+4@100x30":"list:3d5341d9","20+3+2+8+1+4@100x30f":"ring:1cee5487","20+3+2+8+1+4@90x28":"list:3d5341d9","20+3+2+8+1+4@90x28f":"ring:c1d0584b","20+3+2+8+1+4@80x24":"list:3d5341d9","20+3+2+8+1+4@80x24f":"ring:2ce059fe","21+1@100x30":"list:3d5341d9","21+1@100x30f":"ring:99b7e87a","21+1@90x28":"list:3d5341d9","21+1@90x28f":"ring:cf89bc2b","21+1@80x24":"list:3d5341d9","21+1@80x24f":"ring:a3a08bc4"};
for (const [k, want] of Object.entries(OLD_FIX)) {
  const [cs, rest] = k.split('@'); const [c, r] = rest.replace('f', '').split('x').map(Number);
  assert.equal(cellSig(renderModel(pfix(cs.split('+').map(Number)), c, r, { view: rest.endsWith('f') ? 'ring' : 'auto' })), want, 'unchanged vs previous layout ' + k);
}
const drawnBox = (m) => { // bounding box of drawn content between header and footer
  let x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1;
  for (let y = 2; y < m.rows - 1; y++) [...m.plain[y]].forEach((ch, x) => { if (ch !== ' ') { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } });
  return { w: x1 - x0 + 1, h: y1 - y0 + 1, x0, x1, y0, y1 };
};
const SCALE_CASES = [[14], [21], [40], [12, 5], [5, 4, 3], [20, 3, 2, 8, 1, 4]];
let scaled = 0;
for (const counts of SCALE_CASES) for (const [c, r] of [[100, 30], [140, 40], [177, 91], [240, 60], [360, 91]]) {
  const st = pfix(counts); const label = `scale ${counts.join('+')} @${c}x${r}`;
  const m = renderModel(st, c, r, { frame: 3 });
  if (m.mode !== 'ring') continue;
  assertGraph(m, st, label);
  const b = drawnBox(m); const uw = c, uh = r - 3;
  if (c >= 177 && r >= 91) {
    scaled++;
    assert.ok(b.w >= 0.8 * uw && b.h >= 0.8 * uh, `fills >= 80% ${label}: ${(b.w / uw).toFixed(2)} x ${(b.h / uh).toFixed(2)}`);
    assert.ok(b.w <= uw && b.y0 >= 2 && b.y1 <= r - 2, 'inside usable area ' + label);
  }
  if (counts.length >= 2) assert.ok(Math.abs(m.centre.x - (c - 1) / 2) <= 0.06 * c && Math.abs(m.centre.y - (2 + (r - 2) / 2)) <= 0.06 * r, `heart near centre ${label}: ${m.centre.x},${m.centre.y}`);
  else if (c >= 177) assert.ok(Math.abs((b.x0 + b.x1) / 2 - (c - 1) / 2) <= 0.06 * c, 'single project composition centred ' + label);
  // label footprints never grow
  for (const l of m.labels) assert.ok(l.w <= 22 && l.h <= 4, 'label size unchanged ' + label);
}
assert.ok(scaled >= 10, 'scaled ring cases: ' + scaled);
// the same terminal and project set always yields the same layout, whatever the live status
{
  const a = pfix([21, 1]); const b = pfix([21, 1]); b.agents.forEach((x, i) => { x.status = STAT[(i + 2) % 5]; });
  assert.deepEqual(renderModel(a, 360, 91).orbs.map((o) => [o.id, o.x, o.y]), renderModel(b, 360, 91).orbs.map((o) => [o.id, o.x, o.y]), 'status does not move nodes');
}
// new agent arrival at 360x91 keeps every existing cell, and a resize re-lays out
for (const counts of [[21, 1], [14], [5, 4, 3]]) {
  const cache = { layouts: new Map(), fails: new Map() };
  const st = pfix(counts); const a = renderModel(st, 360, 91, { cache });
  const st2 = pfix(counts.map((n, i) => (i === 0 ? n + 2 : n)));
  const m2 = renderModel(st2, 360, 91, { cache }); assertGraph(m2, st2, 'arrival 360x91 ' + counts);
  for (const o of a.orbs) assert.deepEqual([m2.orbs.find((x) => x.id === o.id).x, m2.orbs.find((x) => x.id === o.id).y], [o.x, o.y], 'orb stays');
  for (const l of a.labels) { const q = m2.labels.find((x) => x.id === l.id); assert.deepEqual([q.x0, q.y0], [l.x0, l.y0], 'label stays'); }
  assert.deepEqual([m2.centre.x, m2.centre.y], [a.centre.x, a.centre.y], 'heart stays');
  const small = renderModel(st, 177, 91, { cache }); assert.notDeepEqual(small.orbs.map((o) => [o.x, o.y]), a.orbs.map((o) => [o.x, o.y]), 'resize re-lays out');
}

console.log(`graph: ${graphRing} ring, ${graphList} list`);

// terminal restore
_resetCleanup();
const w = []; const fakeStdin = { isTTY: true, raw: true, setRawMode(v) { this.raw = v; } };
assert.equal(cleanup({ write: (s) => w.push(s) }, fakeStdin), true);
assert.ok(w.join('').includes('\x1b[?25h') && w.join('').includes('\x1b[?1049l'));
assert.equal(fakeStdin.raw, false);
assert.equal(cleanup({ write: (s) => w.push(s) }, fakeStdin), false, 'idempotent');
// ---- requested vs served model marker
{
  const f = fixture(2); f.agents[1].model_mismatch = true; f.agents[1].requested_tier = 'haiku';
  const m = renderModel(f, 100, 30, { list: true });
  assert.ok(m.plain.join('\n').includes('!haiku'), 'list row shows the requested tier on a model mismatch');
  assert.ok(!renderModel(fixture(2), 100, 30, { list: true }).plain.join('\n').includes('!haiku'));
}

// empty state + PATH hint
{
  const w = renderModel({ agents: [] }, 80, 20, {});
  assert.equal(w.mode, 'waiting');
  assert.match(w.text, /Waiting for your first Claude Code session/);
  assert.match(w.text, /appears here/);
  const { pathHint } = await import('./dash.mjs');
  const { join, delimiter } = await import('node:path');
  const bin = join('/h', '.local', 'bin');
  assert.equal(pathHint({ PATH: '/usr/bin' }, '/h'), `${bin} is not on your PATH. Add this line to your shell profile (~/.zshrc or ~/.bashrc):\n  export PATH="$HOME/.local/bin:$PATH"`);
  assert.equal(pathHint({ PATH: ['/x', bin].join(delimiter) }, '/h'), '');
}
// ---- cross-machine: --machine filter, machines summary line, namespaced ids
{
  const { filterMachine, machinesLine } = await import('./dash.mjs');
  const f = fixture(2); f.agents[0].machine = 'local'; f.agents[1].machine = 'laptop2'; f.agents[1].id = 'laptop2:Claude Code·ab12';
  f.machines = [{ name: 'local', ok: true, totals: { agents: 1, tokens: 1500 } }, { name: 'laptop2', ok: true, totals: { agents: 1, tokens: 2500 } }, { name: 'dead', ok: false, error: 'timed out', totals: { agents: 0, tokens: 0 } }];
  assert.match(machinesLine(f), /^machines: local ● 1 agents 1\.5k tok · laptop2 ● 1 agents 2\.5k tok · dead ○ offline \(timed out\)$/);
  assert.equal(machinesLine(fixture(1)), '');
  assert.deepEqual(filterMachine(f, 'laptop2').agents.map((a) => a.machine), ['laptop2']);
  const all = renderModel(f, 140, 30, { list: true }).plain.join('\n'), one = renderModel(f, 140, 30, { list: true, machine: 'laptop2' }).plain.join('\n');
  assert.ok(all.includes('machines: local') && all.includes('dead ○ offline'), 'machines summary line in header');
  assert.ok(one.includes('1 agents'), 'filtered to one agent: ' + one.split('\n')[0]);
  assert.ok(isMainViaRender(f), 'namespaced remote Claude Code session still recognised as a main session');
}
// ---- reasoning effort beside the model, when the monitor knows it
{
  const f = fixture(3, 1, true); f.agents[0].effort = 'xhigh'; f.agents[1].effort = 'medium';
  const pl = renderModel(f, 140, 30, { list: true }).plain.join('\n');
  assert.ok(pl.includes('Sonnet 5.5 xhigh') && pl.includes('Sonnet 5.5 medium'), 'list shows model + effort');
  assert.ok(/Haiku 5\.5\s/.test(pl) && !pl.includes('Haiku 5.5 x'), 'no effort, no suffix');
  const ring = renderModel(f, 140, 40, { view: 'ring' });
  assert.ok(ring.plain.join('\n').includes('Sonnet 5.5 medium'), 'ring label shows model + effort');
  assertNoTextOverlap(ring, 'ring with effort');
  assert.equal(snapshotJson(f).agents[0].effort, 'xhigh'); assert.equal('effort' in snapshotJson(f).agents[3], false, '--json carries effort only when known');
}
// ---- done subagents: hidden by default; d / --done shows those that ended in the last 10 minutes
{
  const { filterDone } = await import('./dash.mjs');
  const now = Date.parse('2026-10-26T16:30:00Z'), ago = (m) => new Date(now - m * 60e3).toISOString();
  const f = fixture(3); f.server_time = new Date(now).toISOString();
  f.agents.push({ id: 'Recent·d001', status: 'done', ended_at: ago(3), usage: {} }, { id: 'Old·d002', status: 'done', ended_at: ago(25), usage: {} }, { id: 'NoEnd·d003', status: 'done', usage: {} });
  f.projects = [{ id: 'p', name: 'p', agents: f.agents.map((a) => a.id), total: f.agents.length }];
  const ids = (s) => s.agents.map((a) => a.id);
  const off = filterDone(f, false), on = filterDone(f, true);
  assert.ok(!ids(off).some((i) => /·d00/.test(i)) && off.done_hidden === 3, 'off: every done subagent hidden');
  assert.equal(ids(off).length, 4, 'off: sessions and running/idle/stalled/errored kept');
  assert.deepEqual(off.projects[0].agents, ids(off)); assert.equal(off.projects[0].total, 4, 'project list and total pruned');
  assert.ok(ids(on).includes('Recent·d001') && ids(on).includes('NoEnd·d003') && !ids(on).includes('Old·d002') && on.done_hidden === 1, 'on: only the last 10 minutes, no end time kept');
  assert.equal(f.agents.length, 7, 'input not mutated');
  let ui = initialUi({}); assert.equal(ui.showDone, false, 'hidden by default');
  const hidden = renderModel(f, 140, 30, { list: true, showDone: ui.showDone }).plain.join('\n');
  assert.ok(!hidden.includes('Recent') && hidden.includes('3 done hidden'), 'list hides them and says how many');
  assert.ok(hidden.includes('d done'), 'footer lists the d key');
  ui = handleKey(ui, 'd').ui; assert.equal(ui.showDone, true, 'd shows');
  const shown = renderModel(f, 140, 30, { list: true, showDone: ui.showDone }).plain.join('\n');
  assert.ok(shown.includes('Recent') && shown.includes('DONE') && !shown.includes('Old ') && shown.includes('done shown'), 'shown: recent done row with its status');
  const ringOn = renderModel(f, 140, 40, { view: 'ring', showDone: true }), ringOff = renderModel(f, 140, 40, { view: 'ring' });
  assert.equal(ringOn.orbs.length - ringOff.orbs.length, 2, 'ring draws the two shown done subagents, and leaves them out when hidden');
  assert.ok(ringOn.orbs.filter((o) => o.status === 'done').length === 2 && !ringOff.orbs.some((o) => o.status === 'done'), 'done orbs');
  assertNoTextOverlap(ringOn, 'ring with done shown');
  assert.equal(handleKey(ui, 'D').ui.showDone, false, 'D toggles back');
  assert.equal(initialUi({ done: true }).showDone, true, '--done starts shown');
}
function isMainViaRender(f) { return !renderModel(f, 140, 30, { list: true }).plain.join('\n').includes('laptop2:'); }
console.log(`ok (${ringCases} ring cases, ${listCases} list fallbacks)`);
