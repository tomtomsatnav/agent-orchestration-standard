// State-dir discovery: with AOS_ORCH_DIR unset the monitor reads BOTH the default dir (~/.aos/orch or $XDG_STATE_HOME/aos/orch)
// and the legacy <plugin data>/orch, merged and deduped by goal id (newer heartbeat wins); with AOS_ORCH_DIR only that dir. Never creates dirs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { ROOT, FIXTURES, tmpDir } from './harness.mjs';

const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const getJson = (port, p) => new Promise((resolve, reject) => { http.get({ host: '127.0.0.1', port, path: p, agent: false }, (r) => { let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => resolve(JSON.parse(b))); }).on('error', reject); });
async function monitor(env) {
  const port = await freePort();
  const clean = { ...process.env }; delete clean.AOS_ORCH_DIR; delete clean.XDG_STATE_HOME; delete clean.CLAUDE_PLUGIN_DATA;
  const p = spawn(process.execPath, [path.join(ROOT, 'monitor.mjs')], { env: { ...clean, PORT: String(port), ...env, ...(env.HOME ? { USERPROFILE: env.HOME } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((res, rej) => { p.stdout.on('data', (d) => { if (String(d).includes('live monitor on')) res(); }); p.on('exit', () => rej(new Error('exit'))); setTimeout(() => rej(new Error('timeout')), 8000); });
  return { port, stop: () => new Promise((r) => { p.on('exit', r); p.kill('SIGTERM'); setTimeout(() => p.kill('SIGKILL'), 1500).unref(); }) };
}
function putGoal(root, id, title, mtimeS) {
  const d = path.join(root, 'goals', id); fs.cpSync(path.join(FIXTURES, 'all-success', 'goals', 'g-test'), d, { recursive: true });
  const f = path.join(d, 'goal.json'), g = JSON.parse(fs.readFileSync(f, 'utf8')); g.id = id; g.title = title; fs.writeFileSync(f, JSON.stringify(g));
  fs.utimesSync(f, mtimeS, mtimeS);
}
const titles = (j) => Object.fromEntries(j.goals.map((g) => [g.id, g.title]));
const now = Math.floor(Date.now() / 1000);

test('default: merges new default dir (~/.aos/orch) and legacy plugin-data dir; newer heartbeat wins on duplicate id', async () => {
  const T = tmpDir('aos-orchdirs-'), home = path.join(T, 'home'), data = path.join(T, 'data'), live = path.join(T, 'live');
  fs.mkdirSync(live, { recursive: true });
  putGoal(path.join(home, '.aos', 'orch'), 'g-new', 'only new', now - 10);
  putGoal(path.join(data, 'orch'), 'g-old', 'only legacy', now - 20);
  putGoal(path.join(home, '.aos', 'orch'), 'g-both', 'both (new copy, stale)', now - 300);
  putGoal(path.join(data, 'orch'), 'g-both', 'both (legacy copy, fresh)', now - 5);
  putGoal(path.join(home, '.aos', 'orch'), 'g-both2', 'both2 (new copy, fresh)', now - 5);
  putGoal(path.join(data, 'orch'), 'g-both2', 'both2 (legacy copy, stale)', now - 300);
  const m = await monitor({ HOME: home, CLAUDE_PLUGIN_DATA: data, AOS_LIVE_DIR: live });
  try {
    const j = await getJson(m.port, '/api/goals'), t = titles(j);
    assert.equal(j.goals.length, 4);
    assert.equal(t['g-new'], 'only new'); assert.equal(t['g-old'], 'only legacy');
    assert.equal(t['g-both'], 'both (legacy copy, fresh)'); assert.equal(t['g-both2'], 'both2 (new copy, fresh)');
    assert.equal((await getJson(m.port, '/api/goals/g-old')).goal.title, 'only legacy');
  } finally { await m.stop(); fs.rmSync(T, { recursive: true, force: true }); }
});

test('XDG_STATE_HOME set: reads $XDG_STATE_HOME/aos/orch (not ~/.aos) plus legacy; only-legacy works; no dir is created', async () => {
  const T = tmpDir('aos-orchdirs-'), home = path.join(T, 'home'), data = path.join(T, 'data'), xdg = path.join(T, 'xdg'), live = path.join(T, 'live');
  fs.mkdirSync(live, { recursive: true }); fs.mkdirSync(home, { recursive: true });
  putGoal(path.join(xdg, 'aos', 'orch'), 'g-x', 'xdg goal', now - 10);
  putGoal(path.join(home, '.aos', 'orch'), 'g-ignored', 'home goal ignored', now - 10);
  putGoal(path.join(data, 'orch'), 'g-leg', 'legacy goal', now - 10);
  const m = await monitor({ HOME: home, XDG_STATE_HOME: xdg, CLAUDE_PLUGIN_DATA: data, AOS_LIVE_DIR: live });
  try { assert.deepEqual(Object.keys(titles(await getJson(m.port, '/api/goals'))).sort(), ['g-leg', 'g-x']); } finally { await m.stop(); }
  // only legacy exists, nothing else: still served, and the absent new default dir is not created
  const T2 = tmpDir('aos-orchdirs-'), home2 = path.join(T2, 'home'), data2 = path.join(T2, 'data'), live2 = path.join(T2, 'live');
  fs.mkdirSync(live2, { recursive: true }); fs.mkdirSync(home2, { recursive: true });
  putGoal(path.join(data2, 'orch'), 'g-leg', 'legacy only', now - 10);
  const m2 = await monitor({ HOME: home2, CLAUDE_PLUGIN_DATA: data2, AOS_LIVE_DIR: live2 });
  try { assert.deepEqual(titles(await getJson(m2.port, '/api/goals')), { 'g-leg': 'legacy only' }); assert.equal(fs.existsSync(path.join(home2, '.aos')), false); }
  finally { await m2.stop(); }
  // neither exists: empty list, nothing created
  const T3 = tmpDir('aos-orchdirs-'), home3 = path.join(T3, 'home'), data3 = path.join(T3, 'data'), live3 = path.join(T3, 'live');
  fs.mkdirSync(live3, { recursive: true }); fs.mkdirSync(home3, { recursive: true });
  const m3 = await monitor({ HOME: home3, CLAUDE_PLUGIN_DATA: data3, AOS_LIVE_DIR: live3 });
  try { assert.equal((await getJson(m3.port, '/api/goals')).goals.length, 0); assert.equal(fs.existsSync(path.join(home3, '.aos')), false); assert.equal(fs.existsSync(path.join(data3, 'orch')), false); }
  finally { await m3.stop(); for (const d of [T, T2, T3]) fs.rmSync(d, { recursive: true, force: true }); }
});

test('AOS_ORCH_DIR set: only that dir is read', async () => {
  const T = tmpDir('aos-orchdirs-'), home = path.join(T, 'home'), data = path.join(T, 'data'), only = path.join(T, 'only'), live = path.join(T, 'live');
  fs.mkdirSync(live, { recursive: true });
  putGoal(only, 'g-only', 'explicit', now - 10); putGoal(path.join(home, '.aos', 'orch'), 'g-n', 'n', now); putGoal(path.join(data, 'orch'), 'g-l', 'l', now);
  const m = await monitor({ HOME: home, CLAUDE_PLUGIN_DATA: data, AOS_ORCH_DIR: only, AOS_LIVE_DIR: live });
  try { assert.deepEqual(Object.keys(titles(await getJson(m.port, '/api/goals'))), ['g-only']); } finally { await m.stop(); fs.rmSync(T, { recursive: true, force: true }); }
});
