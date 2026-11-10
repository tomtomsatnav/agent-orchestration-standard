// AOS-1 read-only live monitor: folds Claude Code hook events (live/hook-events.ndjson) into an AOS-1 /api/state view.
// Zero dependencies, Node 18+ ESM. Binds 127.0.0.1 only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { parseRemotes, remotesFromEnv, createCollector, mergeState } from './remotes.mjs';
import { createOtelStore, BODY_MAX as OTEL_BODY_MAX } from './otel.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const UI = path.join(ROOT, 'ui');
const LIVE = process.env.AOS_LIVE_DIR || (process.env.CLAUDE_PLUGIN_DATA ? path.join(process.env.CLAUDE_PLUGIN_DATA, 'live') : path.join(ROOT, 'live')); // [build patch: plugin data dir]
const FILE = path.join(LIVE, 'hook-events.ndjson');
const PORT = (() => { const n = Number(process.env.PORT); return Number.isInteger(n) && n > 0 && n < 65536 ? n : 4318; })();
const HOST = '127.0.0.1';
const RUN_S = 900, SESSION_TTL_S = 3600, STALE_SUB_S = 600, INTERVAL_S = 30, TAIL_LINES = 2000, TAIL_BYTES = 1024 * 1024;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2' };
const HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' };
const GOAL_ID = 'live-goal';

// ---------- config / prices (mtime cached) ----------
const jsonCache = new Map();
function readJson(file) {
  try {
    const st = fs.statSync(file), c = jsonCache.get(file);
    if (c && c.m === st.mtimeMs && c.s === st.size) return c.v;
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    jsonCache.set(file, { m: st.mtimeMs, s: st.size, v });
    return v;
  } catch { return null; }
}
// projects: {"folderName": "Display Name"}; anything malformed is ignored
function aliasMap(o) {
  const m = new Map();
  if (!o || typeof o !== 'object' || Array.isArray(o)) return m;
  for (const k of Object.keys(o)) {
    const key = k.trim(), v = o[k], name = typeof v === 'string' ? v.trim() : '';
    if (!key || key.length > 200 || !name || name.length > 60 || /[\u0000-\u001f\u007f]/.test(name)) continue;
    m.set(key, name);
    if (m.size >= 200) break;
  }
  return m;
}
// per-model-family stuck thresholds (seconds); families are matched in the model id, case-insensitively
const FAMS = ['opus', 'sonnet', 'haiku'], FAM_DEFAULT = { opus: 600, sonnet: 240, haiku: 180 };
const modelFam = (m) => { if (typeof m !== 'string') return null; const x = m.toLowerCase(); return FAMS.find((f) => x.includes(f)) || null; };
function byModelCfg(o) {
  const out = { ...FAM_DEFAULT };
  if (!o || typeof o !== 'object' || Array.isArray(o)) return out;
  for (const k of Object.keys(o)) { const v = o[k]; if (FAMS.includes(k) && typeof v === 'number' && Number.isFinite(v) && v >= 5) out[k] = v; }
  return out;
}
function cfg() {
  const c = readJson(path.join(LIVE, 'config.json')) || {}, n = c.notify || {};
  const st = Number(c.stuck_after_s);
  const base = Number.isFinite(st) && st >= 5 ? st : 180, byModel = byModelCfg(c.stuck_after_s_by_model);
  return { stuck: base, byModel, minStuck: Math.min(base, ...Object.values(byModel)),
    errIdleS: 60, errRunLen: 3, errWinMs: 5 * 60 * 1000,
    notify: { enabled: n.enabled === true, on: Array.isArray(n.on) ? n.on.filter((k) => typeof k === 'string') : ['needs_input', 'stuck'], sound: n.sound === true },
    projects: aliasMap(c.projects), remotes: c.remotes };
}
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'unknown';
function priceFor(model) {
  const pr = readJson(path.join(LIVE, 'prices.json'));
  if (!pr || !model) return null;
  let best = null;
  for (const k of Object.keys(pr)) if (!k.startsWith('_') && pr[k] && typeof pr[k] === 'object' && model.startsWith(k) && (!best || k.length > best.length)) best = k;
  const p = best && pr[best];
  return p && Number.isFinite(p.input) && Number.isFinite(p.output) ? p : null;
}
function modelLabel(id) {
  if (!id || typeof id !== 'string' || id === 'unknown') return null;
  let m = id.replace(/\[[^\]]*\]/g, '').replace(/-\d{8}$/, '').replace(/^claude-/, '').trim();
  if (!m) return null;
  const cap = (f) => f[0].toUpperCase() + f.slice(1);
  let x = m.match(/^([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-|$)/);
  if (x) return `${cap(x[1])} ${x[2]}${x[3] ? '.' + x[3] : ''}`;
  x = m.match(/^(\d+)(?:-(\d{1,2}))?-([a-z]+)$/);
  if (x) return `${cap(x[3])} ${x[1]}${x[2] ? '.' + x[2] : ''}`;
  return m;
}
const zero = () => ({ input: 0, output: 0, cache_read: 0, cache_write: 0 });
const add = (a, b) => { a.input += b.input; a.output += b.output; a.cache_read += b.cache_read; a.cache_write += b.cache_write; return a; };
function usd(u, model) {
  const p = priceFor(model);
  if (!p) return null;
  return Math.round(((u.input * p.input + u.output * p.output + u.cache_read * (p.cache_read || 0) + u.cache_write * (p.cache_write || 0)) / 1e6) * 1e6) / 1e6;
}

// ---------- incremental ndjson ingest (bounded) ----------
const MAX_RECS = 50000;
let recs = [], off = 0, ino = null, carry = Buffer.alloc(0), ingestSig = '';
const tpSess = new Map(), tpAgent = new Map(); // sid -> transcript path ; sid:agent_id -> path
function ingest1(r) {
  if (!r || typeof r !== 'object' || typeof r.ts !== 'string' || !Number.isFinite(Date.parse(r.ts))) return;
  if ((r.sid != null && typeof r.sid !== 'string') || (r.f != null && typeof r.f !== 'string')) return; // fold() needs strings here
  recs.push(r);
  if (typeof r.tp === 'string' && r.tp.endsWith('.jsonl') && path.isAbsolute(r.tp) && r.sid) {
    if (r.ev === 'SubagentStop' && r.agent_id) tpAgent.set(r.sid + ':' + r.agent_id, r.tp); else if (!r.agent_id) tpSess.set(r.sid, r.tp);
  }
}
function ingest() {
  let fd;
  try {
    fd = fs.openSync(FILE, 'r');
    const st = fs.fstatSync(fd);
    if (st.size < off || (ino !== null && st.ino !== ino)) { off = 0; carry = Buffer.alloc(0); } // rotated (new inode) or truncated
    ino = st.ino;
    let budget = 16 * 1024 * 1024;
    while (off < st.size && budget > 0) {
      const len = Math.min(st.size - off, 1024 * 1024), buf = Buffer.alloc(len);
      const n = fs.readSync(fd, buf, 0, len, off);
      if (n <= 0) break;
      off += n; budget -= n;
      const data = Buffer.concat([carry, buf.subarray(0, n)]), idx = data.lastIndexOf(10);
      if (idx < 0) { carry = data.length > 1e6 ? Buffer.alloc(0) : data; continue; }
      carry = Buffer.from(data.subarray(idx + 1));
      for (const l of data.subarray(0, idx).toString('utf8').split('\n')) { if (!l) continue; try { ingest1(JSON.parse(l)); } catch {} }
    }
    if (recs.length > MAX_RECS) recs = recs.slice(-Math.floor(MAX_RECS * 0.8));
    ingestSig = st.size + ':' + st.mtimeMs;
  } catch {} finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

// ---------- transcript usage (counts, model and reasoning effort only) ----------
const TR = new Map(), seenMsg = new Set();
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']); // effort is a fixed vocabulary; anything else is ignored
function pump(p) {
  let t = TR.get(p);
  if (!t) { t = { off: 0, carry: Buffer.alloc(0), tot: zero(), by: Object.create(null), model: null, effort: null, last: 0 }; TR.set(p, t); if (TR.size > 500) TR.delete(TR.keys().next().value); }
  const now = Date.now();
  if (now - t.last < 2000) return t;
  t.last = now;
  let fd;
  try {
    fd = fs.openSync(p, 'r');
    const st = fs.fstatSync(fd);
    if (st.size < t.off) { t.off = 0; t.carry = Buffer.alloc(0); t.tot = zero(); t.by = Object.create(null); }
    let budget = 32 * 1024 * 1024;
    while (t.off < st.size && budget > 0) {
      const len = Math.min(st.size - t.off, 1024 * 1024), buf = Buffer.alloc(len);
      const n = fs.readSync(fd, buf, 0, len, t.off);
      if (n <= 0) break;
      t.off += n; budget -= n;
      const data = Buffer.concat([t.carry, buf.subarray(0, n)]), idx = data.lastIndexOf(10);
      if (idx < 0) { t.carry = data.length > 8e6 ? Buffer.alloc(0) : data; continue; }
      t.carry = Buffer.from(data.subarray(idx + 1));
      for (const l of data.subarray(0, idx).toString('utf8').split('\n')) {
        if (!l.includes('"usage"')) continue;
        try {
          const o = JSON.parse(l), m = o && o.message;
          if (!m || !m.usage || typeof m.usage !== 'object') continue;
          const ef = typeof o.effort === 'string' ? o.effort : o.perTurnEffort; // the latest turn's effort is what the agent runs at now
          if (EFFORTS.has(ef)) t.effort = ef;
          if (m.id) { if (seenMsg.has(m.id)) continue; seenMsg.add(m.id); if (seenMsg.size > 300000) seenMsg.clear(); }
          const u = m.usage, d = { input: +u.input_tokens || 0, output: +u.output_tokens || 0, cache_read: +u.cache_read_input_tokens || 0, cache_write: +u.cache_creation_input_tokens || 0 };
          const model = typeof m.model === 'string' && m.model !== '<synthetic>' ? m.model.slice(0, 80) : (t.model || 'unknown');
          t.model = model; add(t.tot, d); add(t.by[model] = t.by[model] || zero(), d);
        } catch {}
      }
    }
  } catch {} finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
  return t;
}
function trPath(sid, agentId) {
  if (agentId) {
    const k = sid + ':' + agentId;
    if (tpAgent.has(k)) return tpAgent.get(k);
    const main = tpSess.get(sid); // derive nested subagent transcript while running
    if (main && /^[A-Za-z0-9_-]+$/.test(agentId)) {
      const d = path.join(path.dirname(main), path.basename(main, '.jsonl'), 'subagents', 'agent-' + agentId + '.jsonl');
      try { if (fs.existsSync(d)) return d; } catch {}
    }
    return null;
  }
  return tpSess.get(sid) || null;
}

// ---------- project roots (from 'cwdp': full cwd paths; used only for grouping, never exposed) ----------
const HOME = path.resolve(os.homedir());
const under = (d, base) => base === '/' || d === base || d.startsWith(base + '/');
const comps = (d) => d.split('/').filter(Boolean).length;
const GENERIC_UNDER = ['/private/var/folders', '/tmp'];
const isGeneric = (d) => d === '/' || under(HOME, d) || comps(d) < 3 || GENERIC_UNDER.some((g) => under(d, g));
function normCwdp(v) { // absolute, <= 300 chars, no control chars; trailing slashes removed; anything else ignored
  if (typeof v !== 'string' || v.length > 300 || /[\u0000-\u001f\u007f]/.test(v) || !path.isAbsolute(v)) return null;
  return path.posix.normalize(v).replace(/\/+$/, '') || '/';
}
// project-root markers: a directory holding one of these is a project root (home and its ancestors never count)
const MARKERS = ['.git', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'Gemfile', 'CLAUDE.md', '.claude'];
const MARK_TTL_MS = 60 * 1000;
const markCache = new Map(); // dir -> { t, has }: stat results, expire after 60s
function hasMarker(d) {
  const now = Date.now(), c = markCache.get(d);
  if (c && now - c.t < MARK_TTL_MS) return c.has;
  let has = false;
  try { has = MARKERS.some((f) => fs.existsSync(path.join(d, f))); } catch { has = false; }
  markCache.set(d, { t: now, has });
  if (markCache.size > 2000) markCache.delete(markCache.keys().next().value);
  return has;
}
// m: Map(cwdp -> event count). Among non-generic ancestor-or-self candidates with coverage >= 0.6: the shallowest one that is a
// project root (has a marker); else the shallowest candidate; else the most frequent cwdp (generic -> home)
function deriveRoot(m, n) {
  const cands = new Set();
  for (const c of m.keys()) {
    if (c === '/') continue;
    const parts = c.split('/');
    let acc = '';
    for (let i = 1; i < parts.length; i++) { acc += '/' + parts[i]; if (!isGeneric(acc)) cands.add(acc); }
  }
  const ok = [];
  for (const d of cands) {
    let cov = 0;
    for (const [c, v] of m) if (under(c, d)) cov += v;
    if (cov / n >= 0.6) ok.push(d);
  }
  ok.sort((a, b) => comps(a) - comps(b) || (a < b ? -1 : a > b ? 1 : 0)); // shallowest first, alphabetical within a depth
  let best = ok.length ? ok[0] : null;
  for (const d of ok) if (!under(HOME, d) && hasMarker(d)) { best = d; break; }
  if (best) return best;
  const top = [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))[0][0];
  return isGeneric(top) ? HOME : top;
}
const RC = new Map(); // sid -> { sig, root }: derivation cache, keyed by the event counts per cwdp
function projectInfo(sid, cwpM, cwM, C) {
  if (cwpM && cwpM.size) {
    let n = 0, sig = '';
    for (const [c, v] of cwpM) { n += v; sig += c + '\u0000' + v + '\u0001'; }
    let hit = RC.get(sid);
    if (!hit || hit.sig !== sig) {
      hit = { sig, root: deriveRoot(cwpM, n) };
      RC.set(sid, hit); if (RC.size > 5000) RC.delete(RC.keys().next().value);
    }
    const root = hit.root, base = path.basename(root);
    return { key: 'p:' + root, root, base, alias: C.projects.get(root) || C.projects.get(base) || null };
  }
  // no cwdp at all (older log lines): modal cwd basename, unchanged
  let best = null, bn = 0;
  for (const [c, n] of cwM || []) if (n > bn) { best = c; bn = n; }
  return best ? { key: 'b:' + best, root: null, base: best, alias: C.projects.get(best) || null } : { key: 'b:unknown', root: null, base: 'unknown', alias: null };
}
// names/ids for the projects visible in this view; a shared id or display name gets disambiguated
function finalNames(visible, rank) {
  const fin = new Map();
  for (const [k, p] of visible) { const name = p.alias || p.base; fin.set(k, { name, id: slug(name) }); }
  const group = (f) => { const g = new Map(); for (const [k, v] of fin) { const x = f(v); if (!g.has(x)) g.set(x, []); g.get(x).push(k); } return g; };
  for (const ks of group((v) => v.id).values()) if (ks.length > 1) for (const k of ks) { const f = fin.get(k); f.id = f.id + '-' + createHash('sha1').update(k).digest('hex').slice(0, 8); }
  for (const ks of group((v) => v.name).values()) if (ks.length > 1) {
    ks.sort((a, b) => rank.get(a) - rank.get(b));
    for (const k of ks.slice(1)) { const p = visible.get(k); if (p.root) fin.get(k).name += ` (${path.basename(path.dirname(p.root))})`; }
  }
  return fin;
}

// ---------- orchestrator goals (READ-ONLY view of the engine's per-goal directories) ----------
// Source: ${AOS_ORCH_DIR || both (${XDG_STATE_HOME/aos | ~/.aos}/orch, legacy ${CLAUDE_PLUGIN_DATA || ~/.claude/plugins/data/aos-dashboard-aos-local}/orch)}/goals/<goal-id>/
// Field mapping (engine file -> API). Nothing is ever written; no full path leaves this process (repo is reduced to its basename,
// free text is scrubbed of absolute paths and token-like strings).
//   GoalSummary.id            dir name (== goal.json id)             .title/.description  goal.json title/description (cleaned, capped)
//   .status                   goal.json status                       .repo_name           basename(goal.json orch.repo)
//   .created_at/.updated_at   goal.json                              .blocked_reason      goal.json blocked_reason (extra, additive)
//   .plan_state               goal.orch.plan_state: planning|awaiting_approval|approved|rejected pass through; 'supplied' (a plan
//                             handed over, not yet validated) -> 'planning'; 'none' and anything unknown -> 'none'
//   .paused_reason/.resume_at goal.orch.paused_reason / goal.orch.resume_at (governor pause)
//   .limit_paused             true when paused_reason is a plan-limit pause (engine reasons: 'plan limit...', 'five-hour/seven-day utilisation...');
//                             false for other pauses (overloaded, manual); .rerun_count = tasks in GoalDetail with rerun true
//   GoalDetail.tasks[].rerun  task not terminal (done|failed|cancelled) whose newest attempt_log entry has outcome 'rate_limited' (attempt
//                             not counted; the engine requeues it) = interrupted by the plan limit and will rerun after the pause
//   .budget.max_new_tokens    goal.orch.budgets.max_new_tokens       .used_new_tokens     goal.orch.usage.new_tokens
//   .budget.max_wall_s        goal.budget.max_wall_clock_s           .used_wall_s         now - orch.started_ms (updated_at for terminal goals)
//   .budget.max_parallel      goal.orch.budgets.max_parallel         .max_attempts        goal.orch.budgets.max_attempts
//   .budget.running           count of tasks.json entries with status 'running'
//   .tasks_total/done/failed  tasks.json status counts ('done' / 'failed')
//   .approvals_pending        approvals/A-<n>.json with status 'pending'
//   .outcome                  {merged: tasks done, discarded: tasks failed+cancelled, tokens_per_accepted: usage.new_tokens/merged|null,
//                             cost_usd: usage.notional_usd, waiting_s/waiting_on: age of the oldest pending approval (requested_at) or plan
//                             awaiting approval (orch.plan_awaiting_since_ms, else updated_at); null/null when nothing waits}
//   GoalDetail.tasks[].outcome achieved|retried|escalated|failed|discarded|waiting|in_progress|pending, .retries (counted attempts - 1),
//                             .tier_path (tiers in attempt order, deduped), .cost_usd (sum of attempt notional_usd), .waiting_s
//   .out_of_scope_count       tasks with >=1 attempt_log entry of outcome 'scope_violation'   GoalDetail.tasks[].out_of_scope/.scope_violations  that flag / the count of such attempts
//   .workers                  agents currently running whose hook events carry gid == goal id (added from the live fold)
//   GoalDetail.criteria       goal.success_criteria {id,text,met}    .tasks[]  tasks.json: phase=orch.phase, tier=orch.model_tier,
//                             branch=orch.branch, ran_s=sum(orch.attempt_log durations), new_tokens=orch.tokens.new (else sum of attempts),
//                             check_summary='checking'|'checks passed'|'checks failed'|null (same words as the control server) from phase / last attempt checks_ok,
//                             waiting_for_human = status 'needs_review' or a pending approval for the task,
//                             error = orch.last_failure kind+note (scrubbed), only when the task is not done
//   .rules                    goal.orch.rules (the engine's rule-set snapshot summary; absent on older goals -> null): {hash (12 chars), profile (orch.rules.profile_name when present, else .profile), legacy, loosenings: n,
//                             dropped: n}; GoalDetail adds layers[{layer, sha12}], loosening_ids[{rule_id, layer}] and dropped_ids[{rule_id, layer, reason}] (ids only: no rule
//                             values and no paths; the 32-hex content binding of an id is shortened to 8 characters for display)
//   GoalDetail.criteria[].verify/.needs_confirmation   present only on a human-review criterion: verify 'human', needs_confirmation = not yet met
//   .integrity                (summary) {status clean|warning|failed, failed_attempts, warning_attempts, kinds{kind:n}, checked}: worst attempt_log[].anticheat status (+ protected_result / acceptance_result failures); old goals -> clean, checked false
//   GoalDetail.protected_tests {ok,files,not_executed,kind,output}|null from orch.protected_result; .review {tier,text,error}|null from orch.review (advisory); .claude_version_start
//   GoalDetail.tasks[].attempt_log[{n,tier,outcome,integrity{status,reasons[]}|null,self_checks,claude_version,version_mismatch,stderr_tail}] (newest 10), .integrity (worst of attempts), .self_checks (sum), .version_mismatch
//   .last_events              the 25 newest lines of events.ndjson, oldest first (same order as state.events): {type, ts, task_id, text}
// Replay (?at=): goals are NOT time-sliced; replayed /api/state omits the `goals` key. Agent tags and goal-based project grouping
// still come from the (time-sliced) events.
// State dirs (all read-only, never created): AOS_ORCH_DIR if set; otherwise BOTH the orchestrator's default dir
// ($XDG_STATE_HOME/aos/orch if XDG_STATE_HOME is set, else ~/.aos/orch) and the legacy <plugin data>/orch. Goals from both are merged,
// deduped by goal id; the copy with the newer heartbeat (goal.json mtime) wins.
const ORCH_ROOTS = process.env.AOS_ORCH_DIR ? [path.resolve(process.env.AOS_ORCH_DIR)] : [...new Set([
  path.join(process.env.XDG_STATE_HOME ? path.resolve(process.env.XDG_STATE_HOME) : path.join(os.homedir(), '.aos'), ...(process.env.XDG_STATE_HOME ? ['aos'] : []), 'orch'),
  path.join(process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.claude', 'plugins', 'data', 'aos-dashboard-aos-local'), 'orch')])];
const GOALS_DIRS = ORCH_ROOTS.map((r) => path.join(r, 'goals'));
const GOAL_READ_MAX = 50, STATE_GOALS_MAX = 20, GOAL_DIRS_SCAN_MAX = 5000, FILE_MAX = 2 * 1024 * 1024, EVENT_TAIL_BYTES = 256 * 1024, DETAIL_EVENTS = 25, TASKS_MAX = 200, APPROVALS_MAX = 200;
const GID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, TAG_RE = /^[A-Za-z0-9._-]{1,64}$/;
const PLAN_STATES = new Set(['planning', 'awaiting_approval', 'approved', 'rejected', 'none']);
const TERMINAL_TASK = new Set(['done', 'failed', 'cancelled']);
const TERMINAL_GOAL = new Set(['achieved', 'failed', 'cancelled']);
const ctl = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]+/g, ' ').trim().slice(0, n);
// free text from the engine: absolute paths reduced to their basename, long token-like strings redacted
const scrub = (s, n = 160) => ctl(s, 600)
  .replace(/(^|[\s("'=:])((?:~|\/)[^\s"'`),;]*)/g, (m, pre, p) => pre + (path.basename(p) || '.'))
  .replace(/\b(sk|pk|ghp|gho|xox[a-z]|AKIA|eyJ)[A-Za-z0-9_\-]{8,}/g, '[redacted]').replace(/\b[A-Za-z0-9+\/_\-]{32,}\b/g, '[redacted]').slice(0, n);
const nn = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const isoOrNull = (v) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v.slice(0, 40) : null);
const objOr = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

// reads a JSON file (size-capped); undefined on any failure (missing, partial write, corrupt, too big)
function readJsonSafe(file, st) {
  try { if (!st || st.size > FILE_MAX) return undefined; return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}
const statOrNull = (f) => { try { return fs.statSync(f); } catch { return null; } };
const sigOf = (st) => (st ? st.mtimeMs + ':' + st.size : '-');
// last N events of an ndjson file by reading only its tail; a cut first line and a partial last line are dropped
function tailEvents(file, st, n) {
  let fd;
  try {
    if (!st || st.size === 0) return [];
    fd = fs.openSync(file, 'r');
    const len = Math.min(st.size, EVENT_TAIL_BYTES), buf = Buffer.alloc(len);
    const got = fs.readSync(fd, buf, 0, len, st.size - len);
    let lines = buf.subarray(0, got).toString('utf8').split('\n');
    if (st.size > len) lines = lines.slice(1);
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < n; i--) { if (!lines[i]) continue; try { const e = JSON.parse(lines[i]); if (e && typeof e === 'object' && typeof e.type === 'string') out.push(e); } catch {} }
    return out.reverse();
  } catch { return []; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}
const EVENT_KEYS = ['reason', 'error', 'msg', 'title', 'status', 'plan_state', 'tier', 'attempt', 'outcome', 'rule', 'label', 'tool', 'exit_code', 'kind', 'cause', 'ok', 'run'];
function eventView(e) {
  const d = objOr(e.data), parts = [];
  for (const k of EVENT_KEYS) { const v = d[k]; if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') parts.push((k === 'reason' || k === 'error' || k === 'msg' || k === 'title' ? '' : k + '=') + scrub(v, 100)); if (parts.length >= 4) break; }
  return { type: ctl(e.type, 60), ts: isoOrNull(e.ts), task_id: typeof e.task_id === 'string' && TAG_RE.test(e.task_id) ? e.task_id : null, text: parts.join(' ').slice(0, 160) };
}
function pendingApprovals(dir) { // -> Array of {task_id, ts(ms)} for pending requests
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^A-\d{1,6}\.json$/.test(n)).slice(0, APPROVALS_MAX); } catch { return []; }
  const out = [];
  for (const n of names) { const f = path.join(dir, n), a = readJsonSafe(f, statOrNull(f)); if (a && typeof a === 'object' && a.status === 'pending') out.push({ task_id: typeof a.task_id === 'string' && TAG_RE.test(a.task_id) ? a.task_id : '', ts: Date.parse(a.requested_at) || (statOrNull(f) || {}).mtimeMs || null }); }
  return out;
}

const goalEntries = new Map(); // id -> { sig, goal, tasks, pending, events, gsig, tsig, esig, asig }
let goalsView = { list: [], byId: new Map(), sig: '' };
let goalsScanAt = 0;
function loadGoalEntry(id, gdir) {
  const dir = path.join(gdir, id), ck = dir;
  let e = goalEntries.get(ck);
  const gst = statOrNull(path.join(dir, 'goal.json')), tst = statOrNull(path.join(dir, 'tasks.json')), est = statOrNull(path.join(dir, 'events.ndjson')), ast = statOrNull(path.join(dir, 'approvals'));
  const gs = sigOf(gst), ts = sigOf(tst), es = sigOf(est), as = sigOf(ast);
  if (!e) e = { goal: null, tasks: [], pending: [], events: [], gsig: '', tsig: '', esig: '', asig: '' };
  if (gs !== e.gsig) { const g = readJsonSafe(path.join(dir, 'goal.json'), gst); if (g && typeof g === 'object' && !Array.isArray(g)) { e.goal = g; e.gsig = gs; } }
  if (!e.goal) return null;
  if (ts !== e.tsig) { const t = readJsonSafe(path.join(dir, 'tasks.json'), tst); if (Array.isArray(t)) { e.tasks = t.slice(0, TASKS_MAX).filter((x) => x && typeof x === 'object' && typeof x.id === 'string' && TAG_RE.test(x.id)); e.tsig = ts; } else if (!tst) { e.tasks = []; e.tsig = ts; } }
  if (es !== e.esig) { e.events = tailEvents(path.join(dir, 'events.ndjson'), est, DETAIL_EVENTS).map(eventView); e.esig = es; }
  if (as !== e.asig) { e.pending = pendingApprovals(path.join(dir, 'approvals')); e.asig = as; }
  e.sig = e.gsig + '|' + e.tsig + '|' + e.esig + '|' + e.asig;
  return e;
}
// Outcome roll-up, all derived from existing state: merged = tasks integrated (status done), discarded = work that never reached the integration
// branch (failed + cancelled); tokens_per_accepted = orch.usage.new_tokens / merged (null until one is merged); cost_usd = orch.usage.notional_usd;
// waiting_s = age of the oldest pending approval or of a plan awaiting approval (null when nothing waits on a human).
function goalOutcome(g, e, now) {
  const o = objOr(g.orch), U = objOr(o.usage), T = e.tasks, merged = T.filter((t) => t.status === 'done').length;
  const plan = o.plan_state === 'awaiting_approval' && g.status === 'draft' ? (Number.isFinite(o.plan_awaiting_since_ms) ? o.plan_awaiting_since_ms : Date.parse(g.updated_at) || null) : null;
  const since = [plan, ...e.pending.map((p) => p.ts)].filter((x) => Number.isFinite(x));
  const oldest = since.length ? Math.min(...since) : null;
  return { merged, discarded: T.filter((t) => t.status === 'failed' || t.status === 'cancelled').length,
    tokens_per_accepted: merged ? Math.round(nn(U.new_tokens) / merged) : null, cost_usd: Math.round(nn(U.notional_usd) * 1e4) / 1e4,
    waiting_s: oldest === null ? null : Math.max(0, Math.round((now - oldest) / 1000)), waiting_on: oldest === null ? null : plan !== null && plan === oldest ? 'plan' : 'approval' };
}
// engine records a scope violation as attempt_log outcome 'scope_violation' (changed files outside path_scope; the attempt fails and is escalated)
const scopeViolations = (t) => (Array.isArray(objOr(t.orch).attempt_log) ? t.orch.attempt_log : []).filter((a) => a && typeof a === 'object' && a.outcome === 'scope_violation').length;
const isRerun = (t) => { const log = Array.isArray(objOr(t.orch).attempt_log) ? t.orch.attempt_log : [], l = log[log.length - 1]; return !TERMINAL_TASK.has(t.status) && !!l && typeof l === 'object' && l.outcome === 'rate_limited'; };
// ---- anti-cheat / integrity (additive, optional; old goals without these fields render as null/empty) ----
// attempt_log[].anticheat {status pass|warn|fail, failed, findings[{kind,severity}]} -> integrity clean|warning|failed + reason kinds; attempt outcome
// 'worktree_mutated_during_checks' counts as failed; attempt_log[].self_checks.runs -> self_checks; attempt_log[].claude_version vs goal.orch.claude_version_start;
// attempt_log[].stderr_tail (scrubbed per line, newest 20 lines); goal.orch.protected_result {ok,files,not_executed,kind}; goal.orch.review {tier,text,error}
const INTEG = { pass: 'clean', warn: 'warning', fail: 'failed' }, INTEG_RANK = { clean: 0, warning: 1, failed: 2 };
const KIND_RE = /^[a-z_]{1,40}$/;
const logOf = (t) => (Array.isArray(objOr(t.orch).attempt_log) ? t.orch.attempt_log.filter((a) => a && typeof a === 'object') : []);
function attemptIntegrity(a) {
  const ac = objOr(a.anticheat), reasons = [];
  let st = INTEG[ac.status] || null;
  if (typeof ac.failed === 'string' && KIND_RE.test(ac.failed)) reasons.push(ac.failed);
  for (const f of (Array.isArray(ac.findings) ? ac.findings : []).slice(0, 20)) { const k = objOr(f).kind; if (typeof k === 'string' && KIND_RE.test(k) && !reasons.includes(k)) reasons.push(k); }
  if (a.outcome === 'worktree_mutated_during_checks') { st = 'failed'; if (!reasons.includes(a.outcome)) reasons.push(a.outcome); }
  return st ? { status: st, reasons: reasons.slice(0, 8) } : null;
}
const tailText = (s) => (typeof s === 'string' ? s.split('\n').slice(-20).map((l) => scrub(l, 200)).join('\n').slice(-1500).trim() : '');
function attemptView(a, start) {
  const sc = objOr(a.self_checks), v = typeof a.claude_version === 'string' ? ctl(a.claude_version, 40) : null, tail = tailText(a.stderr_tail);
  return { n: nn(a.n), tier: a.tier ? ctl(a.tier, 20) : null, outcome: a.outcome ? ctl(a.outcome, 40) : null, integrity: attemptIntegrity(a),
    self_checks: Number.isFinite(sc.runs) ? nn(sc.runs) : null, claude_version: v, version_mismatch: !!(v && start && v !== start), stderr_tail: tail || null };
}
function taskIntegrity(log) {
  let st = null; const kinds = [];
  for (const a of log) { const i = attemptIntegrity(a); if (!i) continue; if (st === null || INTEG_RANK[i.status] > INTEG_RANK[st]) st = i.status; for (const k of i.reasons) if (!kinds.includes(k)) kinds.push(k); }
  return st ? { status: st, reasons: kinds.slice(0, 8) } : null;
}
function integrityOf(tasks, o) {
  const kinds = {}; let status = 'clean', warnings = 0, failed = 0, seen = 0;
  for (const t of tasks) for (const a of logOf(t)) {
    const i = attemptIntegrity(a); if (!i) continue; seen++;
    if (i.status === 'failed') failed++; else if (i.status === 'warning') warnings++;
    if (INTEG_RANK[i.status] > INTEG_RANK[status]) status = i.status;
    if (i.status !== 'clean') for (const k of i.reasons) kinds[k] = (kinds[k] || 0) + 1;
  }
  const pr = objOr(o.protected_result), ar = objOr(objOr(o.anticheat).acceptance_result);
  if (pr.ok === false || ar.ok === false) { status = 'failed'; const k = typeof pr.kind === 'string' && KIND_RE.test(pr.kind) ? pr.kind : pr.ok === false ? 'protected_tests_failed' : 'acceptance_failed'; kinds[k] = (kinds[k] || 0) + 1; }
  return { status, failed_attempts: failed, warning_attempts: warnings, kinds, checked: seen > 0 || typeof pr.ok === 'boolean' };
}
function protectedView(o) {
  const r = objOr(o.protected_result); if (typeof r.ok !== 'boolean') return null;
  return { ok: r.ok, files: nn(r.files), not_executed: Array.isArray(r.not_executed) ? r.not_executed.length : 0, kind: typeof r.kind === 'string' && KIND_RE.test(r.kind) ? r.kind : null, output: r.ok ? null : (tailText(r.output) || null) };
}
function reviewView(o) {
  if (!o.review || typeof o.review !== 'object' || Array.isArray(o.review)) return null;
  const r = o.review;
  return { tier: r.tier ? ctl(r.tier, 20) : null, text: tailText(r.text) || null, error: r.error ? scrub(r.error, 200) : null };
}
const RULE_ID_RE = /@([0-9a-f]{8})[0-9a-f]{24}\b/g;
const ruleId = (v) => ctl(v, 160).replace(RULE_ID_RE, '@$1');
function rulesView(o, detail) {
  const r = objOr(o.rules); if (typeof r.hash !== 'string' || !r.hash) return null;
  const A = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);
  // profile_name: the profile the human chose (r.profile only follows the user layer)
  const out = { hash: ctl(r.hash, 12), profile: ctl(r.profile_name, 24) || ctl(r.profile, 24) || 'strict', legacy: r.legacy === true, loosenings: A(r.loosenings).length, dropped: A(r.dropped).length };
  if (detail) {
    out.layers = A(r.layers).slice(0, 8).map((l) => ({ layer: ctl(l.layer, 16), sha12: typeof l.sha12 === 'string' ? ctl(l.sha12, 12) : null }));
    out.loosening_ids = A(r.loosenings).slice(0, 30).map((l) => ({ rule_id: ruleId(l.rule_id), layer: ctl(l.layer, 16) }));
    out.dropped_ids = A(r.dropped).slice(0, 30).map((l) => ({ rule_id: ruleId(l.rule_id), layer: ctl(l.layer, 16), reason: ctl(l.reason, 40) }));
  }
  return out;
}
function summaryOf(id, e, now) {
  const g = e.goal, o = objOr(g.orch), B = objOr(o.budgets), U = objOr(o.usage), GB = objOr(g.budget), T = e.tasks;
  const startedMs = Number.isFinite(o.started_ms) ? o.started_ms : null, status = ctl(g.status, 20) || 'unknown';
  const endMs = TERMINAL_GOAL.has(status) ? (Date.parse(g.updated_at) || now) : now;
  return {
    id, title: ctl(g.title, 120), status, repo_name: typeof o.repo === 'string' && o.repo ? ctl(path.basename(o.repo), 60) : '',
    created_at: isoOrNull(g.created_at), updated_at: isoOrNull(g.updated_at),
    plan_state: o.plan_state === 'supplied' ? 'planning' : PLAN_STATES.has(o.plan_state) ? o.plan_state : 'none',
    paused_reason: o.paused_reason ? scrub(o.paused_reason, 160) : null, resume_at: isoOrNull(o.resume_at),
    limit_paused: typeof o.paused_reason === 'string' && /plan limit|utili[sz]ation/i.test(o.paused_reason), rerun_count: T.filter((t) => isRerun(t)).length, out_of_scope_count: T.filter((t) => scopeViolations(t) > 0).length,
    budget: { max_new_tokens: nn(B.max_new_tokens), used_new_tokens: nn(U.new_tokens), max_wall_s: nn(GB.max_wall_clock_s), used_wall_s: startedMs === null ? 0 : Math.max(0, Math.round((endMs - startedMs) / 1000)),
      max_parallel: nn(B.max_parallel), running: T.filter((t) => t.status === 'running').length, max_attempts: nn(B.max_attempts) },
    tasks_total: T.length, tasks_done: T.filter((t) => t.status === 'done').length, tasks_failed: T.filter((t) => t.status === 'failed').length,
    approvals_pending: e.pending.length, blocked_reason: g.blocked_reason ? scrub(g.blocked_reason, 200) : null,
    outcome: goalOutcome(g, e, now), rules: rulesView(o, false), integrity: integrityOf(T, o),
  };
}
function taskView(t, e, now) {
  const o = objOr(t.orch), log = Array.isArray(o.attempt_log) ? o.attempt_log.filter((a) => a && typeof a === 'object') : [], last = log[log.length - 1];
  let ran = 0, tok = 0;
  for (const a of log) { const s = Date.parse(a.started_at); if (Number.isFinite(s)) { const en = a.ended_at ? Date.parse(a.ended_at) : (t.status === 'running' ? now : s); if (Number.isFinite(en)) ran += Math.max(0, en - s); } tok += nn(a.new_tokens); }
  const counted = log.filter((a) => a.counted !== false).length, tierPath = log.map((a) => ctl(a.tier, 20)).filter((x, i, l) => x && x !== l[i - 1]);
  const retries = Math.max(0, counted - 1), mine = e.pending.filter((p) => p.task_id === t.id).map((p) => p.ts).filter((x) => Number.isFinite(x));
  const outcome = t.status === 'done' ? (tierPath.length > 1 ? 'escalated' : retries > 0 ? 'retried' : 'achieved') : t.status === 'failed' ? 'failed' : t.status === 'cancelled' ? 'discarded'
    : t.status === 'needs_review' || mine.length ? 'waiting' : t.status === 'running' || t.status === 'ready' ? 'in_progress' : 'pending';
  const check = o.phase === 'checking' ? 'checking' : last && last.checks_ok === true ? 'checks passed' : last && last.checks_ok === false ? 'checks failed' : t.status === 'done' ? 'checks passed' : null;
  const lf = objOr(o.last_failure), start = typeof objOr(e.goal.orch).claude_version_start === 'string' ? ctl(e.goal.orch.claude_version_start, 40) : null;
  return { id: t.id, title: ctl(t.title, 120), status: ctl(t.status, 20), phase: o.phase ? ctl(o.phase, 20) : null, tier: o.model_tier ? ctl(o.model_tier, 20) : null,
    depends_on: (Array.isArray(t.depends_on) ? t.depends_on : []).filter((d) => typeof d === 'string' && TAG_RE.test(d)).slice(0, 50),
    attempts: nn(t.attempts), max_attempts: nn(t.max_attempts), branch: typeof o.branch === 'string' ? ctl(o.branch, 100) : null, ran_s: Math.round(ran / 1000),
    new_tokens: o.tokens && Number.isFinite(o.tokens.new) ? nn(o.tokens.new) : tok, check_summary: check,
    outcome, rerun: isRerun(t), out_of_scope: scopeViolations(t) > 0, scope_violations: scopeViolations(t), retries, tier_path: tierPath, cost_usd: Math.round(log.reduce((x, a) => x + nn(a.notional_usd), 0) * 1e4) / 1e4,
    waiting_s: mine.length ? Math.max(0, Math.round((now - Math.min(...mine)) / 1000)) : null,
    waiting_for_human: t.status === 'needs_review' || mine.length > 0 || e.pending.some((p) => p.task_id === t.id),
    attempt_log: log.slice(-10).map((a) => attemptView(a, start)), integrity: taskIntegrity(log), self_checks: log.reduce((x, a) => x + (Number.isFinite(objOr(a.self_checks).runs) ? nn(a.self_checks.runs) : 0), 0),
    version_mismatch: log.some((a) => typeof a.claude_version === 'string' && !!start && a.claude_version !== start),
    ...(t.status !== 'done' && lf.kind ? { error: scrub(`${lf.kind}${lf.note ? ': ' + lf.note : ''}`, 160) } : {}) };
}
// refreshes the cached view (at most one directory scan per second)
function goalsIndex() {
  const now = Date.now();
  if (now - goalsScanAt < 1000) return goalsView;
  goalsScanAt = now;
  try {
    const best = new Map(); // id -> { n, m, gd }: newest heartbeat across the state dirs
    for (const gd of GOALS_DIRS) {
      let names = [];
      try { names = fs.readdirSync(gd).slice(0, GOAL_DIRS_SCAN_MAX).filter((n) => GID_RE.test(n)); } catch { names = []; }
      for (const n of names) { try { const d = path.join(gd, n); if (fs.lstatSync(d).isDirectory()) { const st = statOrNull(path.join(d, 'goal.json')); const o = best.get(n); if (st && (!o || st.mtimeMs > o.m)) best.set(n, { n, m: st.mtimeMs, gd }); } } catch {} }
    }
    const cand = [...best.values()];
    cand.sort((a, b) => b.m - a.m || (a.n < b.n ? -1 : 1));
    const keep = new Map(), byId = new Map(), list = [];
    let sig = '';
    for (const { n, gd } of cand.slice(0, GOAL_READ_MAX)) {
      let e = null; try { e = loadGoalEntry(n, gd); } catch { e = null; }
      if (!e) continue;
      const ck = path.join(gd, n);
      goalEntries.set(ck, e); keep.set(ck, e); sig += n + '=' + e.sig + ';';
      list.push(n); byId.set(n, e);
    }
    for (const k of [...goalEntries.keys()]) if (!keep.has(k)) goalEntries.delete(k);
    goalsView = { list, byId, sig };
  } catch { /* keep the previous view */ }
  return goalsView;
}
// summaries (newest updated_at first). `now` drives the time-based fields only
function goalSummaries(limit) {
  const v = goalsIndex(), now = Date.now(), out = [];
  for (const id of v.list) out.push(summaryOf(id, v.byId.get(id), now));
  out.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || '') || (a.id < b.id ? -1 : 1));
  return out.slice(0, limit);
}
function goalDetail(id) {
  const v = goalsIndex(), e = GID_RE.test(id) ? v.byId.get(id) : null;
  if (!e) return null;
  const now = Date.now();
  return { ...summaryOf(id, e, now), rules: rulesView(objOr(e.goal.orch), true), protected_tests: protectedView(objOr(e.goal.orch)), review: reviewView(objOr(e.goal.orch)),
    claude_version_start: typeof objOr(e.goal.orch).claude_version_start === 'string' ? ctl(e.goal.orch.claude_version_start, 40) : null, description: ctl(e.goal.description, 500),
    criteria: (Array.isArray(e.goal.success_criteria) ? e.goal.success_criteria : []).slice(0, 50).filter((c) => c && typeof c === 'object').map((c, i) => ({ id: ctl(c.id ?? 'c' + (i + 1), 40), text: ctl(c.text, 200), met: c.met === true, ...(c.verify === 'human' ? { verify: 'human', needs_confirmation: c.met !== true } : {}) })),
    tasks: e.tasks.map((t) => taskView(t, e, now)), last_events: e.events.slice(-DETAIL_EVENTS) };
}
// repo roots stay internal: used only to group tagged workers under the goal's project
const goalRepo = (id) => { const e = goalsIndex().byId.get(id); return e && typeof e.goal.orch?.repo === 'string' && path.isAbsolute(e.goal.orch.repo) ? e.goal.orch.repo : null; };
const goalTitle = (id) => { const e = goalsIndex().byId.get(id); return e ? ctl(e.goal.title, 120) : null; };
// orchestrator worker: tier the engine requested for the task (tasks.json orch.model_tier) vs the model family actually served (transcript / SessionStart).
// Only tiers that name a model family (opus|sonnet|haiku) are compared; mismatch is flagged only when both sides are known.
const tierCheck = (gid, tid, served) => {
  const e = gid && tid ? goalsIndex().byId.get(gid) : null, t = e && e.tasks.find((x) => x && x.id === tid), tier = t && t.orch && t.orch.model_tier ? ctl(t.orch.model_tier, 20) : null;
  if (!tier) return {};
  const a = modelFam(tier), b = modelFam(served);
  return { requested_tier: tier, ...(a && b && a !== b ? { model_mismatch: true } : {}) };
};
// orchestrator worker whose task had an attempt rejected for touching files outside its declared path_scope (only tagged workers have a scope; others never get the flag)
const scopeCheck = (gid, tid) => { const e = gid && tid ? goalsIndex().byId.get(gid) : null, t = e && e.tasks.find((x) => x && x.id === tid); return t && scopeViolations(t) > 0 ? { out_of_scope: true } : {}; };
const withWorkers = (list, agents) => { const n = new Map(); for (const a of agents) if (a.goal_id && a.status === 'running') n.set(a.goal_id, (n.get(a.goal_id) || 0) + 1); return list.map((g) => ({ ...g, workers: n.get(g.id) || 0 })); };

// ---------- guard verdicts (READ-ONLY view of `aos-orch verify` records: <orch root>/verdicts/<id>.json, schema aos.verdict/1) ----------
// Same roots as goals. Only file names matching VID_RE are read; the id encodes its time, so the newest VERDICT_SCAN_MAX names are
// taken by name (no stat of older files), each <= 64 KB, cached by mtime+size, rescanned at most once a second. Bad JSON, wrong
// schema, an id that differs from the file name or a non-boolean accepted/integrity -> skipped. Exposed (all scrubbed like goals):
// repo -> repo_name (basename only), base -> 12-char sha, tree 'working' or a 12-char sha, rejections[{kind, detail}], warnings,
// failing_tests, checks[{cmd (argv joined, paths reduced to basenames), ok, exit_code, duration_ms}]. session_id is NEVER exposed: it is
// only matched (first 8 chars, as the hook log keeps them) against live sessions, which then carry `guard` and the verdict `agent`.
const VERDICT_DIRS = ORCH_ROOTS.map((r) => path.join(r, 'verdicts'));
const VID_RE = /^v-\d{8}-\d{6}-[0-9a-f]{6}$/, VERDICT_SCAN_MAX = 200, VERDICT_FILE_MAX = 64 * 1024, VERDICTS_API_MAX = 50, VERDICT_LATEST_MAX = 20;
const VSOURCES = new Set(['cli', 'hook', 'eval']), VKIND_RE = /^[a-z0-9_.-]{1,40}$/, SHA_RE = /^[0-9a-f]{7,64}$/;
const verdictEntries = new Map(); // file -> { sig, v (internal record) | null }
let verdictsView = { list: [], sig: '' }, verdictsScanAt = 0;
const strList = (x, n, len) => (Array.isArray(x) ? x : []).filter((s) => typeof s === 'string' && s.trim()).slice(0, n).map((s) => scrub(s, len));
function verdictOf(j, id) { // -> internal record {view, repo (abs, never exposed), sid8} or null
  if (!j || typeof j !== 'object' || Array.isArray(j) || j.schema !== 'aos.verdict/1' || j.id !== id || typeof j.accepted !== 'boolean' || typeof j.integrity !== 'boolean') return null;
  const repo = typeof j.repo === 'string' && path.isAbsolute(j.repo) ? path.posix.normalize(j.repo).replace(/\/+$/, '') || '/' : null;
  const rej = (Array.isArray(j.rejections) ? j.rejections : []).filter((r) => r && typeof r === 'object').slice(0, 20)
    .map((r) => ({ kind: typeof r.kind === 'string' && VKIND_RE.test(r.kind) ? r.kind : 'other', detail: scrub(r.detail, 160) }));
  const checks = (Array.isArray(j.checks) ? j.checks : []).filter((c) => c && typeof c === 'object').slice(0, 20).map((c) => ({
    cmd: (typeof c.argv === 'string' ? scrub(c.argv, 200) : (Array.isArray(c.argv) ? c.argv : []).filter((a) => typeof a === 'string').slice(0, 30).map((a) => scrub(a, 80)).join(' ')).slice(0, 200), // the contract's argv is a joined string; an array is accepted too
    ok: c.ok === true, exit_code: Number.isInteger(c.exit_code) ? c.exit_code : null, duration_ms: Math.round(nn(c.duration_ms)) }));
  // verified = accepted; integrity = an integrity rejection (red); capability = rejected because checks failed (amber)
  const verdict = j.accepted ? 'verified' : j.integrity ? 'integrity' : 'capability';
  const view = { id, created_at: isoOrNull(j.created_at), repo_name: repo ? ctl(path.basename(repo) || '/', 60) : ctl(path.basename(String(j.repo_name || '')), 60),
    base: typeof j.base === 'string' && SHA_RE.test(j.base) ? j.base.slice(0, 12) : null, base_ref: typeof j.base_ref === 'string' ? scrub(j.base_ref, 80) || null : null,
    tree: j.tree === 'working' ? 'working' : typeof j.tree === 'string' && SHA_RE.test(j.tree) ? j.tree.slice(0, 12) : null,
    accepted: j.accepted, integrity: j.integrity, verdict, kind: verdict === 'verified' ? null : headlineKind(rej),
    rejections: rej, warnings: strList(j.warnings, 20, 160), failing_tests: strList(j.failing_tests, 50, 160), checks, duration_ms: Math.round(nn(j.duration_ms)),
    source: VSOURCES.has(j.source) ? j.source : 'unknown', tool_version: typeof j.tool_version === 'string' ? ctl(j.tool_version, 40) : null };
  return { view, repo, sid8: typeof j.session_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(j.session_id) ? j.session_id.slice(0, 8) : null };
}
// newest first (by id = time, then created_at); deduped by id across roots (the newer file wins)
// The headline reason: the most specific integrity kind when there is one ("tests edited" says more than the generic "protected tests failed"
// that always accompanies it), else the first rejection.
const GENERIC_KINDS = new Set(['protected_tests_failed', 'other']);
const headlineKind = (rej) => (rej.find((r) => !GENERIC_KINDS.has(r.kind)) || rej[0] || { kind: null }).kind;
function verdictsIndex() {
  const now = Date.now();
  if (now - verdictsScanAt < 1000) return verdictsView;
  verdictsScanAt = now;
  try {
    const names = [];
    for (const d of VERDICT_DIRS) {
      let l = []; try { l = fs.readdirSync(d).slice(0, GOAL_DIRS_SCAN_MAX * 4); } catch { l = []; }
      for (const n of l) if (n.endsWith('.json') && VID_RE.test(n.slice(0, -5))) names.push({ id: n.slice(0, -5), f: path.join(d, n) });
    }
    names.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    const byId = new Map(), keep = new Set();
    let sig = '';
    for (const { id, f } of names.slice(0, VERDICT_SCAN_MAX)) {
      let st = null; try { st = fs.lstatSync(f); } catch { st = null; }
      if (!st || !st.isFile() || st.size > VERDICT_FILE_MAX) continue; // symlinks and oversized files are skipped
      const s = sigOf(st); let e = verdictEntries.get(f);
      if (!e || e.sig !== s) { let j; try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { j = undefined; } e = { sig: s, v: verdictOf(j, id), m: st.mtimeMs }; verdictEntries.set(f, e); }
      keep.add(f);
      if (!e.v) continue;
      const o = byId.get(id); if (!o || e.m > o.m) byId.set(id, e);
      sig += f + '=' + s + ';';
    }
    for (const k of [...verdictEntries.keys()]) if (!keep.has(k)) verdictEntries.delete(k);
    const list = [...byId.values()].map((e) => e.v).sort((a, b) => (a.view.id < b.view.id ? 1 : a.view.id > b.view.id ? -1 : (b.view.created_at || '').localeCompare(a.view.created_at || '')));
    verdictsView = { list, sig };
  } catch { /* keep the previous view */ }
  return verdictsView;
}
// session agents (label -> sid8, from the fold) get the newest verdict of their session; the verdict gets the agent label back
function verdictLinks(sidOf) {
  const bySid = new Map(), agentOf = new Map();
  for (const [label, sid] of sidOf) if (sid && sid !== 'unknown') bySid.set(sid.slice(0, 8), label);
  const guardOf = new Map();
  for (const v of verdictsIndex().list) { const label = v.sid8 ? bySid.get(v.sid8) : null; if (!label) continue; agentOf.set(v.view.id, label); if (!guardOf.has(label)) guardOf.set(label, { id: v.view.id, verdict: v.view.verdict, kind: v.view.kind, created_at: v.view.created_at, repo_name: v.view.repo_name }); }
  return { agentOf, guardOf };
}
const withAgent = (v, agentOf) => (agentOf.has(v.id) ? { ...v, agent: agentOf.get(v.id) } : v);
let liveSidOf = new Map(); // label -> sid of the live sessions in the newest live /api/state (for /api/verdicts links)
function verdictList(sidOf, limit) { const { agentOf } = verdictLinks(sidOf); return verdictsIndex().list.slice(0, limit).map((v) => withAgent(v.view, agentOf)); }
// /api/state summary: counts over the verdicts read + the newest verdict per repo (repos keyed by full path internally, newest first)
function verdictSummary(agentOf) {
  const list = verdictsIndex().list, seen = new Set(), latest = [], c = { verified: 0, integrity: 0, capability: 0 };
  for (const v of list) {
    c[v.view.verdict]++;
    const k = v.repo || 'name:' + v.view.repo_name; if (seen.has(k) || latest.length >= VERDICT_LATEST_MAX) continue; seen.add(k);
    const x = v.view; latest.push(withAgent({ id: x.id, created_at: x.created_at, repo_name: x.repo_name, verdict: x.verdict, kind: x.kind, rejections: x.rejections.length, failing_tests: x.failing_tests.length, source: x.source }, agentOf));
  }
  return { total: list.length, verified: c.verified, integrity: c.integrity, capability: c.capability, latest };
}

// ---------- fold ----------
const FOLD_N = 5000, WIN_MS = 5 * 60 * 1000, OPEN_MAX_MS = 30 * 60 * 1000;
const MAIN_RUN = new Set(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure']); // main-session events that open a run segment
const runS = (ms) => Math.max(0, Math.round(ms / 1000));
const tokPerMin = (rs, u, have) => (have && rs >= 10 ? Math.round((u.input + u.output + u.cache_write) / (rs / 60)) : null);
const NI_IGNORE = new Set(['idle_prompt', 'auth_success', 'elicitation_complete', 'elicitation_response', 'quota_auto_resume_fired', 'quota_auto_resume_stale', 'quota_auto_resume_disabled', 'agent_completed']);

function fold(list, ref) {
  const C = cfg(), onSet = new Set(C.notify.on);
  const sessions = new Map(), subs = new Map(), events = [], alerts = [], markers = [], files = new Map(), collided = new Map();
  const cw = new Map(); // sid -> Map(cwd basename -> event count); Map order = first seen, used for the project tie-break
  const cwp = new Map(); // sid -> Map(cwdp -> event count): full cwd paths, used only for project roots
  const ev = (ts, type, actor, task_id, data) => events.push({ ts, seq: 0, type, actor, goal_id: GOAL_ID, task_id, data });
  const alert = (ms, kind, agent, text) => {
    if (kind !== 'needs_input' && kind !== 'stuck' && !onSet.has(kind)) return;
    const ts = new Date(ms).toISOString(); alerts.push({ ts, kind, agent, text }); ev(ts, 'alert', agent, null, { kind, text });
  };
  const mk = (ms, type) => markers.push({ ts: new Date(ms).toISOString(), type });
  const subsRunning = (sid) => { for (const x of subs.values()) if (x.sid === sid && !x.done) return true; return false; };
  const mkTools = () => ({ pend: [], recent: [] });
  const tickMap = new Map(); // actor label -> activity timestamps (ms, >=15 s apart, newest 300) for the timeline's heartbeat ticks
  const tick = (label, t) => { let a = tickMap.get(label); if (!a) tickMap.set(label, a = []); if (!a.length || t - a[a.length - 1] >= 15000) { a.push(t); if (a.length > 300) a.shift(); } };
  const closeTool = (T, name, t) => {
    let i = -1; for (let j = T.pend.length - 1; j >= 0; j--) if (T.pend[j].name === name) { i = j; break; }
    const e = i >= 0 ? T.pend.splice(i, 1)[0] : null;
    T.recent.push({ ts: new Date(e ? e.t : t).toISOString(), name, summary: e ? e.summary : '', ms: e ? t - e.t : null });
    if (T.recent.length > 15) T.recent.shift();
  };
  // stuck threshold (ms) for an actor, by its transcript's model family; unknown model (no transcript yet) = base threshold
  const thrMs = (sid, aid) => { const p = trPath(sid, aid || null), tr = p ? pump(p) : null, fam = modelFam(tr && tr.model); return (fam ? C.byModel[fam] : C.stuck) * 1000; };
  // errored state: a StopFailure (a.err) clears on success; tool failures (a.tkind) need 3 in a row or a failure followed by 60s of silence
  const okEv = (a) => { a.err = null; a.tn = 0; a.tkind = null; };
  const errOf = (a, ref, label) => {
    if (a.err) return a.err;
    if (!a.tkind) return null;
    if ((a.tn || 0) >= C.errRunLen) return a.tkind;
    if (a.evFail && ref - a.evT >= C.errIdleS * 1000) { const at = a.evT + C.errIdleS * 1000; alert(at, 'error', label, `${label} tool failed (${a.tkind}) and went quiet`); mk(at, 'error'); return a.tkind; }
    return null;
  };
  const recentF = (a, ref) => { let n = 0; for (const x of a.ft || []) if (x <= ref && x > ref - C.errWinMs) n++; return n; };
  // inactivity gap check before an actor's next activity at t
  const gapCheck = (a, label, t, running, sid, aid) => {
    if (!running || a.wait || !a.act || t - a.act <= C.minStuck * 1000) return;
    const thr = thrMs(sid, aid) * (a.tools.pend.length ? 2 : 1);
    if (t - a.act > thr) { alert(a.act + thr, 'stuck', label, `${label} had no activity for ${Math.round(thr / 1000)}s`); mk(a.act + thr, 'stuck'); }
  };
  const touchFile = (f, label, t) => {
    let m = files.get(f);
    if (!m) { m = new Map(); files.set(f, m); if (files.size > 2000) files.delete(files.keys().next().value); }
    for (const [who, ts] of m) if (who !== label && t - ts <= WIN_MS) {
      const lc = collided.get(f); if (!lc || t - lc > WIN_MS) { collided.set(f, t); mk(t, 'collision'); }
      break;
    }
    m.delete(label); m.set(label, t);
  };

  for (const r of list) {
    const t = Date.parse(r.ts), sid = r.sid || 'unknown', name = r.ev;
    let s = sessions.get(sid);
    if (!s) { s = { sid, cwd: r.cwd || '', id: 'Claude Code·' + sid.slice(0, 4), last: t, active: 0, ended: false, act: 0, wait: false, tools: mkTools(), first: t, seg: null, closed: 0 }; sessions.set(sid, s); }
    if (r.cwd) s.cwd = r.cwd;
    if (typeof r.cwd === 'string') { const c = r.cwd.trim().slice(0, 200); if (c) { let m = cw.get(sid); if (!m) cw.set(sid, m = new Map()); m.set(c, (m.get(c) || 0) + 1); } }
    const cp = normCwdp(r.cwdp); if (cp) { let m = cwp.get(sid); if (!m) cwp.set(sid, m = new Map()); m.set(cp, (m.get(cp) || 0) + 1); }
    if (name === 'SessionStart' && r.m && !s.mdl) s.mdl = r.m;
    if (typeof r.gid === 'string' && TAG_RE.test(r.gid) && !s.gid) { s.gid = r.gid; if (typeof r.tid === 'string' && TAG_RE.test(r.tid)) s.tid = r.tid; } // worker tag set by the orchestrator engine
    const prevLast = s.last;
    s.last = t;
    const sub = r.agent_id ? subs.get(sid + ':' + r.agent_id) : null;
    const actor = sub || s, label = sub ? sub.id : s.id;
    tick(label, t);
    const wasFail = !!actor.evFail; actor.evT = t; actor.evFail = false; // last event of this actor (errored rule c)
    if (!r.agent_id) { // main session run segments: prompt/tool activity -> Stop; a silent gap longer than RUN_S ends the run (idle time not counted)
      if (s.seg !== null && t - prevLast > RUN_S * 1000) { s.closed += Math.max(0, prevLast - s.seg); s.seg = null; }
      if (name === 'Stop' || name === 'StopFailure' || name === 'SessionEnd') { if (s.seg !== null) { s.closed += Math.max(0, t - s.seg); s.seg = null; } }
      else if (s.seg === null && (MAIN_RUN.has(name) || (t === s.first && name !== 'SessionStart'))) s.seg = t;
    }
    const isAct = name === 'PreToolUse' || name === 'PostToolUse' || name === 'UserPromptSubmit' || name === 'SessionStart' || name === 'SubagentStart' || name === 'Notification' || name === 'PermissionRequest' || name === 'PostToolUseFailure';
    if (isAct && name !== 'SubagentStart' && name !== 'SessionStart') gapCheck(actor, label, t, sub ? !sub.done : (s.active > 0 && !subsRunning(sid)), sid, sub ? sub.aid : null);
    if (name === 'SessionStart') { s.ended = false; s.act = t; mk(t, 'session.start'); ev(r.ts, 'agent.spawned', s.id, null, { agent: s.id, role: 'main session', cwd: s.cwd }); }
    else if (name === 'SessionEnd') s.ended = true;
    else if (name === 'Stop') {
      s.active = 0; s.tools.pend = []; s.wait = false; okEv(s);
      alert(t, 'session_done', s.id, `${s.id} finished its turn`);
    }
    else if (name === 'UserPromptSubmit') { s.active = t; s.act = t; s.wait = false; okEv(s); ev(r.ts, 'human.note', 'human', null, { text: 'prompt submitted', session: s.id }); }
    else if (name === 'StopFailure') {
      const k = r.err || 'unknown'; s.active = 0; s.tools.pend = []; s.wait = false; s.err = k;
      mk(t, 'error');
      alert(t, 'error', s.id, `${s.id} turn failed (${k})`);
    }
    else if (name === 'PostToolUseFailure') {
      if (sub) { sub.last = t; if (s.active) s.active = t; } else s.active = t;
      actor.act = t; actor.wait = false; closeTool(actor.tools, r.tool || '?', t);
      if (r.err !== 'interrupted') {
        // a single failure is routine noise: errored only after 3 in a row, or one followed by 60s of silence (see errOf)
        const k = (r.tool ? String(r.tool).slice(0, 40) + ':' : '') + (r.err || 'tool_failed');
        actor.tkind = k; actor.tn = (actor.tn || 0) + 1; actor.evFail = true;
        (actor.ft = actor.ft || []).push(t); if (actor.ft.length > 200) actor.ft.shift();
        if (actor.tn === C.errRunLen) { alert(t, 'error', label, `${label} tool failed (${k}) ${C.errRunLen} times in a row`); mk(t, 'error'); }
      }
    }
    else if (name === 'PermissionRequest') {
      actor.act = t; actor.wait = true;
      alert(t, 'needs_input', label, `${label} needs input (permission_request)`);
    }
    else if (name === 'TaskCreated' || name === 'TaskCompleted') {
      ev(r.ts, name === 'TaskCreated' ? 'task.created' : 'task.completed', label, null, { agent: label, ...(r.task ? { claude_task: r.task } : {}), source: 'claude-code-task-list' });
    }
    else if (name === 'PreModelSwitch' || name === 'PostModelSwitch') {
      if (name === 'PostModelSwitch' && r.m) actor.mdl = r.m;
    }
    else if (name === 'Notification') {
      actor.act = t;
      // ignored types are not a user wait; leaving wait set hides a later stuck
      if (!r.nt || !NI_IGNORE.has(r.nt)) {
        actor.wait = true;
        alert(t, 'needs_input', label, `${label} needs input${r.nt ? ' (' + r.nt + ')' : ''}`);
      }
    }
    else if (name === 'PreToolUse' || name === 'PostToolUse') {
      if (name === 'PreToolUse' && (r.tool === 'Agent' || r.tool === 'Task') && r.sum && !r.agent_id) (s.pend = s.pend || []).push(String(r.sum));
      if (sub) { sub.last = t; if (s.active) s.active = t; } else s.active = t;
      actor.act = t; actor.wait = false;
      if (name === 'PreToolUse') {
        actor.tools.pend.push({ name: r.tool || '?', summary: r.sum || '', t });
        if (actor.tools.pend.length > 20) actor.tools.pend.shift();
        if (r.f) { touchFile(r.f, label, t); }
      } else { closeTool(actor.tools, r.tool || '?', t); okEv(actor); }
    } else if (name === 'SubagentStart' && r.agent_id) {
      const k = sid + ':' + r.agent_id, prev = subs.get(k), desc = prev ? '' : (s.pend && s.pend.shift()) || '', id = prev ? prev.id : (desc || r.agent_type || 'subagent') + '·' + String(r.agent_id).slice(0, 4); // resumed agents keep their name
      if (prev) { prev.done = false; okEv(prev); prev.last = t; prev.act = t; prev.wait = false; if (prev.segOpen === null) prev.segOpen = t; }
      else subs.set(k, { id, sid, aid: r.agent_id, role: r.agent_type || 'subagent', title: r.agent_type || 'subagent', start: t, last: t, act: t, wait: false, done: false, ts: r.ts, tools: mkTools(), segOpen: t, ranMs: 0, endMs: null });
      ev(r.ts, 'agent.spawned', s.id, 't-' + id, { agent: id, role: r.agent_type || 'subagent', parent: s.id });
      ev(r.ts, 'task.started', id, 't-' + id, { title: r.agent_type || 'subagent' });
      mk(t, 'agent.spawned'); mk(t, 'task.started');
    } else if (name === 'SubagentStop' && r.agent_id) {
      if (sub) { sub.done = true; sub.failed = !!(sub.err || wasFail || (sub.tn || 0) >= C.errRunLen); sub.last = t; sub.end = r.ts; sub.endMs = t; if (sub.segOpen !== null) { sub.ranMs += Math.max(0, t - sub.segOpen); sub.segOpen = null; } sub.tools.pend = []; ev(r.ts, 'task.completed', sub.id, 't-' + sub.id, { agent: sub.id }); mk(t, 'task.completed'); alert(t, 'agent_done', sub.id, `${sub.id} finished`); }
    }
  }

  const iso = (ms) => new Date(ms).toISOString();
  const cut = ref - WIN_MS;
  const touched = new Map(); // label -> [{f,ts}]
  const collisions = [];
  for (const [f, m] of files) {
    const live = [...m].filter(([, ts]) => ts >= cut && ts <= ref);
    for (const [who, ts] of live) { if (!touched.has(who)) touched.set(who, []); touched.get(who).push({ f, ts }); }
    // file: parent folder + basename only, never the full path
    if (live.length >= 2) collisions.push({ file: path.join(path.basename(path.dirname(f)), path.basename(f)), name: path.basename(f), agents: live.map(([w]) => w), ts: iso(Math.max(...live.map(([, ts]) => ts))) });
  }
  collisions.sort((a, b) => (a.ts < b.ts ? 1 : -1));
  const filesOf = (label) => { const seen = new Set(), out = []; for (const x of (touched.get(label) || []).sort((a, b) => b.ts - a.ts)) { const b = path.basename(x.f); if (!seen.has(b)) { seen.add(b); out.push(b); } if (out.length >= 8) break; } return out; };
  const toolView = (a) => {
    const p = a.tools.pend.filter((e) => ref - e.t < OPEN_MAX_MS), cur = p.length ? p[p.length - 1] : null;
    return { current_tool: cur ? { name: cur.name, summary: cur.summary, ts: iso(cur.t) } : null, recent_tools: a.tools.recent.slice(-15), open: p.length > 0 };
  };
  const used = new Set(); // transcript paths of agents seen, for cost totals
  const usageOf = (sid, aid) => {
    const p = trPath(sid, aid), t = p ? pump(p) : null;
    if (p) used.add(p);
    if (!t) return { model: null, effort: null, have: false, usage: { ...zero(), usd_est: null } };
    let est = 0, any = false;
    for (const [m, u] of Object.entries(t.by)) { const v = usd(u, m); if (v !== null) { est += v; any = true; } }
    return { model: t.model, effort: t.effort, have: true, usage: { ...t.tot, usd_est: any ? Math.round(est * 1e6) / 1e6 : null } };
  };
  const stuckOf = (a, label, running, blocked) => {
    if (!running || a.wait || blocked) return null;
    const thr = thrMs(a.sid, a.aid) * (a.tools.pend.length ? 2 : 1), idle = ref - a.act;
    if (a.act && idle > thr) { alert(a.act + thr, 'stuck', label, `${label} has had no activity for ${Math.round(thr / 1000)}s`); mk(a.act + thr, 'stuck'); return Math.round(idle / 1000); }
    return null;
  };

  // project = the root of the directory tree a session worked in (deriveRoot over its cwdp counts);
  // sessions with no cwdp fall back to the modal cwd basename. Subagents share their parent session's sid, so they inherit its project
  const projOf = new Map();
  const pOf = (sid) => {
    let p = projOf.get(sid);
    if (!p) {
      const gs = sessions.get(sid), repo = gs && gs.gid ? goalRepo(gs.gid) : null; // tagged worker: the goal's repo is the project, not its worktree
      if (repo) { const root = repo.replace(/\/+$/, '') || '/', base = path.basename(root); p = { key: 'p:' + root, root, base, alias: C.projects.get(root) || C.projects.get(base) || null }; }
      else p = projectInfo(sid, cwp.get(sid), cw.get(sid), C);
      projOf.set(sid, p);
    }
    return p;
  };
  const sessLive = (s) => !(s.ended || ref - s.last > SESSION_TTL_S * 1000);
  // a done subagent stays in view only while its session does (the UI also hides one finished longer than its grace); an orphaned run is dropped rather than claimed running
  const subLive = (sub) => (sub.done ? sessLive(sessions.get(sub.sid) || { ended: true, last: 0 }) : !(ref - sub.last > STALE_SUB_S * 1000 || (sessions.get(sub.sid) || {}).ended));
  // state.projects order: first appearance of each project's sessions
  const rank = new Map();
  for (const s of sessions.values()) { const k = pOf(s.sid).key; if (!rank.has(k)) rank.set(k, rank.size); }
  const visible = new Map(); // project key -> info, for projects with agents in this view
  for (const s of sessions.values()) if (sessLive(s)) { const p = pOf(s.sid); visible.set(p.key, p); }
  for (const sub of subs.values()) if (subLive(sub)) { const p = pOf(sub.sid); visible.set(p.key, p); }
  const fin = finalNames(visible, rank);
  const PF = (p) => fin.get(p.key) || { name: p.alias || p.base, id: slug(p.alias || p.base) };

  const agents = [], tasks = [], sidOf = new Map(); // session agent label -> sid (exact OTel cost is keyed by session.id)
  for (const s of sessions.values()) {
    if (!sessLive(s)) continue;
    const running = s.active > 0 && ref - s.active < RUN_S * 1000; // turn open (prompt -> Stop), idle after 15 min of silence
    const tv = toolView(s), u = usageOf(s.sid, null), sf = stuckOf(s, s.id, running, subsRunning(s.sid)), p = pOf(s.sid), ek = errOf(s, ref, s.id);
    sidOf.set(s.id, s.sid);
    const ranMs = s.closed + (s.seg !== null ? Math.max(0, (running ? ref : s.last) - s.seg) : 0), ran = runS(ranMs);
    agents.push({ id: s.id, role: `orchestrator: Claude Code session${s.cwd ? ' in ' + s.cwd : ''}`, capabilities: ['claude-code'], can_delegate: true,
      status: ek ? 'errored' : running ? 'running' : 'idle', error_kind: ek, recent_failures: recentF(s, ref), current_task: null, last_event_at: iso(s.last),
      current_tool: tv.current_tool, recent_tools: tv.recent_tools, model: u.model, model_label: modelLabel(s.mdl) || modelLabel(u.model), ...(u.effort ? { effort: u.effort } : {}), usage: u.usage, files: filesOf(s.id),
      stuck: sf !== null, ...(sf !== null ? { stuck_for_s: sf } : {}), project: PF(p).name, project_id: PF(p).id,
      started_at: iso(s.first), ended_at: running ? null : iso(s.last), ran_s: ran, tok_per_min: tokPerMin(ran, u.usage, u.have), ...tierCheck(s.gid, s.tid, u.model || s.mdl), ...scopeCheck(s.gid, s.tid), ...(s.gid ? { goal_id: s.gid, ...(s.tid ? { task_id: s.tid } : {}), ...(goalTitle(s.gid) ? { goal_title: goalTitle(s.gid) } : {}) } : {}), });
  }
  for (const sub of subs.values()) {
    if (!subLive(sub)) continue;
    const ps = sessions.get(sub.sid) || {}, open = !sub.done, tv = toolView(sub), u = usageOf(sub.sid, sub.aid), sf = stuckOf(sub, sub.id, open, false), p = pOf(sub.sid);
    // a stopped/killed subagent never sends SubagentStop: once silent past the stuck threshold show it as stalled, not running
    const silent = open && sf !== null, running = open && !silent, ek = errOf(sub, ref, sub.id);
    // a killed subagent never stops: its open run segment ends at its last event; ran_s sums every run segment
    const ranMs = sub.ranMs + (sub.segOpen !== null ? Math.max(0, (silent ? sub.last : ref) - sub.segOpen) : 0), ran = runS(ranMs);
    // a subagent that sent SubagentStop is finished and listens for nothing, so it is `done`; `idle` stays the session's word (it waits for input)
    agents.push({ id: sub.id, role: sub.role, capabilities: [], can_delegate: false, status: ek ? 'errored' : running ? 'running' : silent ? 'stalled' : 'done', error_kind: ek, recent_failures: recentF(sub, ref),
      current_task: open ? 't-' + sub.id : null, last_event_at: iso(sub.last),
      current_tool: tv.current_tool, recent_tools: tv.recent_tools, model: u.model, model_label: modelLabel(sub.mdl) || modelLabel(u.model), ...(u.effort ? { effort: u.effort } : {}), usage: u.usage, files: filesOf(sub.id),
      stuck: sf !== null, ...(sf !== null ? { stuck_for_s: sf } : {}), project: PF(p).name, project_id: PF(p).id,
      started_at: iso(sub.start), ended_at: sub.done ? iso(sub.endMs) : silent ? iso(sub.last) : null, ran_s: ran, tok_per_min: tokPerMin(ran, u.usage, u.have), ...(ps.gid ? { goal_id: ps.gid, ...(ps.tid ? { task_id: ps.tid } : {}), ...scopeCheck(ps.gid, ps.tid), ...(goalTitle(ps.gid) ? { goal_title: goalTitle(ps.gid) } : {}) } : {}), });
    tasks.push({ id: 't-' + sub.id, goal_id: GOAL_ID, title: sub.title, assignee: sub.id, status: sub.done && sub.failed ? 'failed' : running ? 'running' : silent ? 'stalled' : 'done',
      depends_on: [], attempts: 1, max_attempts: 1, inputs: {}, output_contract: 'n/a (observed)', acceptance: ['Observed'],
      artifacts: [], created_at: sub.ts, updated_at: iso(sub.last) });
  }
  for (const c of collisions) mk(Date.parse(c.ts), 'collision_active');

  // state.projects: one row per project with agents in this view
  const rankById = new Map();
  for (const [k, f] of fin) rankById.set(f.id, rank.get(k));
  const pg = new Map();
  for (const a of agents) {
    let g = pg.get(a.project_id);
    if (!g) { g = { id: a.project_id, name: a.project, agents: [], total: 0, running: 0, stalled: 0, errored: 0, last_event_at: a.last_event_at, ran_s_total: 0 }; pg.set(a.project_id, g); }
    g.agents.push(a.id); g.total++; g.ran_s_total += a.ran_s;
    if (a.status === 'running' || a.status === 'stalled' || a.status === 'errored') g[a.status]++;
    if (a.last_event_at > g.last_event_at) g.last_event_at = a.last_event_at;
  }
  const projects = [...pg.values()].sort((a, b) => rankById.get(a.id) - rankById.get(b.id));
  const labelName = new Map(); // agent label -> project display name, for alerts
  for (const s of sessions.values()) labelName.set(s.id, PF(pOf(s.sid)).name);
  for (const sub of subs.values()) labelName.set(sub.id, PF(pOf(sub.sid)).name);
  for (const a of alerts) a.project = labelName.get(a.agent) || 'unknown';

  // cost: totals across every transcript referenced by agents in this window (incl. finished ones)
  const by_model = Object.create(null), tot = zero(); // model ids come from transcripts: no prototype keys
  for (const p of used) { const t = TR.get(p); if (!t) continue; for (const [m, u] of Object.entries(t.by)) add(by_model[m] = by_model[m] || { ...zero(), _p: 1 }, u); }
  let total = 0, anyP = false;
  for (const [m, u] of Object.entries(by_model)) { delete u._p; add(tot, u); const v = usd(u, m); u.usd_est = v; if (v !== null) { total += v; anyP = true; } }
  const cost = { total_usd_est: anyP ? Math.round(total * 1e6) / 1e6 : null, tokens_total: tot.input + tot.output + tot.cache_read + tot.cache_write, by_model };

  events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0)); events.forEach((e, i) => { e.seq = i; });
  alerts.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return { agents, tasks, events, alerts, collisions, cost, markers, projects, tickMap, sidOf };
}

function assemble(list, ref, replay) {
  const f = fold(list, ref);
  const newest = list.length ? list[list.length - 1].ts : null;
  const age = newest ? (ref - Date.parse(newest)) / 1000 : null;
  const liveness = age === null ? 'dead' : age < 1.5 * INTERVAL_S ? 'alive' : age < 3 * INTERVAL_S ? 'late' : 'dead';
  const first = list.length ? list[0].ts : new Date(ref).toISOString();
  const out = {
    goal: { id: GOAL_ID, title: 'Live Claude Code activity', description: 'Read-only view of Claude Code hook events.', status: 'active',
      success_criteria: [{ id: 'c1', text: 'Observing', met: false }], budget: { max_ticks: 1000000 },
      created_at: first, updated_at: newest || first },
    tasks: f.tasks, agents: f.agents, projects: f.projects,
    heartbeat: { seq: list.length, ts: newest, interval_s: INTERVAL_S, status: 'running', liveness, age_s: age === null ? null : Math.round(age * 10) / 10,
      last_tick_ms: 0, consecutive_errors: 0 },
    events: f.events.slice(-200),
    server_time: new Date(ref).toISOString(),
    mode: 'live',
    cost: f.cost, collisions: f.collisions, alerts: f.alerts.slice(-20),
  };
  if (replay) out.replay = true;
  else { // replay omits goals, guard verdicts and OTel cost (not time-sliced)
    out.goals = withWorkers(goalSummaries(STATE_GOALS_MAX), f.agents);
    liveSidOf = f.sidOf; const vl = verdictLinks(f.sidOf); out.verdicts = verdictSummary(vl.agentOf);
    if (vl.guardOf.size) out.agents = out.agents.map((a) => (vl.guardOf.has(a.id) ? { ...a, guard: vl.guardOf.get(a.id) } : a));
    withExactCost(out, f.sidOf);
  }
  return out;
}

// ---------- exact cost from Claude Code's OpenTelemetry metrics (optional; docs/otel.md) ----------
const OTEL = createOtelStore();
function withExactCost(out, sidOf) {
  const ex = OTEL.summary(new Set(sidOf.values()));
  if (!ex) return;
  const live = new Set(sidOf.values()).size;
  out.cost = { ...out.cost, exact: { ...ex, live_sessions: live, complete: ex.sessions >= live } }; // complete: every session in view sends telemetry
  out.agents = out.agents.map((a) => { const sid = sidOf.get(a.id), v = sid ? ex.by_session[sid] : undefined; return v === undefined ? a : { ...a, usage: { ...a.usage, usd_exact_session: v } }; });
}
function receiveMetrics(req, res) {
  if (req.method !== 'POST') { req.resume(); return send(res, 405, { error: 'method not allowed' }); }
  if (req.headers['content-encoding'] && !/^identity$/i.test(String(req.headers['content-encoding']))) { req.resume(); return send(res, 415, { error: 'send uncompressed: unset OTEL_EXPORTER_OTLP_COMPRESSION' }); }
  if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) { req.resume(); return send(res, 415, { error: 'send OTLP as JSON: OTEL_EXPORTER_OTLP_PROTOCOL=http/json' }); }
  const chunks = []; let n = 0, over = false;
  req.on('data', (d) => { if (over) return; n += d.length; if (n > OTEL_BODY_MAX) { over = true; send(res, 413, { error: 'too large' }); req.resume(); return; } chunks.push(d); });
  req.on('end', () => {
    if (over) return;
    let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(res, 400, { error: 'bad json' }); }
    const r = OTEL.ingest(body);
    if (!r.ok) return send(res, 400, { error: r.error });
    liveCache = { key: '', v: null };
    send(res, 200, {}); // ExportMetricsServiceResponse: full success
  });
  req.on('error', () => {});
}

let liveCache = { key: '', v: null };
function build() {
  ingest();
  const now = Date.now(), key = ingestSig + ':' + Math.floor(now / 1000) + ':' + goalsIndex().sig + ':' + verdictsIndex().sig;
  if (liveCache.key === key) return liveCache.v;
  const v = assemble(recs.slice(-FOLD_N), now, false);
  liveCache = { key, v };
  return v;
}
let atCache = { key: '', v: null };
function buildAt(atMs) {
  ingest();
  const key = ingestSig + ':' + atMs + ':' + goalsIndex().sig;
  if (atCache.key === key) return atCache.v;
  let end = recs.length; while (end > 0 && Date.parse(recs[end - 1].ts) > atMs) end--;
  const v = assemble(recs.slice(Math.max(0, end - FOLD_N), end), atMs, true);
  atCache = { key, v };
  return v;
}
// Timeline (waterfall): one row per agent visible at `ref` (live, or the replayed slice for ?at=), same fold as /api/state
let tlCache = { key: '', v: null };
function timeline(atMs) {
  ingest();
  const key = ingestSig + ':' + (atMs || 'live') + ':' + (atMs ? '' : Math.floor(Date.now() / 1000));
  if (tlCache.key === key) return tlCache.v;
  const ref = atMs || Date.now();
  let end = recs.length; if (atMs) while (end > 0 && Date.parse(recs[end - 1].ts) > atMs) end--;
  const f = fold(recs.slice(Math.max(0, end - FOLD_N), end), ref);
  const rows = f.agents.filter((a) => a.started_at).map((a) => ({ id: a.id, role: ctl(a.role, 60), kind: a.capabilities && a.capabilities.length ? 'session' : 'subagent', project: a.project,
    status: a.status, start: a.started_at, end: a.ended_at, ticks: (f.tickMap.get(a.id) || []).filter((t) => t >= Date.parse(a.started_at) && t <= ref),
    ...(a.goal_id ? { goal_id: a.goal_id, ...(a.task_id ? { task_id: a.task_id } : {}) } : {}) }))
    .sort((x, y) => (x.start < y.start ? -1 : x.start > y.start ? 1 : x.id < y.id ? -1 : 1)).slice(0, 300);
  const from = rows.length ? Math.min(...rows.map((r) => Date.parse(r.start))) : ref;
  const v = { from: new Date(from).toISOString(), to: new Date(ref).toISOString(), replay: !!atMs, rows };
  tlCache = { key, v };
  return v;
}
let histCache = { key: '', v: null };
function history(limit) {
  ingest();
  const key = ingestSig + ':' + limit + ':' + Math.floor(Date.now() / 5000);
  if (histCache.key === key) return histCache.v;
  const list = recs, f = fold(list, Date.now());
  const seen = new Set(), ms = [];
  for (const m of f.markers.sort((a, b) => (a.ts < b.ts ? -1 : 1))) { const k = m.ts + m.type; if (m.type !== 'collision_active' && !seen.has(k)) { seen.add(k); ms.push(m); } }
  let out = ms;
  if (ms.length > limit) {
    const prio = ms.filter((m) => m.type === 'collision' || m.type === 'stuck' || m.type === 'session.start').slice(0, limit), rest = ms.filter((m) => !prio.includes(m));
    const room = Math.max(0, limit - prio.length), step = rest.length / Math.max(1, room), pick = [];
    for (let i = 0; i < room; i++) pick.push(rest[Math.floor(i * step)]);
    out = prio.concat(pick).sort((a, b) => (a.ts < b.ts ? -1 : 1));
  }
  const v = { first_ts: list.length ? list[0].ts : null, last_ts: list.length ? list[list.length - 1].ts : null, count: list.length, markers: out };
  histCache = { key, v };
  return v;
}

// ---------- notifier (macOS osascript via execFile, args never shell-interpolated) ----------
const notifyStart = Date.now(), notified = new Set(), lastSent = new Map(), queue = [];
const NOTIFY_SCRIPT = 'on run argv\ndisplay notification (item 1 of argv) with title (item 2 of argv)\nend run';
const NOTIFY_SOUND_SCRIPT = 'on run argv\ndisplay notification (item 1 of argv) with title (item 2 of argv) sound name "Glass"\nend run';
// branded notifier (plugin/notify/aos-notify.mjs), loaded lazily once; null when absent or broken
const NOTIFY_MODULES = ['notify/aos-notify.mjs', 'plugin/notify/aos-notify.mjs'].map((r) => path.join(ROOT, r));
let notifierP = null;
function loadNotifier() {
  if (!notifierP) notifierP = (async () => {
    try {
      const file = process.env.AOS_NOTIFY_MODULE || NOTIFY_MODULES.find((f) => fs.existsSync(f));  // AOS_NOTIFY_MODULE: test-only override
      if (!file || !fs.existsSync(file)) return null;
      const mod = await import(pathToFileURL(file).href);
      return mod && typeof mod.notify === 'function' && typeof mod.formatNotification === 'function' ? mod : null;
    } catch { return null; }
  })();
  return notifierP;
}
// old path: osascript via execFile, args never shell-interpolated
function sendNotifyLegacy(kind, text, sound) {
  const title = 'AOS: ' + kind.replace('_', ' '), msg = String(text).replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 200);
  if (process.env.AOS_NOTIFY_DRY === '1') { console.log(`[notify:dry] ${kind} | ${msg}`); return; }
  try { execFile('osascript', ['-e', sound ? NOTIFY_SOUND_SCRIPT : NOTIFY_SCRIPT, msg, title], { timeout: 5000 }, () => {}); } catch {}
}
// a: the alert object (kind, text, agent, project); the branded notifier gets it whole, falling back to osascript on any failure
function sendNotify(a, sound) {
  const kind = String(a.kind), text = String(a.text);
  const opts = { kind, agent: a.agent, text, project: a.project && a.project !== 'unknown' ? a.project : undefined }; // display names only, never paths
  loadNotifier().then((mod) => {
    if (!mod) return sendNotifyLegacy(kind, text, sound);
    if (process.env.AOS_NOTIFY_DRY === '1') {
      const f = mod.formatNotification(opts);
      console.log(`[notify:dry] ${kind} | title=${JSON.stringify(f.title)} | subtitle=${JSON.stringify(f.subtitle)} | message=${JSON.stringify(f.message)}`);
      return;
    }
    return Promise.resolve(mod.notify({ ...opts, sound })).then((r) => { if (!r || !r.ok) sendNotifyLegacy(kind, text, sound); });
  }).catch(() => { try { sendNotifyLegacy(kind, text, sound); } catch {} });
}
function notifyTick() {
  try {
    const C = cfg().notify;
    if (!C.enabled) return;
    const st = build();
    for (const a of st.alerts) {
      const id = a.kind + '|' + a.agent + '|' + a.ts;
      if (notified.has(id)) continue;
      notified.add(id); if (notified.size > 2000) notified.delete(notified.values().next().value);
      if (Date.parse(a.ts) < notifyStart || !C.on.includes(a.kind)) continue;
      if (queue.length < 20) queue.push(a);
    }
    const now = Date.now();
    for (let i = 0; i < queue.length;) {
      const a = queue[i], last = lastSent.get(a.kind);
      if (last && last.text === a.text && now - last.t < 60000) { queue.splice(i, 1); continue; } // dedup identical
      if (last && now - last.t < 10000) { i++; continue; } // rate limit: 1 per 10s per kind
      lastSent.set(a.kind, { t: now, text: a.text }); queue.splice(i, 1);
      sendNotify(a, C.sound);
    }
  } catch {}
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { ...HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function hostAllowed(req) {
  const ok = (h) => /^(127\.0\.0\.1|localhost)$/.test(h);
  try {
    if (!ok(new URL('http://' + (req.headers.host || '')).hostname)) return false;
    if (req.headers.origin && !ok(new URL(req.headers.origin).hostname)) return false;
    return true;
  } catch { return false; }
}
function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return send(res, 400, { error: 'bad path' }); }
  if (rel.includes('\0') || rel.includes('\\')) return send(res, 400, { error: 'bad path' });
  if (rel.split('/').some((s) => s.startsWith('.'))) return send(res, 404, { error: 'not found' });
  let file = path.resolve(UI, '.' + rel);
  if (file !== UI && !file.startsWith(UI + path.sep)) return send(res, 403, { error: 'forbidden' });
  try {
    if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    const real = fs.realpathSync(file);
    if (!real.startsWith(fs.realpathSync(UI) + path.sep)) return send(res, 403, { error: 'forbidden' });
    const stat = fs.statSync(real);
    res.writeHead(200, { ...HEADERS, 'Content-Type': MIME[path.extname(real).toLowerCase()] || 'application/octet-stream', 'Content-Length': stat.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(real).on('error', () => res.destroy()).pipe(res);
  } catch { send(res, 404, { error: 'not found' }); }
}

// ---------- cross-machine (opt-in, read-only; polls other dashboards over ssh, opens no port) ----------
let collector = null, collectorKey = null, cfgStamp = null;
function remoteCollector() {
  // config.json is only re-read when its mtime changes; the remote list is parsed once per call.
  let stamp = 'none'; try { const st = fs.statSync(path.join(LIVE, 'config.json')); stamp = st.mtimeMs + ':' + st.size; } catch {}
  if (collectorKey !== null && stamp === cfgStamp) return collector;
  cfgStamp = stamp;
  const warnings = [], list = remotesFromEnv(process.env, (m) => warnings.push(m)) || parseRemotes(cfg().remotes, (m) => warnings.push(m)), key = JSON.stringify(list);
  if (key !== collectorKey) { collectorKey = key; for (const m of warnings) console.error('[remotes] ' + m); collector = list.length ? createCollector({ remotes: list }) : null; }
  return collector;
}
function stateWithMachines() { const c = remoteCollector(); return mergeState(build(), c ? c.snapshot() : []); }
setInterval(() => { const c = remoteCollector(); if (c) c.tick().catch(() => {}); }, 1000).unref();

const server = http.createServer((req, res) => {
  try {
    if (!hostAllowed(req)) return send(res, 403, { error: 'forbidden host' });
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/api/state') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
      const at = new URL(req.url, 'http://localhost').searchParams.get('at');
      if (at) { const ms = Date.parse(at); if (!Number.isFinite(ms)) return send(res, 400, { error: 'bad at' }); return send(res, 200, buildAt(ms)); }
      if (new URL(req.url, 'http://localhost').searchParams.get('local')) return send(res, 200, build()); // what remote monitors poll: never re-aggregated
      return send(res, 200, stateWithMachines());
    }
    if (pathname === '/api/timeline') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
      const at = new URL(req.url, 'http://localhost').searchParams.get('at'), ms = at ? Date.parse(at) : null;
      if (at && !Number.isFinite(ms)) return send(res, 400, { error: 'bad at' });
      return send(res, 200, timeline(ms));
    }
    if (pathname === '/api/history') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
      const n = Number(new URL(req.url, 'http://localhost').searchParams.get('limit'));
      return send(res, 200, history(Number.isInteger(n) && n > 0 ? Math.min(n, 2000) : 200));
    }
    if (pathname === '/api/goals' || pathname.startsWith('/api/goals/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') { req.resume(); return send(res, 405, { error: 'method not allowed' }); }
      if (pathname === '/api/goals') return send(res, 200, { goals: withWorkers(goalSummaries(GOAL_READ_MAX), build().agents) });
      let id; try { id = decodeURIComponent(pathname.slice('/api/goals/'.length)); } catch { return send(res, 400, { error: 'bad id' }); }
      if (!GID_RE.test(id)) return send(res, 404, { error: 'not found' });
      const d = goalDetail(id);
      return d ? send(res, 200, { goal: withWorkers([d], build().agents)[0] }) : send(res, 404, { error: 'not found' });
    }
    if (pathname === '/api/verdicts') { // read-only guard verdicts, newest first (max 50)
      if (req.method !== 'GET' && req.method !== 'HEAD') { req.resume(); return send(res, 405, { error: 'method not allowed' }); }
      return send(res, 200, { verdicts: (build(), verdictList(liveSidOf, VERDICTS_API_MAX)) });
    }
    if (pathname === '/v1/metrics') return receiveMetrics(req, res);
    if (pathname === '/v1/logs' || pathname === '/v1/traces') { req.resume(); return send(res, 404, { error: 'only metrics are read: set OTEL_LOGS_EXPORTER=none' }); }
    if (pathname === '/api/control') { req.resume(); return send(res, 405, { ok: false, error: 'monitor is read-only' }); }
    if (pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
    return serveStatic(req, res, pathname);
  } catch (e) { console.error(e); if (!res.headersSent) send(res, 500, { error: 'internal error' }); }
});
server.headersTimeout = 10000; server.requestTimeout = 15000;
server.listen(PORT, HOST, () => console.log(`AOS-1 live monitor on http://${HOST}:${PORT}  (read-only; ${FILE})`));
setInterval(notifyTick, 2000).unref();
const shutdown = () => { server.close(); setTimeout(() => process.exit(0), 200).unref(); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
