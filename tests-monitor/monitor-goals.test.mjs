// Monitor goal view + hook tagging tests. Goal fixtures are golden goal dirs under fixtures/ (generated once from the real engine; see fixtures/README.md).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MONITOR = path.join(ROOT, 'monitor.mjs'), HOOK = path.join(ROOT, 'hooks', 'aos-hook.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aos-mongoals-')));
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

function req(port, method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers, agent: false }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, json: j, text: b }); });
    });
    r.on('error', reject); r.end(body);
  });
}
async function startMonitor({ orch, live }) {
  const port = await freePort();
  const p = spawn(process.execPath, [MONITOR], { env: { ...process.env, PORT: String(port), AOS_LIVE_DIR: live, AOS_ORCH_DIR: orch }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((res, rej) => { p.stdout.on('data', (d) => { if (String(d).includes('live monitor on')) res(); }); p.on('exit', () => rej(new Error('monitor exited'))); setTimeout(() => rej(new Error('monitor start timeout')), 8000); });
  return { port, p, stop: () => new Promise((r) => { p.on('exit', r); p.kill('SIGTERM'); setTimeout(() => p.kill('SIGKILL'), 1500).unref(); }), get: (u, o) => req(port, 'GET', u, o) };
}
const hookEv = (o) => JSON.stringify({ ts: new Date().toISOString(), ...o }) + '\n';

let ORCH, LIVE, M, WT;
before(async () => {
  ORCH = path.join(TMP, 'orch'); LIVE = path.join(TMP, 'live');
  fs.mkdirSync(path.join(ORCH, 'goals'), { recursive: true }); fs.mkdirSync(LIVE, { recursive: true });
  fs.cpSync(path.join(FIXTURES, 'all-success', 'goals', 'g-test'), path.join(ORCH, 'goals', 'g-test'), { recursive: true });
  // a pending approval for t2 (the shape the policy hook writes)
  const ad = path.join(ORCH, 'goals', 'g-test', 'approvals'); fs.mkdirSync(ad, { recursive: true });
  fs.writeFileSync(path.join(ad, 'A-1.json'), JSON.stringify({ id: 'A-1', goal_id: 'g-test', task_id: 't2', status: 'pending', tool: 'Bash', input: { command: 'rm -rf /Users/secret/x' } }));
  WT = '/fixture/repo.aos-worktrees/g-test/t1';
  M = await startMonitor({ orch: ORCH, live: LIVE });
});
after(async () => { try { await M.stop(); } catch {} fs.rmSync(TMP, { recursive: true, force: true }); });

const readAll = (j) => JSON.stringify(j);
function noPaths(txt, what) {
  assert.ok(!txt.includes('/Users/'), `${what}: contains /Users/`);
  assert.ok(!txt.includes(TMP) && !txt.includes('/fixture') && !txt.includes(os.tmpdir()), `${what}: contains temp dir`);
}

test('GET /api/goals: summary fields mapped from the golden engine files', async () => {
  const r = await M.get('/api/goals');
  assert.equal(r.status, 200);
  assert.equal(r.json.goals.length, 1);
  const g = r.json.goals[0];
  assert.equal(g.id, 'g-test'); assert.equal(g.title, 'Test goal'); assert.equal(g.status, 'achieved');
  assert.equal(g.repo_name, 'repo'); assert.match(g.created_at, /^\d{4}-/); assert.match(g.updated_at, /^\d{4}-/);
  assert.equal(g.plan_state, 'approved'); assert.equal(g.paused_reason, null); assert.equal(g.resume_at, null);
  assert.equal(g.tasks_total, 3); assert.equal(g.tasks_done, 3); assert.equal(g.tasks_failed, 0);
  assert.equal(g.approvals_pending, 1);
  assert.deepEqual(Object.keys(g.budget).sort(), ['max_attempts', 'max_new_tokens', 'max_parallel', 'max_wall_s', 'running', 'used_new_tokens', 'used_wall_s']);
  assert.equal(g.budget.max_wall_s, 3600); assert.equal(g.budget.max_parallel, 3); assert.equal(g.budget.max_attempts, 3);
  assert.equal(g.budget.max_new_tokens, 2000000); assert.ok(g.budget.used_new_tokens > 0); assert.equal(g.budget.running, 0);
  assert.ok(Number.isInteger(g.budget.used_wall_s) && g.budget.used_wall_s >= 0 && g.budget.used_wall_s < 3600);
  assert.equal(g.workers, 0);
  noPaths(readAll(r.json), 'list');
});

test('GET /api/goals/:id: detail fields', async () => {
  const r = await M.get('/api/goals/g-test');
  assert.equal(r.status, 200);
  const d = r.json.goal;
  assert.deepEqual(Object.keys(r.json), ['goal']);   // UI (orch.js pollDetail) reads j.goal
  assert.equal(d.id, 'g-test'); assert.equal(d.description, '');
  assert.deepEqual(d.criteria, [{ id: 'c1', text: 'a, b and c present', met: true }]);
  assert.deepEqual(d.tasks.map((t) => t.id), ['t1', 't2', 't3']);
  for (const t of d.tasks) {
    assert.deepEqual(Object.keys(t).sort(), ['attempt_log', 'attempts', 'branch', 'check_summary', 'cost_usd', 'depends_on', 'id', 'integrity', 'max_attempts', 'new_tokens', 'out_of_scope', 'outcome', 'phase', 'ran_s', 'rerun', 'retries', 'scope_violations', 'self_checks', 'status', 'tier', 'tier_path', 'title', 'version_mismatch', 'waiting_for_human', 'waiting_s'].sort());
    assert.equal(t.status, 'done'); assert.equal(t.tier, 'haiku'); assert.equal(t.attempts, 1); assert.equal(t.branch, `aos/g-test/${t.id}`);
    assert.equal(t.phase, null); assert.equal(t.check_summary, 'checks passed'); assert.ok(t.new_tokens > 0); assert.ok(Number.isInteger(t.ran_s) && t.ran_s >= 0);
  }
  assert.deepEqual(d.tasks[2].depends_on, ['t1', 't2']);
  assert.equal(d.tasks.find((t) => t.id === 't2').waiting_for_human, true);   // pending approval A-1
  assert.equal(d.tasks.find((t) => t.id === 't1').waiting_for_human, false);
  assert.ok(d.last_events.length > 0 && d.last_events.length <= 25);
  for (const e of d.last_events) { assert.deepEqual(Object.keys(e).sort(), ['task_id', 'text', 'ts', 'type']); assert.equal(typeof e.type, 'string'); assert.ok(e.text.length <= 160); }
  assert.ok(d.last_events.some((e) => e.type === 'orch.integrate.merged'));
  assert.ok(d.last_events.every((e, i, a) => !i || a[i - 1].ts <= e.ts));
  noPaths(readAll(d), 'detail');
  // /api/state carries the same summaries
  const s = await M.get('/api/state');
  assert.equal(s.json.goals.length, 1); assert.equal(s.json.goals[0].id, 'g-test'); assert.equal(s.json.goal_detail, undefined);
  noPaths(s.text, 'state');
});

test('read-only guarantees: Host/Origin 403, mutating methods 405, bad ids', async () => {
  for (const p of ['/api/goals', '/api/goals/g-test']) {
    assert.equal((await M.get(p, { headers: { Host: 'evil.example' } })).status, 403);
    assert.equal((await M.get(p, { headers: { Origin: 'http://evil.example' } })).status, 403);
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal((await req(M.port, m, p, { body: '{}' })).status, 405, `${m} ${p}`);
  }
  assert.equal((await M.get('/api/goals/nope')).status, 404);
  assert.equal((await M.get('/api/goals/..%2f..%2fetc')).status, 404);
  assert.equal((await M.get('/api/goals/%00')).status, 404);
  assert.equal((await M.get('/api/goals/%E0%A4%A')).status, 400);
  assert.equal((await M.get('/api/goals/g-test/extra')).status, 404);
  assert.equal((await M.get('/api/goals/g-test', { headers: { Origin: 'http://localhost:1234' } })).status, 200);
});

test('partial / corrupt files: skipped or tolerated, never a crash', async () => {
  const G = (n) => path.join(ORCH, 'goals', n);
  const good = JSON.parse(fs.readFileSync(path.join(G('g-test'), 'goal.json'), 'utf8'));
  fs.mkdirSync(G('g-corrupt')); fs.writeFileSync(path.join(G('g-corrupt'), 'goal.json'), '{"id":"g-corrupt","ti');           // partial write
  fs.mkdirSync(G('g-arr')); fs.writeFileSync(path.join(G('g-arr'), 'goal.json'), '[1,2]');
  fs.mkdirSync(G('g-notasks')); fs.writeFileSync(path.join(G('g-notasks'), 'goal.json'), JSON.stringify({ ...good, id: 'g-notasks', title: 'No tasks file', status: 'draft' }));
  fs.mkdirSync(G('g-badtasks')); fs.writeFileSync(path.join(G('g-badtasks'), 'goal.json'), JSON.stringify({ ...good, id: 'g-badtasks', title: 'Bad tasks' }));
  fs.writeFileSync(path.join(G('g-badtasks'), 'tasks.json'), '[{"id":"t1","sta');
  fs.mkdirSync(G('g-evt')); fs.writeFileSync(path.join(G('g-evt'), 'goal.json'), JSON.stringify({ ...good, id: 'g-evt', title: 'Events partial' }));
  fs.writeFileSync(path.join(G('g-evt'), 'events.ndjson'), '{"seq":1,"type":"goal.created","ts":"2026-01-01T00:00:00Z","data":{}}\nnot json\n{"seq":2,"type":"task.started","ts":"2026-01-01T00:00:01Z","task_id":"t1","data":{"tier":"haiku"}}\n{"seq":3,"ty');
  fs.mkdirSync(path.join(ORCH, 'goals', 'not a goal!')); fs.mkdirSync(G('g-empty'));
  fs.writeFileSync(path.join(ORCH, 'goals', 'stray-file.txt'), 'x');
  await sleep(1150);
  const r = await M.get('/api/goals');
  assert.equal(r.status, 200);
  const ids = r.json.goals.map((g) => g.id).sort();
  assert.deepEqual(ids, ['g-badtasks', 'g-evt', 'g-notasks', 'g-test']);
  assert.equal(r.json.goals.find((g) => g.id === 'g-notasks').tasks_total, 0);
  assert.equal(r.json.goals.find((g) => g.id === 'g-badtasks').tasks_total, 0);
  const ev = (await M.get('/api/goals/g-evt')).json.goal.last_events;
  assert.deepEqual(ev.map((e) => e.type), ['goal.created', 'task.started']);
  assert.equal(ev[1].text, 'tier=haiku'); assert.equal(ev[1].task_id, 't1');
  // a partial rewrite of a previously good file keeps the last good data; recovery is picked up
  const f = path.join(G('g-test'), 'tasks.json'), keep = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(f, keep.slice(0, 40)); await sleep(1150);
  assert.equal((await M.get('/api/goals/g-test')).json.goal.tasks.length, 3);
  fs.writeFileSync(f, keep); await sleep(1150);
  assert.equal((await M.get('/api/goals/g-test')).json.goal.tasks_total, 3);
  assert.equal((await M.get('/api/state')).status, 200);
  for (const n of ['g-corrupt', 'g-arr', 'g-notasks', 'g-badtasks', 'g-evt', 'g-empty', 'not a goal!']) fs.rmSync(path.join(ORCH, 'goals', n), { recursive: true, force: true });
  fs.rmSync(path.join(ORCH, 'goals', 'stray-file.txt'));
  await sleep(1150);
});

test('missing orch dir = empty list', async () => {
  const live = path.join(TMP, 'live-empty'); fs.mkdirSync(live);
  const m = await startMonitor({ orch: path.join(TMP, 'does-not-exist'), live });
  try {
    assert.deepEqual((await m.get('/api/goals')).json, { goals: [] });
    assert.deepEqual((await m.get('/api/state')).json.goals, []);
    assert.equal((await m.get('/api/goals/g-x')).status, 404);
  } finally { await m.stop(); }
});

test('100 goals: list capped at 50 (newest), state.goals at 20; memory stays bounded with huge event logs', async () => {
  const orch = path.join(TMP, 'orch100'), live = path.join(TMP, 'live100');
  fs.mkdirSync(path.join(orch, 'goals'), { recursive: true }); fs.mkdirSync(live);
  const good = JSON.parse(fs.readFileSync(path.join(ORCH, 'goals', 'g-test', 'goal.json'), 'utf8'));
  const tasks = fs.readFileSync(path.join(ORCH, 'goals', 'g-test', 'tasks.json'), 'utf8');
  const base = Date.now() - 200 * 1000;
  for (let i = 0; i < 100; i++) {
    const d = path.join(orch, 'goals', 'g-' + String(i).padStart(3, '0')); fs.mkdirSync(d);
    const ts = new Date(base + i * 1000).toISOString();
    fs.writeFileSync(path.join(d, 'goal.json'), JSON.stringify({ ...good, id: 'g-' + String(i).padStart(3, '0'), title: 'Goal ' + i, updated_at: ts }));
    fs.writeFileSync(path.join(d, 'tasks.json'), tasks);
    const t = new Date(base + i * 1000);
    fs.utimesSync(path.join(d, 'goal.json'), t, t);
  }
  // one newest goal with a 20 MB event log
  const big = path.join(orch, 'goals', 'g-099');
  const line = JSON.stringify({ seq: 1, type: 'task.progress', ts: new Date().toISOString(), task_id: 't1', data: { msg: 'x'.repeat(200) } }) + '\n';
  fs.writeFileSync(path.join(big, 'events.ndjson'), line.repeat(Math.ceil(20e6 / line.length)));
  const m = await startMonitor({ orch, live });
  try {
    const rss = () => process.platform === 'win32'
      ? Number(execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${m.p.pid}).WorkingSet64`]).toString()) / 1048576
      : Number(execFileSync('ps', ['-o', 'rss=', '-p', String(m.p.pid)]).toString()) / 1024;
    const l = (await m.get('/api/goals')).json.goals;
    assert.equal(l.length, 50);
    assert.equal(l[0].id, 'g-099'); assert.equal(l[49].id, 'g-050');
    assert.equal((await m.get('/api/state')).json.goals.length, 20);
    assert.equal((await m.get('/api/goals/g-000')).status, 404);       // beyond the cap
    const before = rss();
    for (let i = 0; i < 60; i++) { const d = (await m.get('/api/goals/g-099')).json.goal; assert.equal(d.last_events.length, 25); await m.get('/api/state'); }
    const after = rss();   // read once: the messages are built eagerly, and each read spawns a process
    assert.ok(after - before < 150, `rss grew ${after - before} MB`);
    assert.ok(after < 400, `rss ${after} MB`);
  } finally { await m.stop(); }
});

test('worker tagging: tagged agents get goal_id/task_id/goal_title and the goal repo as project; untagged unchanged', async () => {
  const now = Date.now(), at = (ms) => new Date(now + ms).toISOString();
  const other = path.join(TMP, 'proj-other'); fs.mkdirSync(path.join(other, '.git'), { recursive: true });
  const L = [];
  // tagged worker session in the worktree of the goal's repo (+ one tagged subagent)
  L.push(hookEv({ ts: at(-9000), ev: 'SessionStart', sid: 'wrk1aaaa', cwd: 't1', cwdp: WT, gid: 'g-test', tid: 't1' }));
  L.push(hookEv({ ts: at(-8000), ev: 'UserPromptSubmit', sid: 'wrk1aaaa', cwd: 't1', cwdp: WT, gid: 'g-test', tid: 't1' }));
  L.push(hookEv({ ts: at(-7000), ev: 'PreToolUse', sid: 'wrk1aaaa', cwd: 't1', cwdp: WT, tool: 'Read', gid: 'g-test', tid: 't1' }));
  L.push(hookEv({ ts: at(-6000), ev: 'SubagentStart', sid: 'wrk1aaaa', agent_id: 'sub1', agent_type: 'helper', cwd: 't1', cwdp: WT, gid: 'g-test', tid: 't1' }));
  // untagged session elsewhere
  L.push(hookEv({ ts: at(-9000), ev: 'SessionStart', sid: 'user1aaa', cwd: 'proj-other', cwdp: other }));
  L.push(hookEv({ ts: at(-5000), ev: 'UserPromptSubmit', sid: 'user1aaa', cwd: 'proj-other', cwdp: other }));
  // tagged for a goal that is unknown to the monitor: tagged, but project falls back to the worktree derivation
  L.push(hookEv({ ts: at(-5000), ev: 'UserPromptSubmit', sid: 'ghost1aa', cwd: 'zz', cwdp: path.join(TMP, 'ghost-repo.aos-worktrees', 'zz'), gid: 'g-unknown', tid: 't9' }));
  fs.appendFileSync(path.join(LIVE, 'hook-events.ndjson'), L.join(''));
  await sleep(1150);
  const s = (await M.get('/api/state')).json;
  const wk = s.agents.filter((a) => a.goal_id === 'g-test');
  assert.equal(wk.length, 2);
  for (const a of wk) { assert.equal(a.task_id, 't1'); assert.equal(a.goal_title, 'Test goal'); assert.equal(a.project, 'repo'); }
  const user = s.agents.find((a) => a.id.endsWith('user'));
  assert.ok(user && user.goal_id === undefined && user.task_id === undefined && user.goal_title === undefined);
  assert.equal(user.project, path.basename(os.homedir()));   // temp dirs are generic: unchanged derivation falls back to home
  const ghost = s.agents.find((a) => a.goal_id === 'g-unknown');
  assert.ok(ghost && ghost.task_id === 't9' && ghost.goal_title === undefined && ghost.project === path.basename(os.homedir()));
  const names = s.projects.map((p) => p.name);
  assert.ok(names.includes('repo') && names.includes(user.project));
  assert.ok(!names.includes('t1') && !names.includes('g-test'), 'no hub for the worker worktree: ' + names);
  assert.equal(s.projects.find((p) => p.name === 'repo').total, 2);
  // workers count on the goal summary, both in state and the endpoints
  assert.equal(s.goals.find((g) => g.id === 'g-test').workers, wk.filter((a) => a.status === 'running').length);
  assert.ok(s.goals.find((g) => g.id === 'g-test').workers >= 1);
  assert.equal((await M.get('/api/goals')).json.goals[0].workers, s.goals[0].workers);
  assert.equal((await M.get('/api/goals/g-test')).json.goal.workers, s.goals[0].workers);
  noPaths(JSON.stringify(s), 'tagged state');
  // replay: goals omitted, tags still derived from the events
  const rp = (await M.get('/api/state?at=' + encodeURIComponent(new Date(Date.now()).toISOString()))).json;
  assert.equal(rp.replay, true); assert.equal(rp.goals, undefined);
  assert.ok(rp.agents.some((a) => a.goal_id === 'g-test' && a.project === 'repo'));
});

function runHook(env, payload, live) {
  return spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payload), env: { PATH: process.env.PATH, AOS_LIVE_DIR: live, ...env }, encoding: 'utf8' });
}
test('hook: gid/tid recorded only when valid; nothing else from the environment; permissions kept', () => {
  const live = path.join(TMP, 'hook-live');
  const read = () => fs.readFileSync(path.join(live, 'hook-events.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const p = { hook_event_name: 'PreToolUse', session_id: 'abcdef123456', cwd: '/tmp/x/wt', tool_name: 'Bash', tool_input: { command: 'ls -la secret-arg' } };
  const SECRET = 'sk-ENVSECRET1234567890abcdef';
  assert.equal(runHook({ AOS_GOAL_ID: 'g-20261020-tests', AOS_TASK_ID: 't2', AWS_SECRET: SECRET, AOS_CONTROL_TOKEN: SECRET, AOS_APPROVALS_DIR: '/Users/x/approvals' }, p, live).status, 0);
  runHook({ AOS_GOAL_ID: 'g.1_x-2', AOS_TASK_ID: 'a'.repeat(65) }, p, live);
  runHook({ AOS_GOAL_ID: 'bad id', AOS_TASK_ID: '../etc' }, p, live);
  runHook({ AOS_GOAL_ID: '', AOS_TASK_ID: 't\n1' }, p, live);
  runHook({}, p, live);
  runHook({ AOS_GOAL_ID: 'g-only' }, p, live);
  const r = read();
  assert.equal(r.length, 6);
  assert.equal(r[0].gid, 'g-20261020-tests'); assert.equal(r[0].tid, 't2');
  assert.equal(r[1].gid, 'g.1_x-2'); assert.equal(r[1].tid, undefined);
  assert.equal(r[2].gid, undefined); assert.equal(r[2].tid, undefined);
  assert.equal(r[3].gid, undefined); assert.equal(r[3].tid, undefined);
  assert.equal(r[4].gid, undefined); assert.equal(r[4].tid, undefined);
  assert.equal(r[5].gid, 'g-only'); assert.equal(r[5].tid, undefined);
  const raw = fs.readFileSync(path.join(live, 'hook-events.ndjson'), 'utf8');
  assert.ok(!raw.includes(SECRET) && !raw.includes('/Users/x/approvals') && !raw.includes('secret-arg') && !raw.includes('ls -la'));
  assert.equal(r[0].sum, 'ls');
  assert.deepEqual(Object.keys(r[0]).sort(), ['cwd', 'cwdp', 'ev', 'gid', 'sid', 'sum', 'tid', 'tool', 'ts']);
  // Windows has no POSIX mode bits: Node reports 0o666 for files and 0o777 for directories whatever was requested.
  // The hook still requests 0o600 / 0o700; POSIX checks that here.
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(live, 'hook-events.ndjson')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(live).mode & 0o777, 0o700);
  }
});
