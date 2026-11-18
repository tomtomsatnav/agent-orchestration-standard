// A cancelled GET of a dashboard file must close the read stream. pipe() does not.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MONITOR = path.join(ROOT, 'monitor.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const canListFds = process.platform === 'linux' || process.platform === 'darwin';

function fdText(pid) {
  if (process.platform === 'linux') {
    const dir = `/proc/${pid}/fd`;
    return fs.readdirSync(dir).map((n) => { try { return fs.readlinkSync(path.join(dir, n)); } catch { return ''; } }).join('\n');
  }
  try { return execFileSync('lsof', ['-nP', '-p', String(pid)], { encoding: 'utf8' }); }
  catch (e) { return `${e.stdout || ''}`; }
}

async function start() {
  const port = await freePort();
  const live = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-static-'));
  const orch = path.join(live, 'orch');
  fs.mkdirSync(orch, { recursive: true });
  const child = spawn(process.execPath, [MONITOR], { env: { ...process.env, PORT: String(port), AOS_LIVE_DIR: live, AOS_ORCH_DIR: orch }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((res, rej) => {
    child.stdout.on('data', (d) => { if (String(d).includes('live monitor on')) res(); });
    child.on('exit', () => rej(new Error('monitor exited')));
    setTimeout(() => rej(new Error('monitor start timeout')), 8000);
  });
  const stop = () => new Promise((r) => { child.on('exit', r); child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 1500).unref(); });
  return { port, pid: child.pid, live, stop };
}

function abortAfterFirstByte(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, agent: false }, (res) => {
      res.once('data', () => { req.destroy(); resolve(res.statusCode); });
    });
    req.on('error', (e) => { if (e.code === 'ECONNRESET') resolve(0); else reject(e); });
  });
}

function readAll(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), length: Number(res.headers['content-length']) }));
    }).on('error', reject);
  });
}

test('a cancelled dashboard download closes the file', { skip: !canListFds && 'this OS has no /proc or lsof fd list' }, async () => {
  const name = 'static-abort.bin';
  const file = path.join(ROOT, 'ui', name);
  fs.writeFileSync(file, Buffer.alloc(8 * 1024 * 1024, 7));
  const m = await start();
  try {
    assert.equal(fdText(m.pid).includes(name), false);
    const status = await abortAfterFirstByte(m.port, '/' + name);
    assert.equal(status, 200);
    let open = true;
    for (let i = 0; i < 15; i++) {
      await sleep(40);
      open = fdText(m.pid).includes(name);
      if (!open) break;
    }
    assert.equal(open, false, 'the read stream is still open after the client hung up');
  } finally {
    fs.rmSync(file, { force: true });
    await m.stop();
    fs.rmSync(m.live, { recursive: true, force: true });
  }
});

test('a finished dashboard download returns the whole file and closes it', async () => {
  const name = 'static-done.bin';
  const body = Buffer.alloc(256 * 1024, 9);
  const file = path.join(ROOT, 'ui', name);
  fs.writeFileSync(file, body);
  const m = await start();
  try {
    const got = await readAll(m.port, '/' + name);
    assert.equal(got.status, 200);
    assert.equal(got.length, body.length);
    assert.ok(got.body.equals(body));
    if (canListFds) {
      let open = true;
      for (let i = 0; i < 15; i++) {
        await sleep(40);
        open = fdText(m.pid).includes(name);
        if (!open) break;
      }
      assert.equal(open, false);
    }
  } finally {
    fs.rmSync(file, { force: true });
    await m.stop();
    fs.rmSync(m.live, { recursive: true, force: true });
  }
});
