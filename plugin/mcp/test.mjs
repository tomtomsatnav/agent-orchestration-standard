import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), 'server.mjs');
let pass = 0, failN = 0;
const ok = (c, n) => { if (c) pass++; else { failN++; console.log('FAIL:', n); } };

const state = {
  goal: 'g', tasks: [{ id: 't1' }], mode: 'live', server_time: '2026-01-01T00:00:00Z', heartbeat: 1,
  events: Array.from({ length: 60 }, (_, i) => ({ i })), cost: { total_usd: 1.5 },
  collisions: [{ file: 'a.js', agents: ['a1', 'a2'] }], alerts: [{ severity: 'warn', message: 'stuck a2' }],
  agents: [
    { id: 'a1', role: 'lead', status: 'running', model: 'x', model_label: 'Opus', effort: 'xhigh', usage: { input: 10, output: 5, cache_read: 1000, cache_write: 20, usd_est: 0.5 }, current_tool: { name: 'Edit', summary: 'a.js', ts: 1 }, recent_tools: [{ name: 'Read' }], files: ['a.js'], stuck: false, stuck_for_s: 0,
      started_at: '2026-01-01T00:00:00.000Z', ended_at: null, ran_s: 725, tok_per_min: 4100 },
    { id: 'a2', role: 'dev', status: 'stalled', model: 'y', model_label: 'Sonnet', usage: { input: 1, output: 1, cache_read: 5, cache_write: 0, usd_est: null }, current_tool: null, recent_tools: [], files: [], stuck: true, stuck_for_s: 99 },
  ],
};
const seen = [];
let goalsOn = true;
const goalSum = { integrity: { status: 'warning', checked: true, kinds: { vacuous_pass: 2 } }, id: 'g-1', title: 'Goal one', status: 'active', repo_name: 'repo', plan_state: 'approved', paused_reason: null, resume_at: null, budget: { max_new_tokens: 1000, used_new_tokens: 10, max_wall_s: 3600, used_wall_s: 90, max_parallel: 3, running: 1, max_attempts: 3 }, tasks_total: 2, tasks_done: 1, tasks_failed: 0, approvals_pending: 1, workers: 1, outcome: { merged: 1, discarded: 0, tokens_per_accepted: 1500, cost_usd: 0.0123, waiting_s: 300, waiting_on: 'approval' } };
const fake = http.createServer((req, res) => {
  seen.push(req.url);
  res.setHeader('content-type', 'application/json');
  if (req.url.startsWith('/api/history')) return res.end(JSON.stringify({ first_ts: 'a', last_ts: 'b', count: 2, markers: [{ ts: 'a' }, { ts: 'b' }] }));
  if (req.url === '/api/goals' && goalsOn) return res.end(JSON.stringify({ goals: [goalSum] }));
  if (req.url === '/api/goals/g-1' && goalsOn) return res.end(JSON.stringify({ goal: { ...goalSum, description: 'desc', criteria: [{ id: 'c1', text: 'tests pass', met: false }], tasks: [{ id: 't1', title: 'T', status: 'running', phase: 'working', tier: 'haiku', depends_on: [], attempts: 1, max_attempts: 3, branch: 'aos/g-1/t1', ran_s: 65, new_tokens: 1234, check_summary: null, outcome: 'escalated', retries: 1, tier_path: ['haiku', 'sonnet'], cost_usd: 0.05, waiting_s: 120, waiting_for_human: true, integrity: { status: 'failed', reasons: ['tests_weakened', 'harness_tamper'] }, self_checks: 2, version_mismatch: true }], last_events: [{ type: 'task.started', ts: '2026-01-01T00:00:00Z', task_id: 't1', text: 'tier=haiku' }] } }));
  if (req.url.startsWith('/api/state')) return res.end(JSON.stringify(state));
  res.statusCode = 404; res.end('{}');
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const port = fake.address().port;

function client(env) {
  const p = spawn(process.execPath, [SERVER], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = []; let buf = ''; const waiters = new Map();
  p.stdout.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i); buf = buf.slice(i + 1); lines.push(l);
      try { const m = JSON.parse(l); if (m.id !== undefined && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); } } catch {}
    }
  });
  let n = 0;
  const call = (method, params) => new Promise((res, rej) => {
    const id = ++n; waiters.set(id, res);
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => rej(new Error('timeout ' + method)), 8000);
  });
  const exit = new Promise((r) => p.on('exit', (c) => r(c)));
  return { p, lines, call, exit, raw: (s) => p.stdin.write(s) };
}
const tool = (c, name, args) => c.call('tools/call', { name, arguments: args });
const txt = (r) => r.result?.content?.[0]?.text ?? '';

const c = client({ AOS_PORT: String(port < 1024 ? 4318 : port), AOS_HOST: 'evil.example' });
let r = await c.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
ok(r.result.protocolVersion === '2025-06-18', 'echo version');
ok(r.result.capabilities.tools && r.result.serverInfo.name, 'init shape');
c.raw(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
r = await c.call('initialize', { protocolVersion: '1999-01-01' });
ok(r.result.protocolVersion === '2025-11-25', 'fallback version');
ok(Object.keys((await c.call('ping')).result).length === 0, 'ping');
r = await c.call('tools/list');
const names = r.result.tools.map((t) => t.name).sort();
ok(names.join() === 'aos_agent,aos_alerts,aos_conflicts,aos_cost,aos_goals,aos_history,aos_state_at,aos_status', 'tool names');
ok(r.result.tools.every((t) => t.annotations.readOnlyHint === true && t.inputSchema.type === 'object'), 'annotations/schema');

r = await tool(c, 'aos_status', {});
ok(!r.result.isError && /agents: 2 \(running 1, idle 0, done 0, stalled 1\)/.test(txt(r)), 'status counts');
ok(/new 37 .*vs cache_read 1,005/.test(txt(r)), 'status tokens: ' + txt(r));
ok(/STUCK 99s/.test(txt(r)) && /conflicts: 1/.test(txt(r)) && /stuck a2/.test(txt(r)), 'status stuck/conflicts/alerts');
ok(/a1 \| lead \| running \| .*\| new_tok 35 \| ran 12m \| 4\.1k tok\/min$/m.test(txt(r)), 'status run part: ' + txt(r));
ok(/a2 \| dev \| stalled \| .*\| new_tok 2$/m.test(txt(r)), 'status: a2 line unchanged without run fields');
ok(/a1 \| lead \| running \| Opus xhigh \| tool:/m.test(txt(r)) && /a2 \| dev \| stalled \| Sonnet \| tool:/m.test(txt(r)), 'status: effort beside the model when known: ' + txt(r));
ok(!/events \(/.test(txt(r)), 'no events by default');
r = await tool(c, 'aos_status', { include_events: 50 });
ok(/events \(newest 50\)/.test(txt(r)), 'events 50');
r = await tool(c, 'aos_status', { include_events: 51 });
ok(r.error?.code === -32602, 'events >50 rejected');
r = await tool(c, 'aos_status', { include_events: 'x' });
ok(r.error?.code === -32602, 'events wrong type');
r = await tool(c, 'aos_status', { bogus: 1 });
ok(r.error?.code === -32602, 'unknown arg');
r = await tool(c, 'aos_agent', { id: 'a1' });
ok(/recent_tools/.test(txt(r)) && /a\.js/.test(txt(r)), 'agent detail');
ok(/timing: started_at 2026-01-01T00:00:00\.000Z, ended_at running, ran_s 725, tok_per_min 4100/.test(txt(r)), 'agent detail timing: ' + txt(r));
ok(/a1 \| lead \| running .*\| ran 12m \| 4\.1k tok\/min/.test(txt(r)), 'agent line run part');
r = await tool(c, 'aos_agent', { id: 'a2' });
ok(/timing: started_at n\/a, ended_at n\/a, ran_s n\/a, tok_per_min n\/a/.test(txt(r)), 'agent detail, older monitor fields absent');
r = await tool(c, 'aos_agent', { id: 'nope' });
ok(r.result.isError === true, 'unknown agent isError');
r = await tool(c, 'aos_agent', {});
ok(r.error?.code === -32602, 'agent missing id');
r = await tool(c, 'aos_cost', {});
ok(/new tokens: 37/.test(txt(r)) && /cache reads: 1,005/.test(txt(r)) && /\$0\.5/.test(txt(r)), 'cost');
ok(/a1 Opus xhigh: 35 \| 1,000 \| \$0\.5 \| ran 12m \| 4\.1k tok\/min/.test(txt(r)), 'cost per-agent run part: ' + txt(r));
ok(/a2 Sonnet: 2 \| 5 \| n\/a$/m.test(txt(r)), 'cost: older monitor line unchanged');
r = await tool(c, 'aos_conflicts', {});
ok(/conflicts: 1/.test(txt(r)) && /a\.js/.test(txt(r)), 'conflicts');
r = await tool(c, 'aos_alerts', {});
ok(/alerts: 1/.test(txt(r)), 'alerts');
r = await tool(c, 'aos_history', { limit: 5000 });
ok(r.error?.code === -32602, 'history limit out of range');
r = await tool(c, 'aos_history', { limit: 5 });
ok(/count: 2/.test(txt(r)) && seen.includes('/api/history?limit=5'), 'history');
r = await tool(c, 'aos_state_at', { at: '2026-01-01T00:00:00Z' });
ok(/replay at 2026-01-01T00:00:00.000Z/.test(txt(r)) && seen.some((u) => u.includes('?at=2026-01-01T00%3A00%3A00.000Z')), 'state_at');
r = await tool(c, 'aos_state_at', { at: '2026-99-99T00:00:00Z' });
ok(r.result?.isError === true, 'bad at isError');
// projects: grouped status, summary line, project filter, aos_agent project; monitors without projects unchanged (above)
state.projects = [{ id: 'proj-a', name: 'Alpha App', agents: ['a1'], total: 1, running: 1, ran_s_total: 57600 }, { id: 'proj-b', name: 'beta', agents: ['a2'], total: 1, running: 0, ran_s_total: 90 }];
state.agents[0].project = 'Alpha App'; state.agents[0].project_id = 'proj-a'; state.agents[1].project = 'beta'; state.agents[1].project_id = 'proj-b';
r = await tool(c, 'aos_status', {});
ok(/^projects: 2 \| Alpha App \(1 agent, 1 running, ran 16h 00m\); beta \(1 agent, 0 running, ran 1m\)$/m.test(txt(r)), 'projects line: ' + txt(r));
ok(/^project Alpha App: 1 agent\n  a1 \| lead/m.test(txt(r)) && /^project beta: 1 agent\n  a2 \| dev/m.test(txt(r)), 'agents grouped under project headings');
ok(/agents: 2 \(running 1, idle 0, done 0, stalled 1\)/.test(txt(r)), 'counts unchanged with projects');
r = await tool(c, 'aos_status', { project: 'beta' });
ok(!r.result.isError && /agents: 1 \(running 0/.test(txt(r)) && /a2 \| dev/.test(txt(r)) && !/a1 \| lead/.test(txt(r)) && /projects: 1 \| beta/.test(txt(r)), 'project filter by name: ' + txt(r));
r = await tool(c, 'aos_status', { project: 'PROJ-A' });
ok(/a1 \| lead/.test(txt(r)) && !/a2 \| dev/.test(txt(r)), 'project filter by id (case-insensitive)');
r = await tool(c, 'aos_status', { project: 'nope' });
ok(r.result.isError === true && /No project "nope"\. Known: Alpha App, beta/.test(txt(r)), 'unknown project isError');
r = await tool(c, 'aos_status', { project: 5 });
ok(r.error?.code === -32602, 'project must be a string');
r = await tool(c, 'aos_agent', { id: 'a1' });
ok(/^project: Alpha App$/m.test(txt(r)), 'aos_agent includes project');
delete state.projects; delete state.agents[0].project; delete state.agents[0].project_id; delete state.agents[1].project; delete state.agents[1].project_id;
r = await tool(c, 'aos_status', { project: 'x' });
ok(r.result.isError === true && /does not report projects/.test(txt(r)), 'filter on monitor without projects');
r = await tool(c, 'aos_agent', { id: 'a1' });
ok(!/^project:/m.test(txt(r)), 'no project line on older monitor');

// cross-machine
{
  const save = { m: state.machines, a: state.agents.map((x) => x.machine) };
  state.agents[0].machine = 'local'; state.agents[1].machine = 'laptop2';
  r = await tool(c, 'aos_status', {});
  ok(!/^machines:/m.test(txt(r)), 'no machines line without machines');
  state.machines = [{ name: 'local', ok: true, totals: { agents: 1, running: 1, tokens: 2000 } }, { name: 'laptop2', ok: false, error: 'timed out', totals: { agents: 1, running: 0, tokens: 5, cost_usd_est: 1.5 } }];
  r = await tool(c, 'aos_status', {});
  ok(/^machines: 2 \| local ok 1 agents, 1 running, 2,000 tok; laptop2 OFFLINE \(timed out\) 1 agents, 0 running, 5 tok, ~\$1\.50$/m.test(txt(r)), 'machines line: ' + txt(r));
  r = await tool(c, 'aos_status', { machine: 'LAPTOP2' });
  ok(/agents: 1 \(/.test(txt(r)) && /a2 \| dev/.test(txt(r)) && !/a1 \| lead/.test(txt(r)), 'machine filter: ' + txt(r));
  r = await tool(c, 'aos_status', { machine: 'nope' });
  ok(r.result.isError === true && /No machine "nope"\. Known: local, laptop2/.test(txt(r)), 'unknown machine');
  r = await tool(c, 'aos_status', { machine: 5 }); ok(r.error?.code === -32602, 'machine must be a string');
  r = await tool(c, 'aos_agent', { id: 'a2' }); ok(/^machine: laptop2$/m.test(txt(r)), 'agent machine line');
  state.machines = save.m; if (!save.m) delete state.machines; state.agents.forEach((x, i) => { if (save.a[i] === undefined) delete x.machine; });
}
r = await tool(c, 'aos_goals', {});
ok(!r.result.isError && /^goals: 1$/m.test(txt(r)) && /g-1 \| Goal one \| active \| repo repo \| plan approved \| tasks 1\/2 done, 0 failed \| running 1\/3 \| tokens 10\/1,000 \| wall 1m\/1h 00m \| approvals pending 1 \| workers 1 \| merged 1 discarded 0 \| 1,500 tok\/accepted \| cost \$0\.0123 \| waiting on you 5m \(approval\)/.test(txt(r)), 'goals list: ' + txt(r));
r = await tool(c, 'aos_goals', { id: 'g-1' });
ok(/criteria:\n  - \[ \] c1 tests pass/.test(txt(r)) && /t1 \| running\/working \| haiku \| attempt 1\/3 \| 1,234 tok \| ran 1m \| escalated 1 retry haiku>sonnet \| \$0\.0500 \| waiting on you 2m.*WAITING FOR HUMAN/.test(txt(r)) && /task\.started t1 tier=haiku/.test(txt(r)) && seen.includes('/api/goals/g-1'), 'goals detail: ' + txt(r));
ok(/integrity: failed \(tests_weakened,harness_tamper\) \| 2 self-checks \| claude version changed/.test(txt(r)) && /^g-1 .*integrity: warning \(vacuous_passx2\)/m.test(txt(r)), 'goals detail: integrity line');
r = await tool(c, 'aos_goals', { id: 'nope' });
ok(r.result.isError === true && /No goal with id "nope"\. Known: g-1/.test(txt(r)), 'goals unknown id');
for (const bad of ['../x', 'a/b', 'g 1', '', 'x'.repeat(65), '.hidden']) { r = await tool(c, 'aos_goals', { id: bad }); ok(r.error?.code === -32602, 'goals bad id ' + bad); }
r = await tool(c, 'aos_goals', { id: 5 }); ok(r.error?.code === -32602, 'goals id type');
r = await tool(c, 'aos_goals', { limit: 1 }); ok(r.error?.code === -32602, 'goals unknown arg');
goalsOn = false;
r = await tool(c, 'aos_goals', {}); ok(r.result.isError === true && /does not report goals/.test(txt(r)), 'goals: monitor without endpoint');
r = await tool(c, 'aos_goals', { id: 'g-1' }); ok(r.result.isError === true && /does not report goals/.test(txt(r)), 'goals detail: monitor without endpoint');
goalsOn = true;
r = await tool(c, 'nope', {});
ok(r.error?.code === -32602, 'unknown tool');
r = await c.call('bogus/method');
ok(r.error?.code === -32601, 'unknown method');
c.raw('not json\n');
await new Promise((r) => setTimeout(r, 200));
ok(c.lines.some((l) => JSON.parse(l).error?.code === -32700), 'parse error');
ok(c.lines.every((l) => { try { const m = JSON.parse(l); return m.jsonrpc === '2.0'; } catch { return false; } }), 'stdout only JSON-RPC');
c.p.stdin.end();
ok((await Promise.race([c.exit, new Promise((r) => setTimeout(() => r('hang'), 3000))])) === 0, 'clean exit on stdin close');

// monitor down
await new Promise((r) => fake.close(r));
const d = client({ AOS_PORT: String(port) });
await d.call('initialize', { protocolVersion: '2025-06-18' });
r = await tool(d, 'aos_status', {});
ok(r.result.isError === true && /not reachable on 127\.0\.0\.1:\d+: start it with node monitor\.mjs/.test(txt(r)), 'monitor down');
d.p.stdin.end(); await d.exit;
// invalid port falls back, still works
const e = client({ AOS_PORT: '80' });
await e.call('initialize', { protocolVersion: '2025-06-18' });
r = await tool(e, 'aos_alerts', {});
ok(/127\.0\.0\.1:4318/.test(txt(r)) || r.result.isError === false, 'invalid port -> 4318');
e.p.stdin.end(); await e.exit;

console.log(`PASS ${pass} FAIL ${failN}`);
process.exit(failN ? 1 : 0);
