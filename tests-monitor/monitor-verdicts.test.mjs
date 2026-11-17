// Guard verdicts (aos-orch verify records, schema aos.verdict/1): GET /api/verdicts, the /api/state `verdicts` summary, session linking,
// bounded/sanitised reads. Fixtures are hand-written from the contract in docs/dashboard.md ("Guard view"); no orchestrator import.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { FIXTURES, tmpDir, startMonitor, sleep, hookEv } from './harness.mjs';

const TMP = tmpDir('aos-monverd-'), ORCH = path.join(TMP, 'orch'), VD = path.join(ORCH, 'verdicts'), LIVE = path.join(TMP, 'live');
let M;
const fx = (id) => JSON.parse(fs.readFileSync(path.join(FIXTURES, 'verdicts', id + '.json'), 'utf8'));
const put = (id, o) => fs.writeFileSync(path.join(VD, id + '.json'), typeof o === 'string' ? o : JSON.stringify(o));
before(async () => {
  fs.mkdirSync(VD, { recursive: true }); fs.mkdirSync(path.join(ORCH, 'goals')); fs.mkdirSync(LIVE);
  for (const f of fs.readdirSync(path.join(FIXTURES, 'verdicts'))) fs.copyFileSync(path.join(FIXTURES, 'verdicts', f), path.join(VD, f));
  // the session the integrity rejection belongs to (the hook log keeps the first 8 chars of the session id)
  const now = Date.now();
  fs.writeFileSync(path.join(LIVE, 'hook-events.ndjson'), hookEv({ ts: new Date(now - 5000).toISOString(), ev: 'SessionStart', sid: 'sessAAAA', cwd: 'shop' }) + hookEv({ ts: new Date(now - 4000).toISOString(), ev: 'UserPromptSubmit', sid: 'sessAAAA', cwd: 'shop' })
    + hookEv({ ts: new Date(now - 4000).toISOString(), ev: 'UserPromptSubmit', sid: 'otherBBB', cwd: 'misc' }));
  M = await startMonitor({ orch: ORCH, live: LIVE });
});
after(async () => { await M.stop(); fs.rmSync(TMP, { recursive: true, force: true }); });
const noPaths = (txt, what) => { assert.ok(!txt.includes('/fixture') && !txt.includes(TMP) && !txt.includes(os.tmpdir()) && !txt.includes('/Users/'), what + ': absolute path leaked'); assert.ok(!txt.includes('sessAAAA-1111'), what + ': full session id leaked'); };

test('GET /api/verdicts: newest first, mapped and classified', async () => {
  const r = await M.get('/api/verdicts');
  assert.equal(r.status, 200);
  const v = r.json.verdicts;
  assert.deepEqual(v.map((x) => x.id), ['v-20261021-120000-cccccc', 'v-20261021-110000-bbbbbb', 'v-20261021-100000-aaaaaa']);
  assert.deepEqual(v.map((x) => x.verdict), ['capability', 'integrity', 'verified']);
  const [cap, integ, ok] = v;
  assert.equal(ok.repo_name, 'shop'); assert.equal(ok.base, '0123456789ab'); assert.equal(ok.base_ref, 'main'); assert.equal(ok.tree, 'working'); assert.equal(ok.kind, null); assert.equal(ok.source, 'cli');
  assert.deepEqual(ok.checks, [{ cmd: 'node --test test/', ok: true, exit_code: 0, duration_ms: 812 }]);
  assert.equal(integ.kind, 'tests_edited'); assert.equal(integ.base_ref, null); assert.equal(integ.tree, 'fedcba987654'); assert.equal(integ.source, 'hook');
  assert.deepEqual(integ.rejections.map((x) => x.kind), ['tests_edited', 'vacuous_pass']);
  assert.equal(integ.rejections[0].detail, 'test/vat.test.js changed vs shop base');            // absolute path reduced to its basename
  assert.deepEqual(integ.failing_tests, ['test/vat.test.js: adds 20% VAT']);
  assert.deepEqual(integ.warnings, ['literal_copy src/expand.js: expected value copied from the test']);
  assert.equal(integ.checks[0].cmd, 'node vitest run');
  assert.equal(integ.agent, 'Claude Code·sess');                                                 // linked to the live session
  assert.equal(integ.session_id, undefined); assert.equal(ok.agent, undefined);
  assert.equal(cap.kind, 'checks_failed'); assert.equal(cap.failing_tests.length, 2); assert.equal(cap.checks.length, 2);
  noPaths(r.text, 'api');
});

test('/api/state: verdicts summary (counts + newest per repo) and the session guard badge', async () => {
  const s = (await M.get('/api/state')).json;
  assert.equal(s.verdicts.total, 3); assert.equal(s.verdicts.verified, 1); assert.equal(s.verdicts.integrity, 1); assert.equal(s.verdicts.capability, 1);
  assert.deepEqual(s.verdicts.latest.map((x) => [x.repo_name, x.verdict]), [['api', 'capability'], ['shop', 'integrity']]);
  const a = s.agents.find((x) => x.id === 'Claude Code·sess');
  assert.deepEqual(a.guard, { id: 'v-20261021-110000-bbbbbb', verdict: 'integrity', kind: 'tests_edited', created_at: '2026-10-21T11:00:00.000Z', repo_name: 'shop' });
  assert.equal(s.agents.find((x) => x.id === 'Claude Code·othe').guard, undefined);
  noPaths(JSON.stringify(s), 'state');
});

test('replay (?at=) omits verdicts and guard badges', async () => {
  const s = (await M.get('/api/state?at=' + encodeURIComponent(new Date().toISOString()))).json;
  assert.equal(s.replay, true); assert.equal(s.verdicts, undefined);
  assert.ok(s.agents.every((a) => a.guard === undefined));
});

test('malformed, oversized, wrong schema, bad ids, mismatched ids and symlinks are ignored', async (t) => {
  const good = fx('v-20261021-100000-aaaaaa'), mk = (id, o = {}) => ({ ...good, id, ...o });
  put('v-20261021-130000-000001', '{"schema":"aos.verdict/1","id":"v-2026');                                   // partial write
  put('v-20261021-130000-000002', mk('v-20261021-130000-000002', { schema: 'aos.verdict/2' }));                // wrong schema
  put('v-20261021-130000-000003', mk('v-20261021-130000-000099'));                                              // id != file name
  put('v-20261021-130000-000004', mk('v-20261021-130000-000004', { accepted: 'yes' }));                        // wrong type
  put('v-20261021-130000-000005', mk('v-20261021-130000-000005', { warnings: ['x'.repeat(70 * 1024)] }));      // > 64 KB
  put('v-20261021-130000-000006', '[1,2]');
  put('not-a-verdict', mk('not-a-verdict')); put('v-20261021-1300-zz', mk('v-20261021-1300-zz'));             // bad ids
  fs.writeFileSync(path.join(TMP, 'outside.json'), JSON.stringify(mk('v-20261021-130000-000007')));
  try { fs.symlinkSync(path.join(TMP, 'outside.json'), path.join(VD, 'v-20261021-130000-000007.json')); }     // symlink out of the dir
  catch (e) { if (process.platform !== 'win32' || e.code !== 'EPERM') throw e; t.diagnostic('file symlink case skipped: Windows refused the symlink (EPERM; needs Developer Mode or admin)'); }
  // junk inside a valid record: wrong-typed lists/fields are dropped, hostile text cleaned
  put('v-20261021-130000-000008', mk('v-20261021-130000-000008', { repo: 'relative/x', repo_name: '/etc/evil', rejections: 'no', checks: [null, { argv: 'rm -rf /' }], failing_tests: [1, 'a\u0007b /Users/me/secret/t.js: x'], source: 'bash', base: 'zz', tree: '../../x', tool_version: 7, accepted: false, integrity: true }));
  await sleep(1150);
  const v = (await M.get('/api/verdicts')).json.verdicts;
  assert.deepEqual(v.map((x) => x.id), ['v-20261021-130000-000008', 'v-20261021-120000-cccccc', 'v-20261021-110000-bbbbbb', 'v-20261021-100000-aaaaaa']);
  const j = v[0];
  assert.equal(j.repo_name, 'evil'); assert.deepEqual(j.rejections, []); assert.equal(j.kind, null); assert.equal(j.verdict, 'integrity');
  assert.deepEqual(j.checks, [{ cmd: 'rm -rf .', ok: false, exit_code: null, duration_ms: 0 }]); // argv as a joined string is the contract's form: shown as text (absolute paths scrubbed), never run assert.deepEqual(j.failing_tests, ['a b t.js: x']);
  assert.equal(j.source, 'unknown'); assert.equal(j.base, null); assert.equal(j.tree, null); assert.equal(j.tool_version, null);
  assert.equal((await M.get('/api/state')).json.verdicts.total, 4);
  const keep = new Set(fs.readdirSync(path.join(FIXTURES, 'verdicts')));
  for (const f of fs.readdirSync(VD)) if (!keep.has(f)) fs.rmSync(path.join(VD, f));
  await sleep(1150);
  assert.equal((await M.get('/api/verdicts')).json.verdicts.length, 3);
});

test('bounded: only the newest 200 verdict files are read; API returns 50', async () => {
  const d = path.join(TMP, 'orch-many'), live = path.join(TMP, 'live-many'); fs.mkdirSync(path.join(d, 'verdicts'), { recursive: true }); fs.mkdirSync(live);
  const good = fx('v-20261021-100000-aaaaaa');
  for (let i = 0; i < 260; i++) { const id = 'v-20261020-' + String(100000 + i) + '-abcdef'; fs.writeFileSync(path.join(d, 'verdicts', id + '.json'), JSON.stringify({ ...good, id })); }
  const m = await startMonitor({ orch: d, live });
  try {
    const s = (await m.get('/api/state')).json;
    assert.equal(s.verdicts.total, 200); assert.equal(s.verdicts.latest.length, 1);
    const v = (await m.get('/api/verdicts')).json.verdicts;
    assert.equal(v.length, 50); assert.equal(v[0].id, 'v-20261020-100259-abcdef');
  } finally { await m.stop(); }
});

test('no verdicts dir: empty summary; read-only guarantees on /api/verdicts', async () => {
  const live = path.join(TMP, 'live-none'); fs.mkdirSync(live);
  const m = await startMonitor({ orch: path.join(TMP, 'nope'), live });
  try {
    assert.deepEqual((await m.get('/api/verdicts')).json, { verdicts: [] });
    assert.deepEqual((await m.get('/api/state')).json.verdicts, { total: 0, verified: 0, integrity: 0, capability: 0, latest: [] });
  } finally { await m.stop(); }
  const req = (method, headers = {}) => new Promise((res, rej) => { const r = http.request({ host: '127.0.0.1', port: M.port, method, path: '/api/verdicts', headers, agent: false }, (x) => { x.resume(); x.on('end', () => res(x.statusCode)); }); r.on('error', rej); r.end(method === 'GET' ? undefined : '{}'); });
  assert.equal(await req('GET', { Host: 'evil.example' }), 403);
  assert.equal(await req('GET', { Origin: 'http://evil.example' }), 403);
  for (const m of ['POST', 'PUT', 'DELETE']) assert.equal(await req(m), 405);
});

test('a record written by the real `aos-orch verify` (argv as a joined string; generic + specific rejection kinds) maps correctly', async () => {
  // fixture: an actual orchestrator verdict for a rewritten test (repo path replaced, id set to sort newest), not hand-written
  const real = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'real-orchestrator-verdict.json'), 'utf8'));
  put(real.id, real); await sleep(1150); // the verdict index is cached for ~1 s
  try {
    const v = (await M.get('/api/verdicts')).json.verdicts.find((x) => x.id === real.id);
    assert.ok(v, 'the real record is listed');
    assert.equal(v.checks[0].cmd, 'node --test', 'a joined-string argv is shown as the command');
    assert.equal(v.kind, 'tests_edited', 'the headline is the specific integrity kind, not the generic protected_tests_failed');
    assert.deepEqual(v.rejections.map((r) => r.kind), ['protected_tests_failed', 'tests_edited']);
  } finally { fs.rmSync(path.join(VD, real.id + '.json'), { force: true }); await sleep(1150); }
});
