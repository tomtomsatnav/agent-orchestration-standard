// Opt-in guard auto-verify hook (hooks/aos-guard.mjs): off unless configured, base recorded at SessionStart, argv-only spawn (no shell),
// detached, one run per repo.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ROOT, tmpDir, sleep } from './harness.mjs';

const TMP = tmpDir('aos-guardhook-'), LIVE = path.join(TMP, 'live'), HOOK = path.join(ROOT, 'hooks', 'aos-guard.mjs');
const REPO = path.join(TMP, 're po;$(touch PWNED)'), OUTSIDE = path.join(TMP, 'outside'), CLI = path.join(TMP, 'fake-cli.mjs'), REC = path.join(TMP, 'argv.ndjson');
let H;
const cfg = (guard) => fs.writeFileSync(path.join(LIVE, 'config.json'), JSON.stringify(guard === undefined ? { stuck_after_s: 180 } : { guard }));
const calls = []; const fakeSpawn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { on() {}, unref() {} }; };
const input = (o) => JSON.stringify({ hook_event_name: 'Stop', session_id: 'abc-123', cwd: path.join(REPO, 'src'), ...o });
const GENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (...a) => { const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-C', REPO, ...a], { env: GENV, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
let SHA0;
before(async () => {
  fs.mkdirSync(path.join(REPO, 'src'), { recursive: true }); fs.mkdirSync(OUTSIDE); fs.mkdirSync(LIVE);
  fs.symlinkSync(OUTSIDE, path.join(REPO, 'escape'), 'junction');
  git('init', '-q'); git('commit', '-q', '--allow-empty', '-m', 'base'); SHA0 = git('rev-parse', 'HEAD');
  // fake orchestrator CLI: records its argv and cwd, then sleeps a little (the hook must not wait for it)
  fs.writeFileSync(CLI, `import fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(REC)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + '\\n');\nconsole.log('verify output');\nsetTimeout(() => {}, 1200);\n`);
  process.env.AOS_LIVE_DIR = LIVE;
  H = await import(pathToFileURL(HOOK).href + '?t=' + Date.now());
});
after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });
const lock = () => H.lockPath(fs.realpathSync(REPO));

test('not configured (or invalid config) -> does nothing', () => {
  for (const g of [undefined, null, {}, { repos: [REPO] }, { repos: [REPO], cli: 'relative/cli.mjs' }, { repos: [REPO], cli: path.join(TMP, 'missing.mjs') }, { repos: ['relative'], cli: CLI }, { repos: [CLI], cli: CLI }, { repos: REPO, cli: CLI }, { repos: [REPO], cli: TMP }]) {
    cfg(g); assert.equal(H.hookMain(input(), fakeSpawn), null, JSON.stringify(g));
  }
  assert.equal(calls.length, 0); assert.ok(!fs.existsSync(path.join(LIVE, 'guard')));
  assert.equal(H.hookMain('not json', fakeSpawn), null);
});

test('configured -> one detached runner, argv array, no shell; second Stop while running is skipped', () => {
  cfg({ repos: [REPO, OUTSIDE + '/../outside'], cli: CLI, timeout_s: 5 });
  assert.equal(H.hookMain(input({ hook_event_name: 'SessionStart' }), fakeSpawn), null); assert.equal(calls.length, 0);   // records the base only
  const r = H.hookMain(input(), fakeSpawn), repo = fs.realpathSync(REPO);
  assert.ok(r); assert.equal(calls.length, 1);
  const c = calls[0];
  assert.equal(c.cmd, process.execPath);
  assert.deepEqual(c.args.slice(1), ['--run', repo, 'abc-123']);
  assert.equal(c.opts.detached, true); assert.equal(c.opts.shell, false); assert.equal(c.opts.stdio, 'ignore');
  assert.ok(fs.existsSync(lock()));
  assert.equal(H.hookMain(input(), fakeSpawn), null); assert.equal(calls.length, 1);   // concurrent run guard
  assert.match(fs.readFileSync(path.join(LIVE, 'guard', 'guard.log'), 'utf8'), /skip re po;\$\(touch PWNED\): a verify run is already in progress/);
  // the CLI argv the runner will use
  assert.deepEqual(H.planRun(JSON.parse(input()), H.guardConfig({ guard: { repos: [REPO], cli: CLI } })).argv, [fs.realpathSync(CLI), 'verify', '--repo', repo, '--base', SHA0, '--source', 'hook', '--session', 'abc-123']);
  fs.unlinkSync(lock());
});

test('cwd outside the listed repos (also via a symlink out of the repo) -> nothing; bad session id is left out', () => {
  const g = H.guardConfig({ guard: { repos: [REPO], cli: CLI } });
  assert.equal(H.planRun({ cwd: OUTSIDE, session_id: 'x' }, g), null);
  assert.equal(H.planRun({ cwd: path.join(REPO, 'escape'), session_id: 'x' }, g), null);
  assert.equal(H.planRun({ cwd: REPO + '-sibling', session_id: 'x' }, g), null);
  assert.equal(H.planRun({ cwd: 'relative', session_id: 'x' }, g), null);
  const bad = H.planRun({ cwd: REPO, session_id: '$(rm -rf ~)' }, g);   // no valid session id -> no recorded base -> no run
  assert.ok(!bad.argv && /no valid session id/.test(bad.skip));
  cfg({ repos: [REPO], cli: CLI }); const n = calls.length;
  assert.equal(H.hookMain(input({ cwd: OUTSIDE }), fakeSpawn), null); assert.equal(calls.length, n);
});

test('a stale lock (crashed runner) is taken over', () => {
  cfg({ repos: [REPO], cli: CLI, timeout_s: 10 });
  fs.mkdirSync(path.join(LIVE, 'guard'), { recursive: true }); fs.writeFileSync(lock(), '1');
  const old = new Date(Date.now() - 200 * 1000); fs.utimesSync(lock(), old, old);
  assert.ok(H.hookMain(input(), fakeSpawn)); fs.unlinkSync(lock());
});

test('end to end: the hook returns at once, silently; the runner calls the CLI with the exact argv, logs to the data dir, releases the lock', async () => {
  cfg({ repos: [REPO], cli: CLI, timeout_s: 30 });
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [HOOK], { input: input(), env: { ...process.env, AOS_LIVE_DIR: LIVE }, encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 0); assert.equal(r.stdout, ''); assert.equal(r.stderr, '');
  assert.ok(Date.now() - t0 < 1000 + 1500, 'hook waited for the CLI');                  // fake CLI sleeps 1.2 s; node start-up dominates
  let rec = null; for (let i = 0; i < 50 && !rec; i++) { await sleep(100); try { rec = JSON.parse(fs.readFileSync(REC, 'utf8').trim().split('\n').pop()); } catch {} }
  assert.ok(rec, 'cli never ran');
  assert.deepEqual(rec.argv, ['verify', '--repo', fs.realpathSync(REPO), '--base', SHA0, '--source', 'hook', '--session', 'abc-123']);
  assert.equal(rec.cwd, path.join(LIVE, 'guard'));                                        // never runs inside the repo
  assert.ok(!fs.existsSync(path.join(TMP, 'PWNED')) && !fs.existsSync(path.join(REPO, 'PWNED')), 'shell metacharacters were interpreted');
  for (let i = 0; i < 50 && fs.existsSync(lock()); i++) await sleep(100);
  assert.ok(!fs.existsSync(lock()), 'lock not released');
  assert.match(fs.readFileSync(path.join(LIVE, 'guard', 'guard.log'), 'utf8'), /done re po;\$\(touch PWNED\): exit 0 in \d+s/);
  assert.ok(fs.readdirSync(path.join(LIVE, 'guard')).some((f) => /^last-[0-9a-f]{16}\.log$/.test(f)));
  assert.deepEqual(fs.readdirSync(REPO).sort(), ['.git', 'escape', 'src']);               // repo untouched
});

test('base recorded at SessionStart (real git, no shell) and kept: committing onto the branch afterwards does not move it', () => {
  cfg({ repos: [REPO], cli: CLI }); const g = H.guardConfig({ guard: { repos: [REPO], cli: CLI } }), repo = fs.realpathSync(REPO);
  assert.equal(H.gitHead(repo), SHA0);
  const sid = 'sess-commit-1';
  H.hookMain(input({ hook_event_name: 'SessionStart', session_id: sid }), fakeSpawn);
  const rec = JSON.parse(fs.readFileSync(H.basePath(sid), 'utf8'));
  assert.equal(rec.repo, repo); assert.equal(rec.sha, SHA0); assert.ok(!Number.isNaN(Date.parse(rec.at)));
  git('commit', '-q', '--allow-empty', '-m', 'agent commits onto the branch');
  const moved = git('rev-parse', 'HEAD'); assert.notEqual(moved, SHA0);
  H.hookMain(input({ hook_event_name: 'SessionStart', session_id: sid, source: 'resume' }), fakeSpawn);   // a resume cannot move it
  assert.equal(JSON.parse(fs.readFileSync(H.basePath(sid), 'utf8')).sha, SHA0);
  const argv = H.planRun({ cwd: REPO, session_id: sid }, g).argv;
  assert.equal(argv[argv.indexOf('--base') + 1], SHA0); assert.ok(!argv.includes(moved));
  git('reset', '-q', '--hard', SHA0);
});

test('no recorded base -> no run, logged; config base is the fallback; invalid sha / session / record rejected', () => {
  cfg({ repos: [REPO], cli: CLI }); const n = calls.length, log = path.join(LIVE, 'guard', 'guard.log');
  assert.equal(H.hookMain(input({ session_id: 'never-started' }), fakeSpawn), null); assert.equal(calls.length, n);
  assert.match(fs.readFileSync(log, 'utf8'), /skip re po;\$\(touch PWNED\): no base recorded at session start and no base in config/);
  const other = 'b'.repeat(40);
  const gb = H.guardConfig({ guard: { repos: [{ path: REPO, base: other }], cli: CLI } });
  assert.equal(H.planRun({ cwd: REPO, session_id: 'never-started' }, gb).base, other);           // explicit config base
  assert.equal(H.planRun({ cwd: REPO, session_id: 'abc-123' }, gb).base, SHA0);                 // a recorded base wins
  for (const b of ['main', 'B'.repeat(40), 'a'.repeat(39), '--upload-pack=x', 'a'.repeat(40) + '\n'])
    assert.ok(H.planRun({ cwd: REPO, session_id: 'never-started' }, H.guardConfig({ guard: { repos: [{ path: REPO, base: b }], cli: CLI } })).skip, b);
  // a tampered record (bad sha, other repo) is ignored; a bad session id never touches the bases dir
  fs.writeFileSync(H.basePath('tampered'), JSON.stringify({ repo: fs.realpathSync(REPO), sha: '--exec=sh' }));
  fs.writeFileSync(H.basePath('elsewhere'), JSON.stringify({ repo: OUTSIDE, sha: SHA0 }));
  for (const s of ['tampered', 'elsewhere']) assert.ok(H.planRun({ cwd: REPO, session_id: s }, H.guardConfig({ guard: { repos: [REPO], cli: CLI } })).skip, s);
  const before = fs.readdirSync(path.join(LIVE, 'guard', 'bases')).length;
  for (const s of ['../../x', 'a/b', '', 'x'.repeat(129), 7]) assert.equal(H.recordBase({ cwd: REPO, session_id: s }, gb), null);
  assert.equal(fs.readdirSync(path.join(LIVE, 'guard', 'bases')).length, before);
  // a HEAD that is not a 40-hex sha is not recorded
  assert.equal(H.recordBase({ cwd: REPO, session_id: 'weird-head' }, gb, () => 'refs/heads/main'), null); assert.ok(!fs.existsSync(H.basePath('weird-head')));
});

test('base records are bounded: oldest pruned', () => {
  const g = H.guardConfig({ guard: { repos: [REPO], cli: CLI } }), dir = path.join(LIVE, 'guard', 'bases'), old = new Date(Date.now() - 3600e3);
  for (let i = 0; i < 260; i++) { const f = H.basePath('fill-' + i); fs.writeFileSync(f, '{}'); fs.utimesSync(f, old, old); }
  assert.ok(H.recordBase({ cwd: REPO, session_id: 'newest' }, g, () => SHA0));
  const left = fs.readdirSync(dir); assert.ok(left.length <= 200, String(left.length)); assert.ok(left.includes('newest.json'));
});

test('plugin registers the guard hook on SessionStart and Stop, async', () => {
  const hk = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin', 'hooks', 'hooks.json'), 'utf8')).hooks;
  for (const ev of ['SessionStart', 'Stop']) { const g = hk[ev][0].hooks.find((x) => /aos-guard\.mjs/.test(x.command)); assert.ok(g && g.async === true, ev); }
});
