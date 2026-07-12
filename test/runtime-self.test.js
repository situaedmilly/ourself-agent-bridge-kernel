// test/runtime-self.test.js
// ── T-034: RuntimeSELF — identity, exclusive lock, lifecycle witnesses ──────

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyEventLedger, eventsLedgerPath } from '../persistence/pending-proposals.js';
import { createFakeClock, createTimeself } from '../runtime/timeself.js';
import {
  createRuntimeInstance, acquireRuntimeLock, getRuntimeLock, heartbeatRuntimeLock,
  releaseRuntimeLock, writeRuntimeStatus, validateStorageRootBoundary,
  computeInstanceHash, computeLockHash, runtimeLockPath,
  RUNTIME_STATUSES, RUNTIME_INSTANCE_VERSION, RUNTIME_SELF_ERRORS as ERR,
} from '../runtime/runtime-self.js';

const KERNEL_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

async function withTempStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'ourself-runtime-self-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

function fakeTimeself() {
  const clock = createFakeClock({ startIso: '2026-07-11T00:00:00.000Z' });
  return { clock, timeself: createTimeself(clock) };
}

function instanceFor(dir, timeself, n = 1) {
  return createRuntimeInstance({
    timeself, storageRoot: dir, kernelHead: 'b4cca0fd989ade16a07a5aa16c80acee508fb59e',
    bootId: `boot-${n}`, processId: 1000 + n, hostname: 'test-node',
  });
}

test('identity: the runtime instance contract is complete and self-hashed', async () => {
  await withTempStore(async (dir) => {
    const { timeself } = fakeTimeself();
    const instance = instanceFor(dir, timeself);
    assert.equal(instance.runtime_instance_version, RUNTIME_INSTANCE_VERSION);
    assert.match(instance.runtime_instance_id, /^rt-[0-9a-f]{24}$/);
    assert.equal(instance.status, RUNTIME_STATUSES.STARTING);
    assert.equal(instance.manifest_checksums, null, 'manifest checksums unavailable until T-035');
    assert.match(instance.hostname_hash, /^sha256:[0-9a-f]{64}$/);
    assert.match(instance.storage_root_fingerprint, /^sha256:[0-9a-f]{64}$/);
    assert.equal(computeInstanceHash(instance), instance.instance_hash);
  });
});

test('58. the first runtime acquires the lock and the acquisition is ledgered', async () => {
  await withTempStore(async (dir) => {
    const { timeself } = fakeTimeself();
    const instance = instanceFor(dir, timeself);
    const res = await acquireRuntimeLock(dir, timeself, instance);
    assert.equal(res.ok, true, res.message);
    assert.equal(res.alreadyOwned, false);
    assert.equal(computeLockHash(res.lock), res.lock.lock_hash);
    const events = (await readFile(eventsLedgerPath(dir), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(events[events.length - 1].type, 'RUNTIME_LOCK_ACQUIRED');
    assert.equal((await verifyEventLedger(dir)).valid, true);
  });
});

test('59+61. a second runtime refuses the same storage root; uncertainty demands reconciliation', async () => {
  await withTempStore(async (dir) => {
    const { timeself } = fakeTimeself();
    const first = instanceFor(dir, timeself, 1);
    await acquireRuntimeLock(dir, timeself, first);
    const second = instanceFor(dir, timeself, 2);
    // No verifier: reconciliation required.
    const noVerifier = await acquireRuntimeLock(dir, timeself, second);
    assert.equal(noVerifier.ok, false);
    assert.equal(noVerifier.error, ERR.RUNTIME_LOCK_RECONCILIATION_REQUIRED);
    // Verifier says alive: deterministic refusal.
    const alive = await acquireRuntimeLock(dir, timeself, second, { livenessVerifier: () => ({ ownerDead: false }) });
    assert.equal(alive.ok, false);
    assert.equal(alive.error, ERR.RUNTIME_LOCK_HELD);
    // Verifier uncertain: reconciliation required.
    const uncertain = await acquireRuntimeLock(dir, timeself, second, { livenessVerifier: () => ({ ownerDead: null }) });
    assert.equal(uncertain.error, ERR.RUNTIME_LOCK_RECONCILIATION_REQUIRED);
  });
});

test('60. an invalid (tampered or malformed) lock fails closed', async () => {
  await withTempStore(async (dir) => {
    const { timeself } = fakeTimeself();
    await mkdir(join(dir, 'runtime'), { recursive: true });
    await writeFile(runtimeLockPath(dir), 'not-json');
    const malformed = await acquireRuntimeLock(dir, timeself, instanceFor(dir, timeself));
    assert.equal(malformed.ok, false);
    assert.equal(malformed.error, ERR.RUNTIME_LOCK_INVALID);
    const forged = { runtime_instance_id: 'rt-forged', process_id: 1, boot_id: 'b', acquired_at: 'x', heartbeat_at: 'x', storage_root_fingerprint: 'sha256:0', lock_hash: 'wrong' };
    await writeFile(runtimeLockPath(dir), JSON.stringify(forged));
    const tampered = await acquireRuntimeLock(dir, timeself, instanceFor(dir, timeself));
    assert.equal(tampered.error, ERR.RUNTIME_LOCK_INVALID);
  });
});

test('62. a proven-dead owner with a stale heartbeat can be superseded — lock archived, never deleted', async () => {
  await withTempStore(async (dir) => {
    const { clock, timeself } = fakeTimeself();
    const dead = instanceFor(dir, timeself, 1);
    await acquireRuntimeLock(dir, timeself, dead);
    const successor = instanceFor(dir, timeself, 2);
    // Heartbeat still fresh: even a dead verdict cannot take over.
    const tooFresh = await acquireRuntimeLock(dir, timeself, successor, { livenessVerifier: () => ({ ownerDead: true, evidence: 'pid absent' }) });
    assert.equal(tooFresh.ok, false);
    clock.advance(10 * 60_000); // heartbeat now stale
    const takeover = await acquireRuntimeLock(dir, timeself, successor, { livenessVerifier: () => ({ ownerDead: true, evidence: 'pid absent, boot id rotated' }) });
    assert.equal(takeover.ok, true, takeover.message);
    // Old lock archived as superseded, and the takeover is ledgered.
    const archived = JSON.parse(await readFile(join(dir, 'runtime', `runtime.lock.superseded-${dead.runtime_instance_id}`), 'utf8'));
    assert.equal(archived.runtime_instance_id, dead.runtime_instance_id);
    const events = (await readFile(eventsLedgerPath(dir), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(events.some((e) => e.type === 'RUNTIME_LOCK_SUPERSEDED' && e.superseded_runtime_instance_id === dead.runtime_instance_id));
  });
});

test('63. no kill operation exists in any T-034 runtime module', () => {
  for (const f of ['runtime/timeself.js', 'runtime/bridge-self.js', 'runtime/runtime-self.js', 'runtime/recovery.js', 'runtime/health.js', 'runtime/orchestrator.js', 'persistence/queue-store.js']) {
    const src = readFileSync(join(KERNEL_ROOT, f), 'utf8');
    assert.equal(/process\.kill|child\.kill|\.kill\(/.test(src), false, `${f} must contain no kill operation`);
  }
});

test('64-66. release requires ownership; unexpected shutdown leaves the lock; graceful release archives it', async () => {
  await withTempStore(async (dir) => {
    const { timeself } = fakeTimeself();
    const owner = instanceFor(dir, timeself, 1);
    await acquireRuntimeLock(dir, timeself, owner);
    const stranger = instanceFor(dir, timeself, 2);
    const strangerRelease = await releaseRuntimeLock(dir, timeself, stranger, { shutdownLawful: true });
    assert.equal(strangerRelease.ok, false);
    assert.equal(strangerRelease.error, ERR.RUNTIME_LOCK_NOT_OWNED);
    const unlawful = await releaseRuntimeLock(dir, timeself, owner, { shutdownLawful: false });
    assert.equal(unlawful.ok, false, 'release requires a lawfully completed shutdown');
    // 65: unexpected termination = simply no release call — the lock persists.
    const still = await getRuntimeLock(dir);
    assert.equal(still.locked, true);
    assert.equal(still.valid, true);
    // 66: graceful release archives the lock and ledgers it.
    const released = await releaseRuntimeLock(dir, timeself, owner, { shutdownLawful: true });
    assert.equal(released.ok, true, released.message);
    assert.equal((await getRuntimeLock(dir)).locked, false);
    const archived = await readFile(join(dir, 'runtime', `runtime.lock.released-${owner.runtime_instance_id}`), 'utf8');
    assert.ok(archived.includes(owner.runtime_instance_id), 'released lock archived, not deleted');
  });
});

test('heartbeat: owner refreshes; non-owner is refused; lifecycle statuses persist with witnesses', async () => {
  await withTempStore(async (dir) => {
    const { clock, timeself } = fakeTimeself();
    let owner = instanceFor(dir, timeself, 1);
    await acquireRuntimeLock(dir, timeself, owner);
    clock.advance(15_000);
    const beat = await heartbeatRuntimeLock(dir, timeself, owner);
    assert.equal(beat.ok, true);
    assert.equal(beat.lock.heartbeat_at, '2026-07-11T00:00:15.000Z');
    const stranger = instanceFor(dir, timeself, 2);
    assert.equal((await heartbeatRuntimeLock(dir, timeself, stranger)).ok, false);
    // Lifecycle statuses write durable records + ledger witnesses.
    for (const status of [RUNTIME_STATUSES.RECOVERING, RUNTIME_STATUSES.READY, RUNTIME_STATUSES.DRAINING, RUNTIME_STATUSES.STOPPING, RUNTIME_STATUSES.STOPPED]) {
      const res = await writeRuntimeStatus(dir, timeself, owner, status);
      assert.equal(res.ok, true, res.message);
      owner = res.instance;
    }
    const persisted = JSON.parse(await readFile(join(dir, 'runtime', 'instances', `${owner.runtime_instance_id}.json`), 'utf8'));
    assert.equal(persisted.status, RUNTIME_STATUSES.STOPPED);
    assert.equal(computeInstanceHash(persisted), persisted.instance_hash);
    const events = (await readFile(eventsLedgerPath(dir), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const lifecycle = events.filter((e) => e.type.startsWith('RUNTIME_')).map((e) => e.type);
    assert.deepEqual(lifecycle, ['RUNTIME_LOCK_ACQUIRED', 'RUNTIME_RECOVERING', 'RUNTIME_READY', 'RUNTIME_DRAINING', 'RUNTIME_STOPPING', 'RUNTIME_STOPPED']);
    assert.equal((await verifyEventLedger(dir)).valid, true);
  });
});

test('boundary: the storage root must be an absolute, existing, non-symlink directory', async () => {
  await withTempStore(async (dir) => {
    assert.equal((await validateStorageRootBoundary(dir)).ok, true);
    assert.equal((await validateStorageRootBoundary('relative/path')).ok, false);
    assert.equal((await validateStorageRootBoundary(join(dir, 'missing'))).ok, false);
  });
});
