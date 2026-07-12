// test/timeself.test.js
// ── T-034: TIMESELF targeted proofs — institutional time is not authority ───

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeClock, createSystemClock, createTimeself, TIMESELF_VERSION } from '../runtime/timeself.js';

const KERNEL_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function fakeTimeself(startIso = '2026-07-11T00:00:00.000Z') {
  const clock = createFakeClock({ startIso });
  return { clock, timeself: createTimeself(clock) };
}

test('1. timeself carries its version and the injected clock kind', () => {
  const { timeself } = fakeTimeself();
  assert.equal(timeself.timeself_version, TIMESELF_VERSION);
  assert.equal(timeself.clock_kind, 'fake');
  assert.equal(createTimeself(createSystemClock()).clock_kind, 'system');
});

test('2. all timestamps come from the injected clock and advance deterministically', () => {
  const { clock, timeself } = fakeTimeself();
  assert.equal(timeself.now(), '2026-07-11T00:00:00.000Z');
  clock.advance(90_000);
  assert.equal(timeself.now(), '2026-07-11T00:01:30.000Z');
  clock.advance(0);
  assert.equal(timeself.now(), '2026-07-11T00:01:30.000Z', 'no advance without instruction');
});

test('3. eligibility: absent eligible_at is eligible; future is not; reached is', () => {
  const { clock, timeself } = fakeTimeself();
  assert.equal(timeself.isEligible({}), true);
  assert.equal(timeself.isEligible({ eligible_at: null }), true);
  const item = { eligible_at: '2026-07-11T00:05:00.000Z' };
  assert.equal(timeself.isEligible(item), false);
  clock.advance(5 * 60_000);
  assert.equal(timeself.isEligible(item), true);
  assert.equal(timeself.isEligible({ eligible_at: 'not-a-date' }), false, 'unparseable eligibility fails closed');
});

test('4. expiry: NO_EXPIRY never expires; a passed expires_at does', () => {
  const { clock, timeself } = fakeTimeself();
  assert.equal(timeself.isExpired({ expires_at: 'NO_EXPIRY' }), false);
  const item = { expires_at: '2026-07-11T00:01:00.000Z' };
  assert.equal(timeself.isExpired(item), false);
  clock.advance(61_000);
  assert.equal(timeself.isExpired(item), true);
});

test('5. queue age is measured from created_at and never negative', () => {
  const { clock, timeself } = fakeTimeself();
  const item = { created_at: '2026-07-11T00:00:00.000Z' };
  clock.advance(30_000);
  assert.equal(timeself.queueAgeMs(item), 30_000);
  assert.equal(timeself.queueAgeMs({ created_at: '2026-07-11T09:00:00.000Z' }), 0, 'future created_at clamps to zero');
});

test('6. lease deadline is bounded and lease expiry is detected', () => {
  const { clock, timeself } = fakeTimeself();
  assert.equal(timeself.leaseDeadline(60_000), '2026-07-11T00:01:00.000Z');
  const capped = timeself.leaseDeadline(999_999_999);
  assert.equal(capped, '2026-07-11T00:15:00.000Z', 'lease duration clamps to the 15-minute law');
  const lease = { lease_expires_at: timeself.leaseDeadline(1000) };
  assert.equal(timeself.isLeaseExpired(lease), false);
  clock.advance(1001);
  assert.equal(timeself.isLeaseExpired(lease), true);
  assert.equal(timeself.isLeaseExpired({}), true, 'a lease without an expiry fails closed as expired');
});

test('7. retry deadline backs off exponentially and is bounded', () => {
  const { timeself } = fakeTimeself();
  assert.equal(timeself.retryDeadline({ baseDelayMs: 1000 }, 1), '2026-07-11T00:00:01.000Z');
  assert.equal(timeself.retryDeadline({ baseDelayMs: 1000 }, 2), '2026-07-11T00:00:02.000Z');
  assert.equal(timeself.retryDeadline({ baseDelayMs: 1000 }, 4), '2026-07-11T00:00:08.000Z');
  assert.equal(timeself.retryDeadline({ baseDelayMs: 60 * 60_000 }, 10), '2026-07-11T01:00:00.000Z', 'delay clamps to one hour');
});

test('8. heartbeat deadline and staleness law', () => {
  const { clock, timeself } = fakeTimeself();
  assert.equal(timeself.heartbeatDeadline(15_000), '2026-07-11T00:00:15.000Z');
  assert.equal(timeself.isHeartbeatStale('2026-07-11T00:00:00.000Z', 30_000), false);
  clock.advance(31_000);
  assert.equal(timeself.isHeartbeatStale('2026-07-11T00:00:00.000Z', 30_000), true);
  assert.equal(timeself.isHeartbeatStale(null, 30_000), true, 'missing heartbeat is stale');
});

test('9. wall-clock rollback never produces a negative monotonic duration', () => {
  const { clock, timeself } = fakeTimeself();
  const start = timeself.monotonicNow();
  clock.advance(10_000);
  clock.setWall('2026-07-10T00:00:00.000Z'); // wall rolls back a full day
  assert.equal(timeself.elapsedMs(start), 10_000, 'duration follows monotonic time, not wall time');
  assert.ok(timeself.monotonicNow() >= start);
  assert.equal(timeself.delayUntilMs('2026-07-09T00:00:00.000Z'), 0, 'past instants clamp to zero delay');
});

test('10. maintenance-window state is deterministic NONE under T-034', () => {
  const { timeself } = fakeTimeself();
  assert.deepEqual(timeself.maintenanceWindowState(), { state: 'NONE', window: null });
});

test('11. identical scheduler scenario under the fake clock reproduces exactly (determinism)', () => {
  const run = () => {
    const { clock, timeself } = fakeTimeself();
    const decisions = [];
    const item = { eligible_at: '2026-07-11T00:00:10.000Z', expires_at: '2026-07-11T00:01:00.000Z', created_at: '2026-07-11T00:00:00.000Z' };
    for (let i = 0; i < 8; i++) {
      decisions.push({ t: timeself.now(), eligible: timeself.isEligible(item), expired: timeself.isExpired(item), age: timeself.queueAgeMs(item) });
      clock.advance(10_000);
    }
    return decisions;
  };
  assert.deepEqual(run(), run());
});

test('12. no direct Date.now/new Date use exists in runtime logic outside the clock adapter', () => {
  const files = [
    'persistence/queue-store.js',
    'runtime/bridge-self.js',
    'runtime/runtime-self.js',
    'runtime/recovery.js',
    'runtime/health.js',
    'runtime/orchestrator.js',
  ];
  for (const f of files) {
    const src = readFileSync(join(KERNEL_ROOT, f), 'utf8');
    assert.equal(/Date\.now\(|new Date\(/.test(src), false, `${f} must not construct its own time`);
  }
  const timeselfSrc = readFileSync(join(KERNEL_ROOT, 'runtime/timeself.js'), 'utf8');
  assert.ok(/Date\.now\(/.test(timeselfSrc), 'the system-clock adapter is the single Date boundary');
});

test('13. TIMESELF contains no authority surface', () => {
  const src = readFileSync(join(KERNEL_ROOT, 'runtime/timeself.js'), 'utf8');
  for (const forbidden of ['executeAuthorizedProposal', 'execution_class', 'decision_state', 'presentedToken', 'spawn(']) {
    assert.equal(src.includes(forbidden), false, `timeself.js must not reference ${forbidden}`);
  }
  const { timeself } = fakeTimeself();
  assert.equal(Object.isFrozen(timeself), true, 'the timeself surface is frozen');
});
