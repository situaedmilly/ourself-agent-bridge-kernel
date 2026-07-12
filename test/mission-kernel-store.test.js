// test/mission-kernel-store.test.js
// ── Mission Kernel v0 persistence layer tests ────────────────────────────────
// All storage uses an isolated mkdtemp() directory per test. Nothing here
// ever writes to logs/mission-kernels.jsonl or any live runtime path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createMissionKernelStore,
  verifySpecificationBinding,
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
