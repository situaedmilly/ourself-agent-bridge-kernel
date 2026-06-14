// test/auth-gate.test.js
// ── Bridge Pass 20 · Auth gate against an isolated live bridge ───────────────
// Proves fail-closed startup, the 401 matrix on every state-changing route,
// that valid-token requests CROSS the auth boundary without invoking any live
// cognition provider (incomplete payloads → route validation), and that
// gate-free read routes stay public.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startBridge, startWithoutToken, tokenHeader, BRIDGE_DIR } from './helpers/bridge-process.js';

test('fail-closed: missing BRIDGE_TOKEN → non-zero exit, never listens', async () => {
  const { code, stderr } = await startWithoutToken();
  assert.notEqual(code, 0, 'server must exit non-zero without a token');
  assert.match(stderr, /BRIDGE_TOKEN is not set/, 'must announce fail-closed reason');
});

let bridge;
// Neutralize Pass 19C rate limiting for this suite: the 401 matrix issues many
// failed attempts against one shared bridge; a high threshold keeps these tests
// about authentication, not lockout (rate limiting is proven in rate-limit.test.js).
before(async () => { bridge = await startBridge({ env: { REALM_GATE_MAX_FAILURES: '100000' } }); });
after(async () => { await bridge?.stop(); });

test('valid token → isolated bridge is alive on 127.0.0.1 and NOT port 3001', () => {
  assert.match(bridge.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.notEqual(bridge.port, 3001, 'must never use the production port');
});

const STATE_ROUTES = [
  ['POST', '/transmit'],
  ['POST', '/approve/cmd-nonexistent'],
  ['POST', '/reject/cmd-nonexistent'],
  ['POST', '/test'],
  ['GET',  '/ourself/verify'],
];

for (const [method, path] of STATE_ROUTES) {
  test(`${method} ${path}: missing token → 401`, async () => {
    const r = await fetch(bridge.baseUrl + path, { method });
    assert.equal(r.status, 401);
  });
  test(`${method} ${path}: wrong token → 401`, async () => {
    const r = await fetch(bridge.baseUrl + path, { method, headers: tokenHeader('not-the-token') });
    assert.equal(r.status, 401);
  });
}

test('valid token crosses auth on /ourself/verify → 200', async () => {
  const r = await fetch(bridge.baseUrl + '/ourself/verify', { headers: tokenHeader(bridge.token) });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.authorized, true);
});

test('valid token + invalid /transmit payload → 400 (crossed auth, NO provider call)', async () => {
  const r = await fetch(bridge.baseUrl + '/transmit', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...tokenHeader(bridge.token) },
    body: JSON.stringify({ to: 'not-a-real-agent', message: 'x' }),
  });
  assert.equal(r.status, 400, 'rejected by route validation, not auth, before any agent call');
});

test('valid token + unknown /approve id → 404 (crossed auth, no execution)', async () => {
  const r = await fetch(bridge.baseUrl + '/approve/cmd-does-not-exist', {
    method: 'POST', headers: tokenHeader(bridge.token),
  });
  assert.equal(r.status, 404);
});

test('valid token /test → 200 queues the FIXED diagnostic (Pass 19B)', async () => {
  const r = await fetch(bridge.baseUrl + '/test', {
    method: 'POST', headers: tokenHeader(bridge.token),
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.command.status, 'pending');
  assert.equal(j.command.action, 'git status --short', 'server-owned diagnostic');
  assert.equal(j.command.workingDir, BRIDGE_DIR, 'working dir pinned to the bridge repo');
});

test('Pass 19B: malicious /test body cannot inject a command or working dir', async () => {
  const r = await fetch(bridge.baseUrl + '/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...tokenHeader(bridge.token) },
    body: JSON.stringify({ action: 'chmod 777 .env.example', working_dir: '/tmp', rationale: 'inject attempt' }),
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.command.action, 'git status --short', 'caller action must be ignored');
  assert.equal(j.command.workingDir, BRIDGE_DIR, 'caller working_dir must be ignored');
  assert.notEqual(j.command.workingDir, '/tmp');
  assert.ok(!j.command.rationale.includes('inject'), 'caller rationale must not be reflected');
  assert.equal(j.command.status, 'pending', 'still requires explicit approval');
});

const READ_ROUTES = ['/health', '/pending', '/log', '/ourself', '/ourself/state', '/ourself/ledger'];
for (const path of READ_ROUTES) {
  test(`gate-free read ${path} → reachable without token`, async () => {
    const r = await fetch(bridge.baseUrl + path);
    assert.ok(r.status === 200, `${path} should be publicly readable (got ${r.status})`);
  });
}
