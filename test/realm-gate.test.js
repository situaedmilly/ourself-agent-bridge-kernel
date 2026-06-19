// test/realm-gate.test.js
// ── Bridge Pass 20B.1 · Deterministic Realm Gate rate limiter ───────────────
// The Pass 19C limiter logic, proven with INJECTED time — no sleeping, no
// wall-clock windows. Time is a plain variable the test advances explicitly, so
// every threshold, lockout, reset, and expiry is reproducible bit-for-bit. This
// retires the rare wall-clock flake that lived in the HTTP rate-limit suite.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRealmGate } from '../tools/realm-gate.js';

const KEY = '203.0.113.7';
const cfg = { maxFailures: 3, windowMs: 1000, lockoutMs: 5000 };
const newGate = () => createRealmGate(cfg);

// ── 1 · wrong-token attempts reach threshold deterministically ──────────────
test('1. failures reach the threshold deterministically', () => {
  const g = newGate();
  const t = 1_000_000;
  assert.equal(g.evaluate(KEY, false, t).outcome, 'unauthorized'); // 1
  assert.equal(g.evaluate(KEY, false, t).outcome, 'unauthorized'); // 2
  const third = g.evaluate(KEY, false, t);                          // 3 → lock
  assert.equal(third.outcome, 'locked');
  assert.equal(third.justLocked, true);
  assert.equal(third.count, 3);
});

// ── 2 · lockout state returned deterministically (maps to 429) ──────────────
test('2. once locked, further wrong attempts stay locked', () => {
  const g = newGate();
  const t = 5_000;
  for (let i = 0; i < cfg.maxFailures; i++) g.evaluate(KEY, false, t);
  const after = g.evaluate(KEY, false, t + 10);
  assert.equal(after.outcome, 'locked');
  assert.ok(!after.justLocked, 'subsequent lock is not a fresh lock event');
});

// ── 3 · Retry-After present and correct/stable ─────────────────────────────
test('3. Retry-After is correct and deterministic', () => {
  const g = newGate();
  const t = 0;
  let v;
  for (let i = 0; i < cfg.maxFailures; i++) v = g.evaluate(KEY, false, t);
  assert.equal(v.retryAfter, Math.ceil(cfg.lockoutMs / 1000)); // 5 at the moment of locking
  // As time advances inside the lockout, Retry-After counts down deterministically.
  assert.equal(g.evaluate(KEY, false, t + 1000).retryAfter, 4);
  assert.equal(g.evaluate(KEY, false, t + 4000).retryAfter, 1);
});

// ── 4 · missing-token attempts count deterministically ─────────────────────
test('4. missing token (valid=false) counts identically to a wrong token', () => {
  const g = newGate();
  const t = 42;
  // "missing" and "wrong" both arrive as valid=false — same counting path.
  assert.equal(g.evaluate(KEY, false, t).outcome, 'unauthorized');
  assert.equal(g.evaluate(KEY, false, t).outcome, 'unauthorized');
  assert.equal(g.evaluate(KEY, false, t).outcome, 'locked');
});

// ── 5 · valid token clears failure state deterministically ──────────────────
test('5. a valid token clears the failure record', () => {
  const g = newGate();
  const t = 100;
  g.evaluate(KEY, false, t);
  g.evaluate(KEY, false, t);
  assert.equal(g.failures.has(KEY), true, 'failures accumulated');
  assert.equal(g.evaluate(KEY, true, t).outcome, 'pass');
  assert.equal(g.failures.has(KEY), false, 'valid auth cleared the record');
  // A fresh wrong attempt starts a new count, not a continuation.
  assert.equal(g.evaluate(KEY, false, t).outcome, 'unauthorized');
  assert.equal(g.failures.get(KEY).count, 1);
});

// ── 6 · valid token passes during an attacker lockout ───────────────────────
test('6. a valid token passes even while the key is locked out', () => {
  const g = newGate();
  const t = 9_000;
  for (let i = 0; i < cfg.maxFailures; i++) g.evaluate(KEY, false, t); // locked
  assert.equal(g.evaluate(KEY, false, t).outcome, 'locked', 'attacker stays locked');
  // The rightful operator is never rate-limited.
  assert.equal(g.evaluate(KEY, true, t).outcome, 'pass', 'valid token passes during lockout');
  assert.equal(g.failures.has(KEY), false, 'and the lockout is cleared');
});

// ── 7 · lockout expiration advanced deterministically, no real waiting ──────
test('7. lockout expiry is reached by advancing injected time, not by waiting', () => {
  const g = newGate();
  const t = 1_000;
  for (let i = 0; i < cfg.maxFailures; i++) g.evaluate(KEY, false, t); // locked until t+5000
  assert.equal(g.evaluate(KEY, false, t + 4999).outcome, 'locked', 'still locked just before expiry');
  // Advance past the lockout — purely by passing a larger `now`.
  const expired = g.evaluate(KEY, false, t + 5001);
  assert.equal(expired.outcome, 'unauthorized', 'lockout expired → counting resumes');
  assert.equal(g.failures.get(KEY).count, 1, 'a fresh window begins');
});

// ── 8 · no presented tokens / secrets enter the limiter or its state ────────
test('8. the limiter never receives or stores a token value', () => {
  const g = newGate();
  const t = 7;
  g.evaluate(KEY, false, t);
  const rec = g.failures.get(KEY);
  // The stored record is purely numeric bookkeeping — no token field anywhere.
  assert.deepEqual(Object.keys(rec).sort(), ['count', 'lockedUntil', 'windowStart']);
  for (const v of Object.values(rec)) assert.equal(typeof v, 'number');
  // evaluate() signature takes a boolean `valid`, never the token string.
  assert.equal(g.evaluate.length, 3);
});

// ── window reset (supporting behavior, deterministic) ───────────────────────
test('a fresh window starts after the window elapses without locking', () => {
  const g = newGate();
  const t = 200;
  g.evaluate(KEY, false, t);
  g.evaluate(KEY, false, t);                         // count 2 (< 3)
  const v = g.evaluate(KEY, false, t + cfg.windowMs + 1); // window elapsed → reset to 1
  assert.equal(v.outcome, 'unauthorized');
  assert.equal(g.failures.get(KEY).count, 1);
});
