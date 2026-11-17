#!/usr/bin/env node
// AOS guard auto-verify (Claude Code SessionStart + Stop hook, registered async). OPT-IN and OFF by default: does nothing unless
// live/config.json has
//   "guard": { "repos": ["/abs/repo", {"path": "/abs/repo2", "base": "<40-hex sha>"}, ...], "cli": "/abs/path/to/aos-orch.mjs", "timeout_s": 300 }
// and the session's cwd (after realpath) is inside one of the listed repos.
// SessionStart: records the repo's HEAD (git rev-parse via execFile, no shell, global/system git config and hooks/fsmonitor off) as
// the session's base in <data>/guard/bases/<session>.json {repo, sha, at}; the first record for a session is never overwritten
// (a resume/compact cannot move it). Stop: starts, fully detached, a small runner (this file with --run) that executes
// `node <cli> verify --repo <repo> --base <sha> --source hook --session <id>` with a timeout and exits. The base is the recorded sha,
// else the repo's explicit config `base`; with neither the run is skipped and logged (never a silent default to main, which an agent
// that commits onto main would turn into an empty diff). Safety:
//   - never blocks or delays the session (the hook only spawns and exits; the runner is detached, stdio ignored, unref'd)
//   - never prints anything (no stdout/stderr), always exits 0, never writes to the repo (the runner's cwd is the data dir)
//   - no shell anywhere: spawn with an argv array; every config value is validated (absolute, realpath'd, repo = existing dir,
//     cli = existing regular file, timeout 10..3600 s); the session id must match ^[A-Za-z0-9_-]{1,128}$ or is left out
//   - at most one run per repo (O_EXCL lock in <data>/guard/, taken over only when older than the timeout + 60 s)
//   - logs only to the data dir: <data>/guard/guard.log (one line per run: time, repo basename, exit code/signal, duration) and
//     <data>/guard/last-<repo hash>.log (the CLI's output of the newest run, capped at 256 KB)
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), '..');
const LIVE = process.env.AOS_LIVE_DIR || path.join(ROOT, 'live');
const GUARD_DIR = path.join(LIVE, 'guard');
const BASES_DIR = path.join(GUARD_DIR, 'bases');
const SID_RE = /^[A-Za-z0-9_-]{1,128}$/, SHA_RE = /^[0-9a-f]{40}$/, OUT_MAX = 256 * 1024, LOCK_GRACE_S = 60, BASES_MAX = 200, GIT_TIMEOUT_MS = 5000;
// the runner's spawn options (exported for tests): detached, no stdio, no shell
export const RUNNER_OPTS = Object.freeze({ detached: true, stdio: 'ignore', shell: false, windowsHide: true });

const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
const isAbs = (p) => typeof p === 'string' && p.length > 1 && p.length <= 1024 && path.isAbsolute(p) && !/[\u0000-\u001f\u007f]/.test(p);
// config.guard -> { repos: [realpath dirs], bases: {repo: sha}, cli: realpath file, timeout_s } or null when absent/invalid (= feature off).
// A repos entry is an absolute path, or {path, base} with base a 40-hex commit sha (the fallback base when no start record exists)
export function guardConfig(c) {
  const g = c && typeof c === 'object' && !Array.isArray(c) ? c.guard : null;
  if (!g || typeof g !== 'object' || Array.isArray(g) || !Array.isArray(g.repos) || !isAbs(g.cli)) return null;
  const cli = real(g.cli); let st = null; try { st = cli && fs.statSync(cli); } catch { st = null; }
  if (!st || !st.isFile()) return null;
  const repos = [], bases = Object.create(null);
  for (const e of g.repos.slice(0, 50)) {
    const obj = e && typeof e === 'object' && !Array.isArray(e), r = obj ? e.path : e;
    if (!isAbs(r)) continue; const p = real(r);
    try { if (p && p !== path.parse(p).root && fs.statSync(p).isDirectory() && !repos.includes(p)) { repos.push(p); if (obj && typeof e.base === 'string' && SHA_RE.test(e.base)) bases[p] = e.base; } } catch {}
  }
  if (!repos.length) return null;
  const t = Number(g.timeout_s ?? 300);
  return { repos, bases, cli, timeout_s: Number.isFinite(t) && t >= 10 && t <= 3600 ? Math.round(t) : 300 };
}
const inside = (p, base) => p === base || p.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
// hook input + guard config -> the deepest listed repo that contains the realpath of cwd, or null
function repoFor(input, g) {
  if (!g || !input || typeof input !== 'object' || !isAbs(input.cwd)) return null;
  const cwd = real(input.cwd); if (!cwd) return null;
  return g.repos.filter((r) => inside(cwd, r)).sort((a, b) => b.length - a.length)[0] || null;
}
const sidOf = (input) => (typeof input.session_id === 'string' && SID_RE.test(input.session_id) ? input.session_id : null);
export const basePath = (sid) => path.join(BASES_DIR, sid + '.json');
// the base recorded at SessionStart for this session in this repo (validated), or null
export function recordedBase(sid, repo) {
  if (!sid || !SID_RE.test(sid)) return null;
  try {
    const f = basePath(sid); if (!fs.lstatSync(f).isFile() || fs.statSync(f).size > 4096) return null;
    const r = JSON.parse(fs.readFileSync(f, 'utf8'));
    return r && r.repo === repo && typeof r.sha === 'string' && SHA_RE.test(r.sha) ? r.sha : null;
  } catch { return null; }
}
// hook input + guard config -> { repo, argv } | { repo, skip: reason } | null (not ours). The base is the sha recorded at SessionStart,
// else the repo's config base; never a default branch (an agent that commits onto it would make the diff empty)
export function planRun(input, g) {
  const repo = repoFor(input, g); if (!repo) return null;
  const sid = sidOf(input);
  const base = recordedBase(sid, repo) || g.bases[repo] || null;
  if (!base) return { repo, skip: `no base recorded at session start${sid ? '' : ' (no valid session id)'} and no base in config` };
  return { repo, base, argv: [g.cli, 'verify', '--repo', repo, '--base', base, '--source', 'hook', ...(sid ? ['--session', sid] : [])] };
}
// git with no shell, no global/system config, no hooks/fsmonitor, a bounded timeout; returns trimmed stdout or null
export function gitHead(repo) {
  const env = { PATH: process.env.PATH || '/usr/bin:/bin', HOME: process.env.HOME || '/', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
  try {
    const out = execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', repo, 'rev-parse', '--verify', '-q', 'HEAD^{commit}'],
      { env, cwd: repo, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'ignore'], shell: false, windowsHide: true }).trim();
    return SHA_RE.test(out) ? out : null;
  } catch { return null; }
}
// keep at most BASES_MAX - 1 records before adding one (oldest by mtime go first); non-matching names are left alone
function pruneBases() {
  try {
    const fl = fs.readdirSync(BASES_DIR).filter((f) => /^[A-Za-z0-9_-]{1,128}\.json$/.test(f));
    if (fl.length < BASES_MAX) return;
    const st = fl.map((f) => { try { return [f, fs.lstatSync(path.join(BASES_DIR, f)).mtimeMs]; } catch { return [f, 0]; } }).sort((a, b) => a[1] - b[1]);
    for (const [f] of st.slice(0, fl.length - BASES_MAX + 1)) try { fs.unlinkSync(path.join(BASES_DIR, f)); } catch {}
  } catch {}
}
// SessionStart: record HEAD of the session's repo as its base. The first record wins (O_EXCL), so resume/compact cannot move it
export function recordBase(input, g, head = gitHead) {
  const repo = repoFor(input, g), sid = repo && sidOf(input);
  if (!repo || !sid) return null;
  if (fs.existsSync(basePath(sid))) return null;
  const sha = head(repo);
  if (typeof sha !== 'string' || !SHA_RE.test(sha)) { logLine(`nobase ${path.basename(repo)}: could not read HEAD at session start`); return null; }
  try {
    fs.mkdirSync(BASES_DIR, { recursive: true, mode: 0o700 }); pruneBases();
    const fd = fs.openSync(basePath(sid), 'wx', 0o600); fs.writeSync(fd, JSON.stringify({ repo, sha, at: new Date().toISOString() })); fs.closeSync(fd);
  } catch { return null; }
  return { repo, sha };
}
const hashOf = (repo) => createHash('sha256').update(repo).digest('hex').slice(0, 16);
export const lockPath = (repo) => path.join(GUARD_DIR, hashOf(repo) + '.lock');
// O_EXCL lock per repo; a lock older than the timeout + grace (a crashed runner) is taken over. true = acquired
export function acquireLock(repo, timeout_s) {
  fs.mkdirSync(GUARD_DIR, { recursive: true, mode: 0o700 });
  const f = lockPath(repo);
  for (let i = 0; i < 2; i++) {
    try { const fd = fs.openSync(f, 'wx', 0o600); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd); return true; } catch (e) {
      if (e.code !== 'EEXIST') return false;
      try { if (Date.now() - fs.statSync(f).mtimeMs > (timeout_s + LOCK_GRACE_S) * 1000) { fs.unlinkSync(f); continue; } } catch { continue; }
      return false;
    }
  }
  return false;
}
function readConfig() { try { return JSON.parse(fs.readFileSync(path.join(LIVE, 'config.json'), 'utf8')); } catch { return null; } }
const logLine = (s) => { try { fs.mkdirSync(GUARD_DIR, { recursive: true, mode: 0o700 }); fs.appendFileSync(path.join(GUARD_DIR, 'guard.log'), new Date().toISOString() + ' ' + s.replace(/[\u0000-\u001f\u007f]+/g, ' ') + '\n', { mode: 0o600 }); } catch {} };

// hook mode: decide, take the lock, start the detached runner, return immediately
export function hookMain(raw, spawnFn = spawn, head = gitHead) {
  let p; try { p = JSON.parse(raw); } catch { return null; }
  if (!p || typeof p !== 'object') return null;
  const g = guardConfig(readConfig());
  if (p.hook_event_name === 'SessionStart') { recordBase(p, g, head); return null; }
  const plan = planRun(p, g);
  if (!plan) return null;
  if (plan.skip) { logLine(`skip ${path.basename(plan.repo)}: ${plan.skip}`); return null; }
  if (!acquireLock(plan.repo, g.timeout_s)) { logLine(`skip ${path.basename(plan.repo)}: a verify run is already in progress`); return null; }
  const args = [SELF, '--run', plan.repo, ...(plan.argv.includes('--session') ? [plan.argv[plan.argv.length - 1]] : [])];
  try { const c = spawnFn(process.execPath, args, RUNNER_OPTS); c.on('error', () => { try { fs.unlinkSync(lockPath(plan.repo)); } catch {} }); c.unref(); }
  catch { try { fs.unlinkSync(lockPath(plan.repo)); } catch {} return null; }
  return { argv: args, opts: RUNNER_OPTS };
}
// runner mode (detached): re-validate against the config, run the CLI with a timeout, log, release the lock
function runnerMain(repoArg, sidArg) {
  const g = guardConfig(readConfig()), plan = planRun({ cwd: repoArg, session_id: sidArg }, g);
  const release = () => { try { fs.unlinkSync(lockPath(repoArg)); } catch {} };
  if (!plan || plan.repo !== repoArg || !plan.argv) { if (plan && plan.skip) logLine(`skip ${path.basename(plan.repo)}: ${plan.skip}`); release(); return; }
  try { fs.writeFileSync(lockPath(plan.repo), String(process.pid)); } catch {}
  const out = path.join(GUARD_DIR, 'last-' + hashOf(plan.repo) + '.log');
  let fd = null; try { fd = fs.openSync(out, 'w', 0o600); } catch { fd = null; }
  const t0 = Date.now();
  let child;
  try { child = spawn(process.execPath, plan.argv, { cwd: GUARD_DIR, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true }); }
  catch { logLine(`fail ${path.basename(plan.repo)}: could not start the cli`); release(); return; }
  let n = 0; const sink = (d) => { if (fd === null || n >= OUT_MAX) return; const b = d.subarray(0, OUT_MAX - n); n += b.length; try { fs.writeSync(fd, b); } catch {} };
  child.stdout.on('data', sink); child.stderr.on('data', sink);
  let timedOut = false;
  const kill = setTimeout(() => { timedOut = true; try { child.kill('SIGTERM'); } catch {} setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000).unref(); }, g.timeout_s * 1000);
  let ended = false;
  const done = (code, sig) => { if (ended) return; ended = true; clearTimeout(kill); if (fd !== null) try { fs.closeSync(fd); } catch {}
    logLine(`${timedOut ? 'timeout' : 'done'} ${path.basename(plan.repo)}: exit ${code === null ? 'signal ' + sig : code} in ${Math.round((Date.now() - t0) / 1000)}s`); release(); };
  child.on('error', () => done(null, 'spawn-error'));
  child.on('exit', done);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv[2] === '--run') { try { runnerMain(process.argv[3], process.argv[4] || null); } catch {} }
  else {
    let raw = ''; try { raw = fs.readFileSync(0, 'utf8'); } catch {}
    try { hookMain(raw); } catch {}
    process.exit(0);
  }
}
