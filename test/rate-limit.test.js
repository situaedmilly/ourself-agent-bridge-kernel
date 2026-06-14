// test/rate-limit.test.js
// ── Bridge Pass 19C · Realm Gate failure rate limiting ──────────────────────
// Failed x-ourself-token attempts are throttled: after a threshold within a
// window the client is locked out (429 + Retry-After). A VALID token is never
// rate-limited — it always passes and clears the failure record, so the rightful
// operator can never be locked out. Uses throwaway tokens + a short tuned
// lockout via env; no production state is touched.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startBridge, tokenHeader } from './helpers/bridge-process.js';

const GATED = '/ourself/verify';   // token-gated GET, no side effects
const WRONG = 'definitely-not-the-token';

// Tuned low so the lockout is deterministic and fast.
let bridge;
before(async () => {
  bridge = await startBridge({ env: { REALM_GATE_MAX_FAILURES: '3', REALM_GATE_LOCKOUT_MS: '700' } });
});
after(async () => { await bridge?.stop(); });

const wrong = () => fetch(bridge.baseUrl + GATED, { headers: tokenHeader(WRONG) });
const missing = () => fetch(bridge.baseUrl + GATED);
const right = () => fetch(bridge.baseUrl + GATED, { headers: tokenHeader(bridge.token) });

test('failed attempts below threshold return 401', async () => {
  assert.equal((await wrong()).status, 401);   // 1
  assert.equal((await wrong()).status, 401);   // 2
});

test('threshold failure locks the gate with 429 + Retry-After', async () => {
  const r = await wrong();                       // 3rd → lock
  assert.equal(r.status, 429);
  assert.ok(r.headers.get('retry-after'), 'Retry-After header present');
  // subsequent wrong tokens stay locked
  assert.equal((await wrong()).status, 429);
});

test('VALID token is never rate-limited: passes during lockout and clears it', async () => {
  const ok = await right();
  assert.equal(ok.status, 200, 'valid token must pass even while locked');
  assert.equal((await ok.json()).authorized, true);
  // lockout cleared → a fresh wrong attempt is back to 401, not 429
  assert.equal((await wrong()).status, 401, 'failure counter reset after a valid auth');
});

test('a missing token also counts toward the lockout', async () => {
  // Fresh bridge for an independent counter.
  const b = await startBridge({ env: { REALM_GATE_MAX_FAILURES: '2', REALM_GATE_LOCKOUT_MS: '500' } });
  try {
    assert.equal((await fetch(b.baseUrl + GATED)).status, 401);            // 1 missing
    const r = await fetch(b.baseUrl + GATED);                              // 2 missing → lock
    assert.equal(r.status, 429);
    assert.ok(r.headers.get('retry-after'));
  } finally {
    await b.stop();
  }
});

test('the wrong/presented token never appears in the disposable logs', async () => {
  // Drive several failures, then scan the isolated logs for the attacker string.
  const b = await startBridge({ env: { REALM_GATE_MAX_FAILURES: '50' } });
  try {
    for (let i = 0; i < 5; i++) {
      await fetch(b.baseUrl + GATED, { headers: tokenHeader('LEAK_SENTINEL_TOKEN_' + i) });
    }
    for (const f of ['transmissions.jsonl', 'queue.jsonl']) {
      const raw = await readFile(join(b.tempDir, f), 'utf8').catch(() => '');
      assert.ok(!raw.includes('LEAK_SENTINEL_TOKEN'), `${f} must not contain presented tokens`);
    }
  } finally {
    await b.stop();
  }
});
