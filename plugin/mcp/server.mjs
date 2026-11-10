#!/usr/bin/env node
// AOS monitor MCP server: zero-dependency, READ-ONLY, stdio (newline-delimited JSON-RPC 2.0).
// Only ever talks to http://127.0.0.1:<AOS_PORT||4318>. Never logs to stdout.
import { createInterface } from 'node:readline';

const SUPPORTED = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'aos-monitor', version: '0.1.0' };
const TIMEOUT_MS = 2000;
const MAX_BODY = 8 * 1024 * 1024;

function resolvePort() {
  const raw = process.env.AOS_PORT;
  if (raw === undefined || raw === '') return 4318;
  const n = Number(raw);
  if (/^\d+$/.test(String(raw).trim()) && n >= 1024 && n <= 65535) return n;
  process.stderr.write(`aos-mcp: ignoring invalid AOS_PORT=${JSON.stringify(raw)}; using 4318\n`);
  return 4318;
}
const PORT = resolvePort();
const log = (...a) => process.stderr.write('aos-mcp: ' + a.join(' ') + '\n');

class ToolError extends Error {}

async function api(path) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
      signal: ctl.signal, redirect: 'error', headers: { accept: 'application/json' },
    });
    const text = await res.text();
    if (text.length > MAX_BODY) throw new ToolError('AOS monitor response too large');
    if (!res.ok) throw new ToolError(`AOS monitor returned HTTP ${res.status} for ${path.split('?')[0]}`);
    try { return JSON.parse(text); } catch { throw new ToolError('AOS monitor returned invalid JSON'); }
  } catch (e) {
    if (e instanceof ToolError) throw e;
    throw new ToolError(
      `AOS monitor not reachable on 127.0.0.1:${PORT}: start it with node monitor.mjs, or open a new Claude Code session if the plugin autostart is enabled` +
      (e?.name === 'AbortError' ? ' (timed out after 2s)' : ''));
  } finally { clearTimeout(timer); }
}

// ---------- formatting helpers ----------
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);
const clampInt = (v, lo, hi, def) => {
  if (v === undefined || v === null) return def;
  return Math.min(hi, Math.max(lo, Math.trunc(v)));
};
const trunc = (s, n = 160) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const tools_ = (a) => (a && Array.isArray(a)) ? a : [];
const newTokens = (u = {}) => num(u.input) + num(u.output) + num(u.cache_write);
const fmt = (n) => Number(n).toLocaleString('en-US');
const hasNum = (v) => typeof v === 'number' && Number.isFinite(v);
// run time: 45s, 12m, 1h 05m; tokens per minute: 950, 4.1k, 1.2M
const durStr = (s) => { if (!hasNum(s) || s < 0) return null; s = Math.round(s); if (s < 60) return s + 's'; const m = Math.floor(s / 60); return m < 60 ? m + 'm' : Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm'; };
const tpmStr = (n) => { if (!hasNum(n)) return null; return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n)); };
// monitor fields from an older monitor are absent: returns '' so the line is unchanged
const runPart = (a) => { const r = durStr(a.ran_s), t = tpmStr(a.tok_per_min); return (r ? ` | ran ${r}` : '') + (t ? ` | ${t} tok/min` : ''); };

const usd = (v) => '$' + Number(v).toFixed(v < 1 ? 4 : 2);
const goalOutcome = (o) => (o && typeof o === 'object' ? ` | merged ${num(o.merged)} discarded ${num(o.discarded)}${hasNum(o.tokens_per_accepted) ? ' | ' + fmt(o.tokens_per_accepted) + ' tok/accepted' : ''}${hasNum(o.cost_usd) ? ' | cost ' + usd(o.cost_usd) : ''}${hasNum(o.waiting_s) ? ` | waiting on you ${durStr(o.waiting_s)}${o.waiting_on ? ' (' + trunc(o.waiting_on, 20) + ')' : ''}` : ''}` : '');
const taskOutcome = (t) => (typeof t.outcome === 'string' ? ` | ${trunc(t.outcome, 20)}${num(t.retries) ? ' ' + num(t.retries) + ' retr' + (num(t.retries) === 1 ? 'y' : 'ies') : ''}${tools_(t.tier_path).length > 1 ? ' ' + tools_(t.tier_path).slice(0, 6).map((x) => trunc(x, 12)).join('>') : ''}${hasNum(t.cost_usd) ? ' | ' + usd(t.cost_usd) : ''}${hasNum(t.waiting_s) ? ' | waiting on you ' + durStr(t.waiting_s) : ''}` : '');
const integrityStr = (i) => { if (!i || typeof i !== 'object' || !i.checked) return ''; const k = Object.entries(i.kinds && typeof i.kinds === 'object' ? i.kinds : {}).slice(0, 6).map(([n, c]) => `${trunc(n, 40)}${num(c) > 1 ? 'x' + num(c) : ''}`).join(','); return ` | integrity: ${trunc(i.status, 10)}${k ? ' (' + k + ')' : ''}`; };
const goalLine = (g) => { const b = g.budget || {}; return `${trunc(g.id, 64)} | ${trunc(g.title, 80)} | ${trunc(g.status, 20)} | repo ${trunc(g.repo_name, 60) || 'n/a'} | plan ${g.plan_state ?? 'none'} | tasks ${num(g.tasks_done)}/${num(g.tasks_total)} done, ${num(g.tasks_failed)} failed | running ${num(b.running)}/${num(b.max_parallel)} | tokens ${fmt(num(b.used_new_tokens))}/${fmt(num(b.max_new_tokens))} | wall ${durStr(b.used_wall_s) ?? 'n/a'}/${durStr(b.max_wall_s) ?? 'n/a'} | approvals pending ${num(g.approvals_pending)}${hasNum(g.workers) ? ' | workers ' + g.workers : ''}${goalOutcome(g.outcome)}${integrityStr(g.integrity)}`; };
function toolStr(t) {
  if (!t) return '-';
  return `${t.name ?? '?'}${t.summary ? ' ' + trunc(t.summary, 80) : ''}`;
}
function agentLine(a) {
  const u = a.usage || {};
  return `${a.id} | ${a.role ?? '?'} | ${a.status ?? '?'} | ${a.model_label ?? a.model ?? '?'}${a.effort ? ' ' + a.effort : ''} | tool: ${toolStr(a.current_tool)}` +
    (a.stuck ? ` | STUCK ${num(a.stuck_for_s)}s` : '') + ` | new_tok ${fmt(newTokens(u))}` + runPart(a);
}
// projects (newer monitors): state.projects = [{id,name,agents:[ids],running,ran_s_total}]; absent on older monitors
const projectsOf = (s) => tools_(s.projects).filter((p) => p && typeof p === 'object');
const projName = (s, a) => a.project ?? projectsOf(s).find((p) => tools_(p.agents).includes(a.id) || p.id === a.project_id)?.name ?? null;
const projCount = (n) => `${n} agent${n === 1 ? '' : 's'}`;
function projLine(p, ags) {
  const run = ags.filter((a) => a.status === 'running').length;
  return `${p.name ?? p.id} (${projCount(ags.length)}, ${run} running${durStr(p.ran_s_total) ? ', ran ' + durStr(p.ran_s_total) : ''})`;
}
function totals(agents) {
  const t = { input: 0, output: 0, cache_write: 0, cache_read: 0, usd: 0, usdKnown: false };
  for (const a of agents) {
    const u = a.usage || {};
    t.input += num(u.input); t.output += num(u.output);
    t.cache_write += num(u.cache_write); t.cache_read += num(u.cache_read);
    if (typeof u.usd_est === 'number') { t.usd += u.usd_est; t.usdKnown = true; }
  }
  t.new = t.input + t.output + t.cache_write;
  return t;
}
function itemText(x) {
  if (x == null) return '';
  if (typeof x === 'string') return trunc(x, 200);
  const keys = ['severity', 'level', 'kind', 'type', 'agent', 'agents', 'file', 'path', 'message', 'msg', 'text', 'ts'];
  const o = {};
  for (const k of keys) if (x[k] !== undefined) o[k] = x[k];
  return trunc(JSON.stringify(Object.keys(o).length ? o : x), 240);
}
function listItems(arr, max = 10) {
  arr = tools_(arr);
  if (!arr.length) return ['  none'];
  const out = arr.slice(-max).map((x) => '  - ' + itemText(x));
  if (arr.length > max) out.unshift(`  (showing newest ${max} of ${arr.length})`);
  return out;
}
function conflictsOf(s) {
  const c = s.collisions;
  if (Array.isArray(c)) return c;
  if (c && typeof c === 'object') return Object.entries(c).map(([k, v]) => ({ file: k, agents: v }));
  return [];
}
const machinesOf = (s) => tools_(s.machines).filter((m) => m && typeof m === 'object' && typeof m.name === 'string');
const machLine = (m) => `${trunc(m.name, 32)} ${m.ok ? 'ok' : 'OFFLINE' + (m.error ? ' (' + trunc(String(m.error), 80) + ')' : '')}` + (m.totals ? ` ${num(m.totals.agents)} agents, ${num(m.totals.running)} running, ${fmt(num(m.totals.tokens))} tok` + (hasNum(m.totals.cost_usd_est) ? `, ~$${m.totals.cost_usd_est.toFixed(2)}` : '') : '');
function summarize(s, includeEvents = 0, project = null, machine = null) {
  const projs = projectsOf(s), machs = machinesOf(s);
  let agents = tools_(s.agents); const tasks = tools_(s.tasks);
  if (machine != null) {
    const q = String(machine).toLowerCase(), hit = machs.find((m) => m.name.toLowerCase() === q);
    if (!hit) throw new ToolError(`No machine ${JSON.stringify(machine)}. Known: ${machs.map((m) => m.name).join(', ') || 'none (this monitor does not report machines)'}`);
    agents = agents.filter((a) => String(a.machine ?? 'local').toLowerCase() === q);
  }
  if (project != null) {
    const q = String(project).toLowerCase();
    const hit = projs.filter((p) => String(p.id).toLowerCase() === q || String(p.name).toLowerCase() === q);
    if (!hit.length) throw new ToolError(`No project ${JSON.stringify(project)}. Known: ${projs.map((p) => p.name ?? p.id).slice(0, 20).join(', ') || 'none (this monitor does not report projects)'}`);
    const ids = new Set(hit.flatMap((p) => tools_(p.agents)));
    agents = agents.filter((a) => ids.has(a.id) || hit.some((p) => p.id === a.project_id));
  }
  const counts = { running: 0, idle: 0, done: 0, stalled: 0 };
  for (const a of agents) if (a.status in counts) counts[a.status]++;
  const t = totals(agents);
  const L = [];
  L.push(`mode: ${s.mode ?? '?'} | server_time: ${s.server_time ?? '?'}` + (s.goal ? ` | goal: ${trunc(typeof s.goal === 'string' ? s.goal : JSON.stringify(s.goal), 200)}` : ''));
  L.push(`agents: ${agents.length} (running ${counts.running}, idle ${counts.idle}, done ${counts.done}, stalled ${counts.stalled}) | stuck: ${agents.filter((a) => a.stuck).length} | tasks: ${tasks.length}`);
  L.push(`tokens: new ${fmt(t.new)} (in ${fmt(t.input)}, out ${fmt(t.output)}, cache_write ${fmt(t.cache_write)}) vs cache_read ${fmt(t.cache_read)}` + (t.usdKnown ? ` | usd_est ~$${t.usd.toFixed(4)}` : ''));
  if (machs.length > 1) L.push(`machines: ${machs.length} | ${machs.map(machLine).join('; ')}`);
  const conf = conflictsOf(s);
  L.push(`conflicts: ${conf.length}`);
  if (projs.length) {
    const shown = project != null || machine != null ? projs.filter((p) => agents.some((a) => tools_(p.agents).includes(a.id) || a.project_id === p.id)) : projs;
    L.push(`projects: ${shown.length}` + (shown.length ? ' | ' + shown.map((p) => projLine(p, agents.filter((a) => tools_(p.agents).includes(a.id) || a.project_id === p.id))).join('; ') : ''));
    const done = new Set();
    for (const p of shown) {
      const ags = agents.filter((a) => (tools_(p.agents).includes(a.id) || a.project_id === p.id) && !done.has(a.id));
      ags.forEach((a) => done.add(a.id));
      L.push(`project ${p.name ?? p.id}: ${projCount(ags.length)}`);
      for (const a of ags) L.push('  ' + agentLine(a));
    }
    const rest = agents.filter((a) => !done.has(a.id));
    if (rest.length) { L.push(`project (none): ${projCount(rest.length)}`); for (const a of rest) L.push('  ' + agentLine(a)); }
  } else for (const a of agents) L.push('  ' + agentLine(a));
  L.push('alerts (newest):', ...listItems(s.alerts, 5));
  if (includeEvents > 0) {
    const ev = tools_(s.events).slice(-includeEvents);
    L.push(`events (newest ${ev.length}):`, ...ev.map((e) => '  ' + trunc(JSON.stringify(e), 240)));
  }
  return L.join('\n');
}

// ---------- tools ----------
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const obj = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

const TOOLS = [
  {
    name: 'aos_status',
    description: 'Compact summary of the live AOS monitor: projects summary, then agents grouped by project (id, role, status, model, current tool, stuck), counts, new tokens vs cache reads, conflicts, newest alerts. Optional project and machine filters; with several machines, a machines line gives per-machine status and totals.',
    inputSchema: obj({ machine: { type: 'string', minLength: 1, maxLength: 64, description: 'Only this machine (cross-machine setups; see the machines line).' }, project: { type: 'string', minLength: 1, maxLength: 200, description: 'Only this project (name or id, as in the projects line).' }, include_events: { type: 'integer', minimum: 0, maximum: 50, description: 'Also include the newest N raw events (max 50). Default 0.' } }),
    async run(a) {
      const s = await api('/api/state');
      return summarize(s, clampInt(a.include_events, 0, 50, 0), a.project ?? null, a.machine ?? null);
    },
  },
  {
    name: 'aos_agent',
    description: 'One agent in detail: status, model, current tool, recent tools, usage, files touched.',
    inputSchema: obj({ id: { type: 'string', minLength: 1, maxLength: 200, description: 'Agent id as shown by aos_status.' } }, ['id']),
    async run(a) {
      const s = await api('/api/state');
      const ag = tools_(s.agents).find((x) => x.id === a.id);
      if (!ag) throw new ToolError(`No agent with id ${JSON.stringify(a.id)}. Known: ${tools_(s.agents).map((x) => x.id).slice(0, 20).join(', ') || 'none'}`);
      const u = ag.usage || {};
      const pj = projName(s, ag);
      const L = [
        agentLine(ag),
        ...(pj ? [`project: ${pj}`] : []),
        ...(typeof ag.machine === 'string' ? [`machine: ${trunc(ag.machine, 32)}`] : []),
        `timing: started_at ${ag.started_at ?? 'n/a'}, ended_at ${ag.ended_at ?? (ag.started_at != null && ag.status === 'running' ? 'running' : 'n/a')}, ran_s ${hasNum(ag.ran_s) ? ag.ran_s : 'n/a'}, tok_per_min ${hasNum(ag.tok_per_min) ? ag.tok_per_min : 'n/a'}`,
        `usage: input ${fmt(num(u.input))}, output ${fmt(num(u.output))}, cache_write ${fmt(num(u.cache_write))}, cache_read ${fmt(num(u.cache_read))}, usd_est ${u.usd_est == null ? 'n/a' : '$' + u.usd_est}`,
        `current_tool: ${ag.current_tool ? JSON.stringify(ag.current_tool) : 'none'}`,
        'recent_tools:', ...tools_(ag.recent_tools).slice(-15).map((t) => '  - ' + trunc(typeof t === 'string' ? t : JSON.stringify(t), 200)),
        'files:', ...tools_(ag.files).slice(0, 40).map((f) => '  - ' + trunc(typeof f === 'string' ? f : JSON.stringify(f), 200)),
      ];
      return L.join('\n');
    },
  },
  {
    name: 'aos_cost',
    description: 'Token and cost breakdown. "New tokens" = input + output + cache_write, reported separately from cache reads. Includes usd_est when available.',
    inputSchema: obj(),
    async run() {
      const s = await api('/api/state');
      const agents = tools_(s.agents), t = totals(agents);
      const L = [
        `new tokens: ${fmt(t.new)} (input ${fmt(t.input)}, output ${fmt(t.output)}, cache_write ${fmt(t.cache_write)})`,
        `cache reads: ${fmt(t.cache_read)}`,
        `usd_est: ${t.usdKnown ? '$' + t.usd.toFixed(4) : 'n/a'}`,
        'per agent (new tokens | cache_read | usd_est | ran | tok/min):',
        ...agents.map((a) => `  ${a.id} ${a.model_label ?? ''}${a.effort ? ' ' + a.effort : ''}: ${fmt(newTokens(a.usage))} | ${fmt(num(a.usage?.cache_read))} | ${a.usage?.usd_est == null ? 'n/a' : '$' + a.usage.usd_est}` + runPart(a)),
      ];
      if (s.cost !== undefined) L.push('monitor cost: ' + trunc(JSON.stringify(s.cost), 1500));
      return L.join('\n');
    },
  },
  {
    name: 'aos_conflicts',
    description: 'File conflicts/collisions between agents reported by the monitor.',
    inputSchema: obj(),
    async run() {
      const c = conflictsOf(await api('/api/state'));
      return `conflicts: ${c.length}\n` + (c.length ? c.slice(0, 50).map((x) => '- ' + itemText(x)).join('\n') : '');
    },
  },
  {
    name: 'aos_alerts',
    description: 'Newest alerts from the monitor (up to 20).',
    inputSchema: obj(),
    async run() {
      const al = tools_((await api('/api/state')).alerts);
      return `alerts: ${al.length}\n` + listItems(al, 20).join('\n');
    },
  },
  {
    name: 'aos_history',
    description: 'Recorded history range and replay markers (use timestamps with aos_state_at).',
    inputSchema: obj({ limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Max markers (default 20).' } }),
    async run(a) {
      const limit = clampInt(a.limit, 1, 200, 20);
      const h = await api(`/api/history?limit=${limit}`);
      const m = tools_(h.markers).slice(-limit);
      return [`first_ts: ${h.first_ts ?? 'n/a'} | last_ts: ${h.last_ts ?? 'n/a'} | count: ${h.count ?? 0}`,
        `markers (${m.length}):`, ...m.map((x) => '  - ' + trunc(typeof x === 'string' ? x : JSON.stringify(x), 200))].join('\n');
    },
  },
  {
    name: 'aos_goals',
    description: 'Orchestrator goals (read-only): without id, a list of goals with status, plan state, tasks, budget use and pending approvals; with id, one goal in detail (criteria, tasks, newest events). Includes outcomes: per task achieved/retried/escalated (tier path)/failed/discarded with tokens and cost, per goal merged vs discarded tasks, tokens per accepted result, cost and how long it has waited on you. Empty when no orchestrator is in use.',
    inputSchema: obj({ id: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$', description: 'Goal id as shown by the list.' } }),
    async run(a) {
      const unsupported = () => new ToolError('This AOS monitor does not report goals (no /api/goals endpoint): update the monitor');
      const missing = (e) => e instanceof ToolError && /HTTP 404/.test(e.message);
      const list = async () => { try { const r = await api('/api/goals'); return tools_(r?.goals); } catch (e) { if (missing(e)) throw unsupported(); throw e; } };
      if (a.id === undefined) {
        const g = await list();
        return `goals: ${g.length}\n` + g.slice(0, 50).map(goalLine).join('\n');
      }
      let d;
      try { d = await api('/api/goals/' + encodeURIComponent(a.id)); } catch (e) {
        if (!missing(e)) throw e;
        const g = await list();
        throw new ToolError(`No goal with id ${JSON.stringify(a.id)}. Known: ${g.map((x) => x.id).slice(0, 20).join(', ') || 'none'}`);
      }
      const detail = d && d.goal && typeof d.goal === 'object' && !Array.isArray(d.goal) ? d.goal : d; // one goal is { goal }, the list is { goals }
      const L = [goalLine(detail), ...(detail.description ? ['description: ' + trunc(detail.description, 300)] : []),
        `plan: ${detail.plan_state ?? 'none'}${detail.blocked_reason ? ' | blocked: ' + trunc(detail.blocked_reason, 160) : ''}${detail.paused_reason ? ' | paused: ' + trunc(detail.paused_reason, 160) : ''}${detail.resume_at ? ' | resume_at ' + detail.resume_at : ''}`,
        'criteria:', ...tools_(detail.criteria).slice(0, 50).map((c) => `  - [${c.met ? 'x' : ' '}] ${trunc(c.id, 40)} ${trunc(c.text, 160)}`),
        'tasks:', ...tools_(detail.tasks).slice(0, 200).map((t) => `  - ${trunc(t.id, 64)} | ${trunc(t.status, 20)}${t.phase ? '/' + trunc(t.phase, 20) : ''} | ${t.tier ?? '-'} | attempt ${num(t.attempts)}/${num(t.max_attempts)} | ${fmt(num(t.new_tokens))} tok | ran ${durStr(t.ran_s) ?? 'n/a'}${taskOutcome(t)}${t.depends_on?.length ? ' | after ' + tools_(t.depends_on).slice(0, 10).join(',') : ''}${t.check_summary ? ' | ' + trunc(t.check_summary, 40) : ''}${t.waiting_for_human ? ' | WAITING FOR HUMAN' : ''}${t.integrity && t.integrity.status && t.integrity.status !== 'clean' ? ' | integrity: ' + trunc(t.integrity.status, 10) + (tools_(t.integrity.reasons).length ? ' (' + tools_(t.integrity.reasons).slice(0, 6).map((r) => trunc(r, 40)).join(',') + ')' : '') : ''}${num(t.self_checks) ? ' | ' + num(t.self_checks) + ' self-check' + (num(t.self_checks) === 1 ? '' : 's') : ''}${t.version_mismatch ? ' | claude version changed' : ''}${t.error ? ' | error: ' + trunc(t.error, 160) : ''}`),
        'last_events:', ...tools_(detail.last_events).slice(-25).map((e) => `  - ${trunc(e.ts, 30)} ${trunc(e.type, 60)}${e.task_id ? ' ' + trunc(e.task_id, 64) : ''}${e.text ? ' ' + trunc(e.text, 160) : ''}`)];
      return L.join('\n');
    },
  },
  {
    name: 'aos_state_at',
    description: 'Replay summary of the monitor state at a past ISO-8601 timestamp.',
    inputSchema: obj({ at: { type: 'string', minLength: 10, maxLength: 40, description: 'ISO-8601 timestamp, e.g. 2026-01-01T12:00:00Z.' } }, ['at']),
    async run(a) {
      if (!/^\d{4}-\d{2}-\d{2}/.test(a.at) || isNaN(Date.parse(a.at))) throw new ToolError('Invalid "at": expected an ISO-8601 timestamp');
      const iso = new Date(a.at).toISOString();
      return `replay at ${iso}\n` + summarize(await api(`/api/state?at=${encodeURIComponent(iso)}`), 0);
    },
  },
];

function validate(schema, args) {
  if (args === undefined || args === null) args = {};
  if (typeof args !== 'object' || Array.isArray(args)) return 'arguments must be an object';
  for (const r of schema.required) if (args[r] === undefined) return `missing required argument "${r}"`;
  for (const [k, v] of Object.entries(args)) {
    const p = schema.properties[k];
    if (!p) return `unknown argument "${k}"`;
    if (p.type === 'integer') {
      if (typeof v !== 'number' || !Number.isInteger(v)) return `"${k}" must be an integer`;
      if (v < p.minimum || v > p.maximum) return `"${k}" must be between ${p.minimum} and ${p.maximum}`;
    } else if (p.type === 'string') {
      if (typeof v !== 'string') return `"${k}" must be a string`;
      if (v.length < (p.minLength ?? 0) || v.length > (p.maxLength ?? Infinity)) return `"${k}" length out of range`;
      if (p.pattern && !new RegExp(p.pattern).test(v)) return `"${k}" has an invalid format`;
    }
  }
  return null;
}

// ---------- JSON-RPC ----------
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0') {
    return fail(msg && msg.id !== undefined ? msg.id : null, -32600, 'Invalid Request');
  }
  const { id, method, params } = msg;
  const isReq = id !== undefined && id !== null;
  if (typeof method !== 'string') {
    if (isReq && ('result' in msg || 'error' in msg)) return; // stray response; ignore
    return fail(id ?? null, -32600, 'Invalid Request');
  }
  if (!isReq) return; // notifications (initialized, cancelled, ...) need no response
  switch (method) {
    case 'initialize': {
      const want = params?.protocolVersion;
      return reply(id, {
        protocolVersion: SUPPORTED.includes(want) ? want : SUPPORTED[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: 'Read-only view of the local AOS live monitor (127.0.0.1). Start with aos_status.',
      });
    }
    case 'ping': return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema, annotations: { title: name, ...RO } })) });
    case 'tools/call': {
      if (!params || typeof params.name !== 'string') return fail(id, -32602, 'Invalid params: "name" required');
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return fail(id, -32602, `Unknown tool: ${trunc(params.name, 80)}`);
      const bad = validate(tool.inputSchema, params.arguments);
      if (bad) return fail(id, -32602, `Invalid params: ${bad}`);
      try {
        const text = await tool.run(params.arguments || {});
        return reply(id, { content: [{ type: 'text', text }], isError: false });
      } catch (e) {
        if (!(e instanceof ToolError)) log('tool error:', e?.stack || e);
        return reply(id, { content: [{ type: 'text', text: e instanceof ToolError ? e.message : 'Internal error in tool' }], isError: true });
      }
    }
    default: return fail(id, -32601, `Method not found: ${trunc(method, 80)}`);
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
const pending = new Set();
rl.on('line', (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return fail(null, -32700, 'Parse error'); }
  const batch = Array.isArray(msg) ? msg : null;
  if (batch) { if (!batch.length) return fail(null, -32600, 'Invalid Request'); }
  for (const m of batch || [msg]) {
    const p = handle(m).catch((e) => { log('handler error:', e?.stack || e); if (m && m.id != null) fail(m.id, -32603, 'Internal error'); })
      .finally(() => pending.delete(p));
    pending.add(p);
  }
});
rl.on('close', async () => { await Promise.allSettled([...pending]); process.exit(0); });
process.on('uncaughtException', (e) => log('uncaught:', e?.stack || e));
