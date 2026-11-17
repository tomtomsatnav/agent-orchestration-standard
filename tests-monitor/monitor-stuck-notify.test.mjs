// An ignored notification (auth success, idle prompt) is not the user waiting. A quiet open turn after one is stuck.
// A notification that does need input still waits, and is not called stuck.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sleep, tmpDir, hookEv, startMonitor } from './harness.mjs';

const TMP = tmpDir('aos-monstuck-'); let M;
const now = Date.now(), at = (s) => new Date(now + s * 1000).toISOString();
const w = { cwd: 'proj', cwdp: '/x/proj' };

before(async () => {
  const live = path.join(TMP, 'live'), orch = path.join(TMP, 'orch');
  fs.mkdirSync(live, { recursive: true }); fs.mkdirSync(orch, { recursive: true });
  fs.writeFileSync(path.join(live, 'config.json'), JSON.stringify({ stuck_after_s: 5 }));
  const row = (sid, nt) => [
    hookEv({ ts: at(-30), ev: 'SessionStart', sid, ...w }),
    hookEv({ ts: at(-20), ev: 'UserPromptSubmit', sid, ...w }),
    hookEv({ ts: at(-12), ev: 'Notification', sid, ...nt, ...w }),
  ];
  fs.writeFileSync(path.join(live, 'hook-events.ndjson'), [
    ...row('auth0001', { nt: 'auth_success' }),
    ...row('idle0001', { nt: 'idle_prompt' }),
    ...row('need0001', { nt: 'permission_prompt' }),
  ].join(''));
  M = await startMonitor({ orch, live }); await sleep(300);
});
after(async () => { await M.stop(); fs.rmSync(TMP, { recursive: true, force: true }); });

const agent = (s, sid) => s.agents.find((a) => String(a.id).includes('·' + sid.slice(0, 4)));
const needs = (s, sid) => (s.alerts || []).filter((a) => a.kind === 'needs_input' && String(a.agent).includes('·' + sid.slice(0, 4)));

test('a quiet turn after an ignored notification is stuck, and does not ask for input', async () => {
  const s = (await M.get('/api/state')).json;
  for (const sid of ['auth0001', 'idle0001']) {
    const a = agent(s, sid);
    assert.ok(a, sid);
    assert.equal(a.status, 'running', sid);
    assert.equal(a.stuck, true, sid);
    assert.equal(needs(s, sid).length, 0, sid);
  }
});

test('a notification that needs input keeps the turn waiting', async () => {
  const s = (await M.get('/api/state')).json;
  const a = agent(s, 'need0001');
  assert.ok(a);
  assert.equal(a.status, 'running');
  assert.equal(a.stuck, false);
  assert.equal(needs(s, 'need0001').length, 1);
});
