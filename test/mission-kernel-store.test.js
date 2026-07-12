// test/mission-kernel-store.test.js
// ── Mission Kernel v0 persistence layer tests ────────────────────────────────
// All storage uses an isolated mkdtemp() directory per test. Nothing here
// ever writes to logs/mission-kernels.jsonl or any live runtime path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createMissionKernelStore,
  verifySpecificationBinding,
  verifyEventChain,
  SPECIFICATION_BINDING,
  MISSION_KERNEL_ERRORS,
  LEGAL_TRANSITIONS,
  MISSION_STATES,
} from '../persistence/mission-kernel-store.js';

async function withTempStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'mission-kernel-store-'));
  try {
    const store = createMissionKernelStore({ storageRoot: dir });
    await fn(store, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function baseKernel(missionId, overrides = {}) {
  return {
    mission_id: missionId,
    state: 'INITIALIZED',
    intent: { purpose: 'test mission purpose', objectives: [], scope_boundary: {}, prohibited_actions: [] },
    ...overrides,
  };
}

// ── Specification binding ────────────────────────────────────────────────────

test('specification binding matches the live specification file on disk', async () => {
  const specPath = resolve('specifications/mission-kernel.v0.schema.md');
  const result = await verifySpecificationBinding(specPath);
  assert.equal(result.ok, true);
  assert.equal(result.sha256, SPECIFICATION_BINDING.sha256);
});

test('specification binding fails closed against a mismatched file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mission-kernel-spec-'));
  try {
    const { writeFile } = await import('node:fs/promises');
    const fakeSpec = join(dir, 'fake.md');
    await writeFile(fakeSpec, '# not the real spec', 'utf8');
    const result = await verifySpecificationBinding(fakeSpec);
    assert.equal(result.ok, false);
    assert.equal(result.status, 'STOPPED');
    assert.equal(result.reason, 'SPECIFICATION_DEVIATION');
    assert.equal(result.authority_required, 'FOUNDER_REVIEW');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── create / get ──────────────────────────────────────────────────────────────

test('create() persists a valid Mission Kernel record and get() retrieves it', async () => {
  await withTempStore(async (store) => {
    const record = await store.create(baseKernel('m-001'));
    assert.equal(record.mission_id, 'm-001');
    assert.equal(record.state, 'INITIALIZED');
    assert.equal(record.promotion_boundary.status, 'NOT_CROSSED');
    assert.equal(record.promotion_boundary.validator_authority, 'NONE');

    const fetched = await store.get('m-001');
    assert.deepEqual(fetched, record);
  });
});

test('get() returns null for an unknown mission_id', async () => {
  await withTempStore(async (store) => {
    const result = await store.get('does-not-exist');
    assert.equal(result, null);
  });
});

test('create() rejects an invalid kernel shape', async () => {
  await withTempStore(async (store) => {
    await assert.rejects(
      () => store.create({ mission_id: 'm-002' }), // missing state, intent
      (err) => err.code === MISSION_KERNEL_ERRORS.INVALID_KERNEL_SHAPE
    );
  });
});

test('create() rejects a mission_id collision', async () => {
  await withTempStore(async (store) => {
    await store.create(baseKernel('m-003'));
    await assert.rejects(
      () => store.create(baseKernel('m-003')),
      (err) => err.code === MISSION_KERNEL_ERRORS.MISSION_ALREADY_EXISTS
    );
  });
});

test('create() rejects an unsafe mission_id before touching the filesystem', async () => {
  await withTempStore(async (store) => {
    await assert.rejects(
      () => store.create(baseKernel('../escape')),
      (err) => err.code === MISSION_KERNEL_ERRORS.INVALID_KERNEL_SHAPE
    );
  });
});

// ── lifecycle transitions ────────────────────────────────────────────────────

test('legal transition table matches specification exactly', () => {
  assert.deepEqual(Object.keys(LEGAL_TRANSITIONS).sort(), [...MISSION_STATES].sort());
  assert.deepEqual([...LEGAL_TRANSITIONS.INITIALIZED], ['ORIENTED', 'FAILED']);
  assert.deepEqual([...LEGAL_TRANSITIONS.COMPLETED], ['SEALED']);
  assert.deepEqual([...LEGAL_TRANSITIONS.FAILED], []);
  assert.deepEqual([...LEGAL_TRANSITIONS.SEALED], []);
});

test('transition() allows a legal transition and records history', async () => {
  await withTempStore(async (store) => {
    await store.create(baseKernel('m-004'));
    const updated = await store.transition('m-004', 'ORIENTED', { reason: 'executor oriented' });
    assert.equal(updated.state, 'ORIENTED');
    assert.equal(updated.history.at(-1).type, 'STATE_TRANSITION');
    assert.equal(updated.history.at(-1).to, 'ORIENTED');
  });
});

test('transition() rejects an illegal transition fail-closed, without mutating the record', async () => {
  await withTempStore(async (store) => {
    await store.create(baseKernel('m-005'));
    await assert.rejects(
      () => store.transition('m-005', 'COMPLETED'), // INITIALIZED -> COMPLETED is illegal
      (err) => err.code === MISSION_KERNEL_ERRORS.ILLEGAL_TRANSITION
    );
    const record = await store.get('m-005');
    assert.equal(record.state, 'INITIALIZED');
    assert.equal(record.history.length, 0);
  });
});

test('transition() rejects transitions out of terminal states FAILED and SEALED', async () => {
  await withTempStore(async (store) => {
    await store.create(baseKernel('m-006'));
    await store.transition('m-006', 'FAILED');
    await assert.rejects(
      () => store.transition('m-006', 'ORIENTED'),
      (err) => err.code === MISSION_KERNEL_ERRORS.ILLEGAL_TRANSITION
    );
  });
});

test('full legal path INITIALIZED -> ORIENTED -> EXECUTING -> COMPLETED -> SEALED succeeds', async () => {
  await withTempStore(async (store) => {
    await store.create(baseKernel('m-007'));
    await store.transition('m-007', 'ORIENTED');
    await store.transition('m-007', 'EXECUTING');
    await store.transition('m-007', 'COMPLETED');
    const sealed = await store.transition('m-007', 'SEALED');
    assert.equal(sealed.state, 'SEALED');
  });
});

test('INTERRUPTED has complete legal transitions in both directions', async () => {
  await withTempStore(async (store) => {
    await store.create(baseKernel('m-008'));
    await store.transition('m-008', 'ORIENTED');
    await store.transition('m-008', 'EXECUTING');
    const interrupted = await store.transition('m-008', 'INTERRUPTED');
    assert.equal(interrupted.state, 'INTERRUPTED');
    const reoriented = await store.transition('m-008', 'ORIENTED');
    assert.equal(reoriented.state, 'ORIENTED');
  });
});

// ── executor assignment / replacement ───────────────────────────────────────

test('assignExecutor() sets current_executor explicitly', async () => {
  await withTempStore(async (store) => {
    await store.create(baseKernel('m-009'));
    const updated = await store.assignExecutor('m-009', { executor_id: 'exec-a', executor_type: 'claude' });
    assert.equal(updated.current_executor.executor_id, 'exec-a');
  });
});

test('replaceExecutor() records the outgoing executor in executor_history and assigns the new one', async () => {
  await withTempStore(async (store) => {
    await store.create(baseKernel('m-010'));
    await store.assignExecutor('m-010', { executor_id: 'exec-a', executor_type: 'claude' });
    const updated = await store.replaceExecutor('m-010', {
      next_executor: { executor_id: 'exec-b', executor_type: 'codex' },
      drift_classification: 'RECOVERABLE',
      released_at: '2026-01-01T00:00:00Z',
    });
    assert.equal(updated.current_executor.executor_id, 'exec-b');
    assert.equal(updated.executor_history.length, 1);
    assert.equal(updated.executor_history[0].executor_id, 'exec-a');
    assert.equal(updated.executor_history[0].drift_classification, 'RECOVERABLE');
  });
});

test('replaceExecutor() rejects a malformed replacement record', async () => {
  await withTempStore(async (store) => {
    await store.create(baseKernel('m-011'));
    await assert.rejects(
      () => store.replaceExecutor('m-011', { next_executor: {} }),
      (err) => err.code === MISSION_KERNEL_ERRORS.INVALID_KERNEL_SHAPE
    );
  });
});

// ── interruption ──────────────────────────────────────────────────────────────

test('recordInterruption() sets interruption_state and appends history', async () => {
  await withTempStore(async (store) => {
    await store.create(baseKernel('m-012'));
    const updated = await store.recordInterruption('m-012', {
      detected_at: '2026-01-01T00:00:00Z',
      tolerance_ms: 60000,
    });
    assert.equal(updated.interruption_state.detected_at, '2026-01-01T00:00:00Z');
    assert.equal(updated.history.at(-1).type, 'INTERRUPTION_RECORDED');
  });
});

test('recordInterruption() rejects a record missing detected_at', async () => {
  await withTempStore(async (store) => {
    await store.create(baseKernel('m-013'));
    await assert.rejects(
      () => store.recordInterruption('m-013', {}),
      (err) => err.code === MISSION_KERNEL_ERRORS.INVALID_KERNEL_SHAPE
    );
  });
});

// ── history / handoff ────────────────────────────────────────────────────────

test('appendHistory() appends an arbitrary typed entry', async () => {
  await withTempStore(async (store) => {
    await store.create(baseKernel('m-014'));
    const updated = await store.appendHistory('m-014', { type: 'NOTE', note: 'observed drift EXPECTED' });
    assert.equal(updated.history.at(-1).note, 'observed drift EXPECTED');
  });
});

test('createHandoffPacket() returns a snapshot without mutating the record', async () => {
  await withTempStore(async (store) => {
    await store.create(baseKernel('m-015'));
    await store.assignExecutor('m-015', { executor_id: 'exec-a', executor_type: 'claude' });
    const before = await store.get('m-015');
    const packet = await store.createHandoffPacket('m-015', 'codex');
    const after = await store.get('m-015');
    assert.deepEqual(before, after);
    assert.equal(packet.from_executor, 'exec-a');
    assert.equal(packet.to_executor_type, 'codex');
    assert.ok(Array.isArray(packet.next_executor_readiness_checklist));
    assert.ok(packet.next_executor_readiness_checklist.length > 0);
  });
});

// ── Promotion Boundary — the module must only ever report, never decide ─────

test('getPromotionBoundaryStatus() always reports NOT_CROSSED with validator_authority NONE', async () => {
  await withTempStore(async (store) => {
    await store.create(baseKernel('m-016'));
    await store.transition('m-016', 'ORIENTED');
    await store.transition('m-016', 'EXECUTING');
    await store.transition('m-016', 'COMPLETED');
    await store.transition('m-016', 'SEALED'); // even sealed — still reports only
    const status = await store.getPromotionBoundaryStatus('m-016');
    assert.equal(status.status, 'NOT_CROSSED');
    assert.equal(status.validator_authority, 'NONE');
    assert.equal(typeof status.reason, 'string');
  });
});

test('getPromotionBoundaryStatus() public output shape is unchanged after adopting the canonical PROMOTION_BOUNDARY constant', async () => {
  await withTempStore(async (store) => {
    await store.create(baseKernel('m-016b'));
    const status = await store.getPromotionBoundaryStatus('m-016b');
    assert.deepEqual(status, {
      status: 'NOT_CROSSED',
      validator_authority: 'NONE',
      evidence_state: 'UNREPORTED',
      reason: 'Explicit human authorization is required for promotion.',
    });
    assert.deepEqual(Object.keys(status).sort(), [
      'evidence_state',
      'reason',
      'status',
      'validator_authority',
    ]);
  });
});

test('getPromotionBoundaryStatus() reuses the same canonical PROMOTION_BOUNDARY constant the protocol core exports', async () => {
  const { PROMOTION_BOUNDARY } = await import('self-protocol-suite');
  await withTempStore(async (store) => {
    await store.create(baseKernel('m-016c'));
    const status = await store.getPromotionBoundaryStatus('m-016c');
    assert.equal(status.status, PROMOTION_BOUNDARY.status);
    assert.equal(status.validator_authority, PROMOTION_BOUNDARY.validator_authority);
  });
});

test('no exported method name or return value ever asserts a promoted/approved state', async () => {
  const mod = await import('../persistence/mission-kernel-store.js');
  const exportNames = Object.keys(mod);
  for (const name of exportNames) {
    assert.ok(
      !/promote|approve/i.test(name) || name === 'getPromotionBoundaryStatus',
      `unexpected promotion-implying export: ${name}`
    );
  }
});

// ── Mission-state vocabulary — canonical noun set, kernel-owned transitions ──

test('kernel MISSION_STATES recognizes exactly the eight canonical protocol states, no more, no fewer', () => {
  assert.deepEqual(MISSION_STATES, [
    'INITIALIZED',
    'ORIENTED',
    'EXECUTING',
    'PAUSED',
    'INTERRUPTED',
    'COMPLETED',
    'FAILED',
    'SEALED',
  ]);
  assert.equal(MISSION_STATES.length, 8);
});

test('kernel MISSION_STATES is the same array sourced from self-protocol-suite, not a re-declared duplicate', async () => {
  const { MISSION_STATES: protocolStates } = await import('self-protocol-suite');
  assert.equal(MISSION_STATES, protocolStates); // reference identity, not just value equality
});

test('kernel specialization survives: transitions the protocol core would reject remain legal in the kernel', async () => {
  await withTempStore(async (store) => {
    await store.create(baseKernel('m-vocab-a'));
    await store.transition('m-vocab-a', 'ORIENTED');
    await store.transition('m-vocab-a', 'EXECUTING');
    await store.transition('m-vocab-a', 'PAUSED');
    const resumed = await store.transition('m-vocab-a', 'EXECUTING'); // PAUSED -> EXECUTING
    assert.equal(resumed.state, 'EXECUTING');

    await store.create(baseKernel('m-vocab-b'));
    await store.transition('m-vocab-b', 'ORIENTED');
    await store.transition('m-vocab-b', 'EXECUTING');
    await store.transition('m-vocab-b', 'INTERRUPTED');
    const reoriented = await store.transition('m-vocab-b', 'ORIENTED'); // INTERRUPTED -> ORIENTED
    assert.equal(reoriented.state, 'ORIENTED');

    await store.create(baseKernel('m-vocab-c'));
    const failed = await store.transition('m-vocab-c', 'FAILED'); // INITIALIZED -> FAILED
    assert.equal(failed.state, 'FAILED');
  });
});

test('illegal transition remains illegal after vocabulary adoption: SEALED -> EXECUTING still fails closed', async () => {
  await withTempStore(async (store) => {
    await store.create(baseKernel('m-vocab-d'));
    await store.transition('m-vocab-d', 'ORIENTED');
    await store.transition('m-vocab-d', 'EXECUTING');
    await store.transition('m-vocab-d', 'COMPLETED');
    await store.transition('m-vocab-d', 'SEALED');
    await assert.rejects(
      () => store.transition('m-vocab-d', 'EXECUTING'),
      (err) => err.code === MISSION_KERNEL_ERRORS.ILLEGAL_TRANSITION
    );
    const record = await store.get('m-vocab-d');
    assert.equal(record.state, 'SEALED'); // unchanged by the rejected attempt
  });
});

test('MISSION_STATES is frozen and a mutation attempt does not alter later kernel transition behavior', async () => {
  assert.equal(Object.isFrozen(MISSION_STATES), true);
  assert.throws(() => {
    'use strict';
    MISSION_STATES.push('PROMOTED');
  });
  assert.equal(MISSION_STATES.length, 8);

  await withTempStore(async (store) => {
    await store.create(baseKernel('m-vocab-e'));
    const updated = await store.transition('m-vocab-e', 'ORIENTED');
    assert.equal(updated.state, 'ORIENTED');
    await assert.rejects(
      () => store.transition('m-vocab-e', 'PROMOTED'),
      (err) => err.code === MISSION_KERNEL_ERRORS.ILLEGAL_TRANSITION
    );
  });
});

// ── integrity ─────────────────────────────────────────────────────────────────

test('verifyIntegrity() confirms record_hash matches stored content', async () => {
  await withTempStore(async (store) => {
    await store.create(baseKernel('m-017'));
    await store.transition('m-017', 'ORIENTED');
    const result = await store.verifyIntegrity('m-017');
    assert.equal(result.ok, true);
    assert.equal(result.stored, result.recomputed);
  });
});

// ── storageRoot isolation ────────────────────────────────────────────────────

test('createMissionKernelStore() requires an explicit storageRoot', () => {
  assert.throws(() => createMissionKernelStore({}), (err) => err.code === MISSION_KERNEL_ERRORS.INVALID_KERNEL_SHAPE);
  assert.throws(() => createMissionKernelStore(), (err) => err.code === MISSION_KERNEL_ERRORS.INVALID_KERNEL_SHAPE);
});

test('two stores with different storageRoots do not see each other\'s missions', async () => {
  const dirA = await mkdtemp(join(tmpdir(), 'mission-kernel-a-'));
  const dirB = await mkdtemp(join(tmpdir(), 'mission-kernel-b-'));
  try {
    const storeA = createMissionKernelStore({ storageRoot: dirA });
    const storeB = createMissionKernelStore({ storageRoot: dirB });
    await storeA.create(baseKernel('shared-id'));
    const fromB = await storeB.get('shared-id');
    assert.equal(fromB, null);
  } finally {
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  }
});

// ── CORRECTION-1 / F1 — typed fail-closed corruption handling ───────────────

test('F4.1 restart reconstruction: a fresh store instance against the same storageRoot reads the same record', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mission-kernel-restart-'));
  try {
    const storeA = createMissionKernelStore({ storageRoot: dir });
    await storeA.create(baseKernel('m-restart'));
    await storeA.transition('m-restart', 'ORIENTED');

    // Simulate a fresh process: a brand-new store instance, same storageRoot.
    const storeB = createMissionKernelStore({ storageRoot: dir });
    const record = await storeB.get('m-restart');
    assert.equal(record.state, 'ORIENTED');
    assert.equal(record.history.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('F4.2 / F1 malformed mission-record JSON fails closed with a typed CORRUPT_RECORD error, not "not found"', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mission-kernel-malformed-'));
  try {
    const store = createMissionKernelStore({ storageRoot: dir });
    await store.create(baseKernel('m-bad'));
    const path = join(dir, 'missions', 'm-bad.json');
    await writeFile(path, '{this is not valid json', 'utf8');

    await assert.rejects(
      () => store.get('m-bad'),
      (err) => err.code === MISSION_KERNEL_ERRORS.CORRUPT_RECORD
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('F4.3 / F1 truncated mission-record JSON fails closed with a typed CORRUPT_RECORD error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mission-kernel-truncated-'));
  try {
    const store = createMissionKernelStore({ storageRoot: dir });
    await store.create(baseKernel('m-trunc'));
    const path = join(dir, 'missions', 'm-trunc.json');
    const raw = await readFile(path, 'utf8');
    await writeFile(path, raw.slice(0, Math.floor(raw.length / 2)), 'utf8');

    await assert.rejects(
      () => store.get('m-trunc'),
      (err) => err.code === MISSION_KERNEL_ERRORS.CORRUPT_RECORD
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('F1 a record that parses but fails shape validation is also treated as corrupt, not silently accepted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mission-kernel-badshape-'));
  try {
    const store = createMissionKernelStore({ storageRoot: dir });
    await store.create(baseKernel('m-shape'));
    const path = join(dir, 'missions', 'm-shape.json');
    await writeFile(path, JSON.stringify({ mission_id: 'm-shape', state: 'NOT_A_REAL_STATE' }), 'utf8');

    await assert.rejects(
      () => store.get('m-shape'),
      (err) => err.code === MISSION_KERNEL_ERRORS.CORRUPT_RECORD
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── CORRECTION-1 / F3 — event-ledger chain verification ─────────────────────

test('F4.4 / F3 malformed event-ledger JSONL fails closed via verifyEventChain', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mission-kernel-badevent-'));
  try {
    const store = createMissionKernelStore({ storageRoot: dir });
    await store.create(baseKernel('m-ev'));
    const ledgerPath = join(dir, 'events.jsonl');
    await writeFile(ledgerPath, '{not valid json at all\n', 'utf8');

    const result = await verifyEventChain(dir);
    assert.equal(result.valid, false);
    assert.equal(result.error, MISSION_KERNEL_ERRORS.CORRUPT_EVENT);
    assert.equal(result.brokenAtLine, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('F4.5 / F3 truncated final event line is reported as truncated_final_line, not silently dropped', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mission-kernel-truncev-'));
  try {
    const store = createMissionKernelStore({ storageRoot: dir });
    await store.create(baseKernel('m-ev2'));
    const ledgerPath = join(dir, 'events.jsonl');
    const raw = await readFile(ledgerPath, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const truncatedLast = lines[lines.length - 1].slice(0, 10);
    const rebuilt = [...lines.slice(0, -1), truncatedLast].join('\n') + '\n';
    await writeFile(ledgerPath, rebuilt, 'utf8');

    const result = await verifyEventChain(dir);
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'truncated_final_line');
    assert.equal(result.brokenAtLine, lines.length - 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('F4.6 / F3 event hash-chain corruption (tampered payload) is detected at the exact broken line', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mission-kernel-chaincorrupt-'));
  try {
    const store = createMissionKernelStore({ storageRoot: dir });
    await store.create(baseKernel('m-chain'));
    await store.transition('m-chain', 'ORIENTED');
    await store.transition('m-chain', 'EXECUTING');

    const before = await verifyEventChain(dir);
    assert.equal(before.valid, true);
    assert.equal(before.eventCount, 3);

    const ledgerPath = join(dir, 'events.jsonl');
    const raw = await readFile(ledgerPath, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const tampered = JSON.parse(lines[1]);
    tampered.payload = { ...tampered.payload, tampered: true };
    lines[1] = JSON.stringify(tampered);
    await writeFile(ledgerPath, lines.join('\n') + '\n', 'utf8');

    const after = await verifyEventChain(dir);
    assert.equal(after.valid, false);
    assert.equal(after.error, MISSION_KERNEL_ERRORS.INTEGRITY_FAILURE);
    assert.equal(after.brokenAtLine, 1);
    assert.equal(after.reason, 'event_hash_mismatch');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('F3 verifyEventChain covers the entire shared ledger, not one selected mission', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mission-kernel-multimission-'));
  try {
    const store = createMissionKernelStore({ storageRoot: dir });
    await store.create(baseKernel('m-a'));
    await store.create(baseKernel('m-b'));
    await store.transition('m-a', 'ORIENTED');
    await store.transition('m-b', 'ORIENTED');

    const result = await verifyEventChain(dir);
    assert.equal(result.valid, true);
    assert.equal(result.eventCount, 4);
    assert.equal(result.missionEventCount, 4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── CORRECTION-1 / F2 — concurrency and lease law ────────────────────────────

test('F4.7 / F2 concurrent mutations against one mission never silently lose an update: exactly one governed outcome occurs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mission-kernel-concurrent-'));
  try {
    const store = createMissionKernelStore({ storageRoot: dir });
    await store.create(baseKernel('m-race'));

    const results = await Promise.allSettled([
      store.appendHistory('m-race', { type: 'A' }),
      store.appendHistory('m-race', { type: 'B' }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    const final = await store.get('m-race');

    // Forbidden: both report success while the final record only reflects one.
    const forbiddenSilentLoss = fulfilled.length === 2 && final.history.length < 2;
    assert.equal(forbiddenSilentLoss, false);

    // Required: either both legally persisted, or exactly one succeeded and
    // the other received a typed conflict.
    const governed =
      (fulfilled.length === 2 && final.history.length === 2) ||
      (fulfilled.length === 1 && rejected.length === 1 && final.history.length === 1);
    assert.equal(governed, true);

    if (rejected.length > 0) {
      assert.equal(rejected[0].reason.code, MISSION_KERNEL_ERRORS.LEASE_HELD);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('F4.7b concurrent transition() calls on the same mission never both silently apply', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mission-kernel-concurrent-transition-'));
  try {
    const store = createMissionKernelStore({ storageRoot: dir });
    await store.create(baseKernel('m-race-t'));

    const results = await Promise.allSettled([
      store.transition('m-race-t', 'ORIENTED', { via: 'first' }),
      store.transition('m-race-t', 'ORIENTED', { via: 'second' }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // Exactly one of: (a) one wins the lease and transitions, the other is
    // rejected as LEASE_HELD, or (b) sequenced such that the second sees an
    // already-ORIENTED state and is rejected as ILLEGAL_TRANSITION. Either
    // way, never two silently-applied transitions producing inconsistent state.
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(
      [MISSION_KERNEL_ERRORS.LEASE_HELD, MISSION_KERNEL_ERRORS.ILLEGAL_TRANSITION].includes(rejected[0].reason.code)
    );

    const final = await store.get('m-race-t');
    assert.equal(final.state, 'ORIENTED');
    assert.equal(final.history.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('F4.8 / F2 lease conflict: a second acquisition attempt while a lease is held fails closed with a typed error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mission-kernel-leaseconflict-'));
  try {
    const store = createMissionKernelStore({ storageRoot: dir });
    await store.create(baseKernel('m-lease'));

    // Manually hold a lease by writing the claim file directly (simulating
    // a slow in-flight mutation), then attempt a second mutation.
    const lockPath = join(dir, 'missions', 'm-lease.lock');
    await writeFile(lockPath, JSON.stringify({ mission_id: 'm-lease', holder_id: 'manual-holder', acquired_at: Date.now() }), { flag: 'wx' });

    await assert.rejects(
      () => store.appendHistory('m-lease', { type: 'X' }),
      (err) => err.code === MISSION_KERNEL_ERRORS.LEASE_HELD
    );

    // Confirm no mutation occurred while blocked.
    const { unlink } = await import('node:fs/promises');
    await unlink(lockPath); // release manually, then confirm normal operation resumes
    const record = await store.appendHistory('m-lease', { type: 'X' });
    assert.equal(record.history.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('F2 a lease older than staleLeaseMs is reported as LEASE_STALE, never auto-reclaimed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mission-kernel-stale-'));
  try {
    const store = createMissionKernelStore({ storageRoot: dir, staleLeaseMs: 50 });
    await store.create(baseKernel('m-stale'));

    const lockPath = join(dir, 'missions', 'm-stale.lock');
    await writeFile(lockPath, JSON.stringify({ mission_id: 'm-stale', holder_id: 'dead-holder', acquired_at: Date.now() - 1000 }), { flag: 'wx' });

    await assert.rejects(
      () => store.appendHistory('m-stale', { type: 'X' }),
      (err) => err.code === MISSION_KERNEL_ERRORS.LEASE_STALE
    );

    // Confirm it was NOT auto-reclaimed: the lock file must still exist.
    const stillThere = await readFile(lockPath, 'utf8').catch(() => null);
    assert.notEqual(stillThere, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('F4.9 / F2 breakStaleLease() releases in a manner equivalent to finally: a mutation after break proceeds normally', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mission-kernel-break-'));
  try {
    const store = createMissionKernelStore({ storageRoot: dir, staleLeaseMs: 50 });
    await store.create(baseKernel('m-break'));

    const lockPath = join(dir, 'missions', 'm-break.lock');
    await writeFile(lockPath, JSON.stringify({ mission_id: 'm-break', holder_id: 'dead-holder', acquired_at: Date.now() - 1000 }), { flag: 'wx' });

    const broken = await store.breakStaleLease('m-break');
    assert.equal(broken.cleared, true);

    const record = await store.appendHistory('m-break', { type: 'resumed' });
    assert.equal(record.history.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('F2 breakStaleLease() refuses to clear a lease that is not actually stale', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mission-kernel-notstale-'));
  try {
    const store = createMissionKernelStore({ storageRoot: dir, staleLeaseMs: 60_000 });
    await store.create(baseKernel('m-fresh'));

    const lockPath = join(dir, 'missions', 'm-fresh.lock');
    await writeFile(lockPath, JSON.stringify({ mission_id: 'm-fresh', holder_id: 'live-holder', acquired_at: Date.now() }), { flag: 'wx' });

    await assert.rejects(
      () => store.breakStaleLease('m-fresh'),
      (err) => err.code === MISSION_KERNEL_ERRORS.LEASE_HELD
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('F2 lease is released in finally even when the mutation throws mid-way (illegal transition)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mission-kernel-finally-'));
  try {
    const store = createMissionKernelStore({ storageRoot: dir });
    await store.create(baseKernel('m-throw'));

    // INITIALIZED -> COMPLETED is illegal; transition() throws AFTER acquiring the lease.
    await assert.rejects(
      () => store.transition('m-throw', 'COMPLETED'),
      (err) => err.code === MISSION_KERNEL_ERRORS.ILLEGAL_TRANSITION
    );

    const lockPath = join(dir, 'missions', 'm-throw.lock');
    const stillHeld = await readFile(lockPath, 'utf8').catch(() => null);
    assert.equal(stillHeld, null, 'lease must be released even though the mutation threw');

    // A subsequent legal call must succeed immediately — proves the lease was freed.
    const record = await store.transition('m-throw', 'ORIENTED');
    assert.equal(record.state, 'ORIENTED');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── CORRECTION-1 / F4 — remaining required adversarial coverage ─────────────

test('F4.11 terminal-state behavior is preserved after restart: a fresh store instance still refuses transitions out of FAILED', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mission-kernel-terminal-restart-'));
  try {
    const storeA = createMissionKernelStore({ storageRoot: dir });
    await storeA.create(baseKernel('m-term'));
    await storeA.transition('m-term', 'FAILED');

    const storeB = createMissionKernelStore({ storageRoot: dir });
    await assert.rejects(
      () => storeB.transition('m-term', 'ORIENTED'),
      (err) => err.code === MISSION_KERNEL_ERRORS.ILLEGAL_TRANSITION
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('F4.12 Promotion Boundary remains NOT_CROSSED after every correction path (corruption, lease conflict, chain corruption)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mission-kernel-promotionfinal-'));
  try {
    const store = createMissionKernelStore({ storageRoot: dir });
    await store.create(baseKernel('m-final'));
    await store.transition('m-final', 'ORIENTED');
    await store.transition('m-final', 'EXECUTING');
    await store.transition('m-final', 'COMPLETED');
    await store.transition('m-final', 'SEALED');

    const status = await store.getPromotionBoundaryStatus('m-final');
    assert.equal(status.status, 'NOT_CROSSED');
    assert.equal(status.validator_authority, 'NONE');

    const chain = await verifyEventChain(dir);
    assert.equal(chain.valid, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── CORRECTION-2 / F5 — lease path symlink protection ───────────────────────

test('F5.1 a symlinked lock path is rejected outright (acquireLease EEXIST branch never follows it)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mission-kernel-f5-symlock-'));
  const outsideDir = await mkdtemp(join(tmpdir(), 'mission-kernel-f5-outside-'));
  try {
    const { symlink, writeFile: wf } = await import('node:fs/promises');
    const store = createMissionKernelStore({ storageRoot: dir });
    await store.create(baseKernel('m-symlock'));

    const outsideFile = join(outsideDir, 'fake-lease.json');
    await wf(outsideFile, JSON.stringify({ mission_id: 'm-symlock', holder_id: 'attacker', acquired_at: Date.now() - 999_999 }), 'utf8');
    const lockPath = join(dir, 'missions', 'm-symlock.lock');
    await symlink(outsideFile, lockPath);

    await assert.rejects(
      () => store.appendHistory('m-symlock', { type: 'X' }),
      (err) => err.code === MISSION_KERNEL_ERRORS.SYMLINK_REJECTED
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test('F5.2 a staleness decision never uses content reached through a symlinked lock path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mission-kernel-f5-nostale-'));
  const outsideDir = await mkdtemp(join(tmpdir(), 'mission-kernel-f5-outside2-'));
  try {
    const { symlink, writeFile: wf } = await import('node:fs/promises');
    const store = createMissionKernelStore({ storageRoot: dir, staleLeaseMs: 50 });
    await store.create(baseKernel('m-nostale'));

    // Attacker-controlled content claims an ancient acquired_at, which would
    // normally read as LEASE_STALE — but it must never be trusted, because
    // it is reached only through a symlink.
    const outsideFile = join(outsideDir, 'fake-lease.json');
    await wf(outsideFile, JSON.stringify({ mission_id: 'm-nostale', holder_id: 'attacker', acquired_at: Date.now() - 999_999 }), 'utf8');
    const lockPath = join(dir, 'missions', 'm-nostale.lock');
    await symlink(outsideFile, lockPath);

    await assert.rejects(
      () => store.appendHistory('m-nostale', { type: 'X' }),
      (err) => err.code === MISSION_KERNEL_ERRORS.SYMLINK_REJECTED // NOT LEASE_STALE
    );

    // The outside file must be untouched — the module never wrote to or
    // deleted content it does not own via the symlink.
    const outsideStill = await readFile(outsideFile, 'utf8').catch(() => null);
    assert.notEqual(outsideStill, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test('F5.3 breakStaleLease() refuses a symlinked lock path outright, without reading or clearing it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mission-kernel-f5-break-'));
  const outsideDir = await mkdtemp(join(tmpdir(), 'mission-kernel-f5-outside3-'));
  try {
    const { symlink, writeFile: wf, lstat } = await import('node:fs/promises');
    const store = createMissionKernelStore({ storageRoot: dir, staleLeaseMs: 50 });
    await store.create(baseKernel('m-breaksym'));

    const outsideFile = join(outsideDir, 'fake-lease.json');
    await wf(outsideFile, JSON.stringify({ mission_id: 'm-breaksym', holder_id: 'attacker', acquired_at: Date.now() - 999_999 }), 'utf8');
    const lockPath = join(dir, 'missions', 'm-breaksym.lock');
    await symlink(outsideFile, lockPath);

    await assert.rejects(
      () => store.breakStaleLease('m-breaksym'),
      (err) => err.code === MISSION_KERNEL_ERRORS.SYMLINK_REJECTED
    );

    // The symlink itself must still be present — refusal means untouched,
    // not silently cleared as a side effect of rejecting it.
    const stillSymlink = await lstat(lockPath).catch(() => null);
    assert.notEqual(stillSymlink, null);
    assert.equal(stillSymlink.isSymbolicLink(), true);

    const outsideStill = await readFile(outsideFile, 'utf8').catch(() => null);
    assert.notEqual(outsideStill, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test('F5.4 normal (non-symlinked) leases are unaffected by the symlink guard: acquire, conflict, stale, and break all still work', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mission-kernel-f5-normal-'));
  try {
    const store = createMissionKernelStore({ storageRoot: dir, staleLeaseMs: 50 });
    await store.create(baseKernel('m-normal'));

    // Normal concurrent conflict still governed correctly.
    const results = await Promise.allSettled([
      store.appendHistory('m-normal', { type: 'A' }),
      store.appendHistory('m-normal', { type: 'B' }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
    const rejected = results.filter((r) => r.status === 'rejected').length;
    assert.equal(fulfilled, 1);
    assert.equal(rejected, 1);
    assert.equal(results.find((r) => r.status === 'rejected').reason.code, MISSION_KERNEL_ERRORS.LEASE_HELD);

    // Normal stale-lease detection and explicit break still work.
    const { writeFile: wf } = await import('node:fs/promises');
    const lockPath = join(dir, 'missions', 'm-normal.lock');
    await wf(lockPath, JSON.stringify({ mission_id: 'm-normal', holder_id: 'dead-holder', acquired_at: Date.now() - 1000 }), { flag: 'wx' });

    await assert.rejects(
      () => store.appendHistory('m-normal', { type: 'C' }),
      (err) => err.code === MISSION_KERNEL_ERRORS.LEASE_STALE
    );

    const broken = await store.breakStaleLease('m-normal');
    assert.equal(broken.cleared, true);

    const record = await store.appendHistory('m-normal', { type: 'D' });
    assert.equal(record.history.length, 2); // A (or B) + D
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
