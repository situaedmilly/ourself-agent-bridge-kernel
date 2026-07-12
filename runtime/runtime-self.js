// runtime/runtime-self.js
// ── T-034: RuntimeSELF — process lifecycle and exclusive instance ownership ─
//
// PURPOSE
//   Own runtime identity (ourself.runtime-instance.v1), the exclusive
//   per-storage-root runtime lock, lifecycle status records, heartbeats, and
//   durable lifecycle witnesses.
//
// FOUNDATIONAL LAW
//   RUNTIMESELF ≠ POLICY. PROCESS RUNNING ≠ INSTITUTION OPERATIONAL.
//   RESTARTED ≠ RECOVERED. RuntimeSELF never creates authority, never
//   reinterprets proposals, never bypasses queue states, never exposes a
//   network API, and never performs arbitrary execution. No kill operation
//   exists anywhere in this module.
//
// LOCK LAW
//   Only one active orchestrator may own a storage root. A second active
//   runtime refuses startup deterministically. A lock is never silently
//   deleted: lawful release ARCHIVES it (rename to a released- file);
//   takeover after proven death ARCHIVES it (rename to a superseded- file)
//   and appends a ledger event. Stale-lock recovery is not automatic — it
//   requires direct process-liveness AND heartbeat-staleness evidence from an
//   explicitly injected verifier; uncertain owner state returns
//   RUNTIME_LOCK_RECONCILIATION_REQUIRED.

'use strict';

import { writeFile, rename, readFile, mkdir, lstat } from 'node:fs/promises';
import { join, resolve, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWriteJson, appendGlobalEvent, assertNotSymlink } from '../persistence/pending-proposals.js';
import { canonicalHash } from '../persistence/canonical-json.js';

export const RUNTIME_INSTANCE_VERSION = 'ourself.runtime-instance.v1';
export const RUNTIME_EVENT_VERSION = 'ourself.runtime-event.v1';

export const RUNTIME_STATUSES = Object.freeze({
  STARTING: 'STARTING',
  RECOVERING: 'RECOVERING',
  READY: 'READY',
  DEGRADED: 'DEGRADED',
  DRAINING: 'DRAINING',
  STOPPING: 'STOPPING',
  STOPPED: 'STOPPED',
  FAILED: 'FAILED',
});

export const RUNTIME_SELF_ERRORS = Object.freeze({
  INVALID_RUNTIME_CONFIG: 'INVALID_RUNTIME_CONFIG',
  RUNTIME_LOCK_HELD: 'RUNTIME_LOCK_HELD',
  RUNTIME_LOCK_INVALID: 'RUNTIME_LOCK_INVALID',
  RUNTIME_LOCK_RECONCILIATION_REQUIRED: 'RUNTIME_LOCK_RECONCILIATION_REQUIRED',
  RUNTIME_LOCK_NOT_OWNED: 'RUNTIME_LOCK_NOT_OWNED',
  RUNTIME_WRITE_FAILED: 'RUNTIME_WRITE_FAILED',
  RUNTIME_BOUNDARY_VIOLATION: 'RUNTIME_BOUNDARY_VIOLATION',
});

const ERR = RUNTIME_SELF_ERRORS;
const HEARTBEAT_STALE_AFTER_MS = 90_000;

function fail(error, message) {
  return { ok: false, error, message: message || error };
}

function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function runtimeDir(storageRoot) {
  return join(storageRoot, 'runtime');
}

export function runtimeLockPath(storageRoot) {
  return join(runtimeDir(storageRoot), 'runtime.lock');
}

function instancePath(storageRoot, runtimeInstanceId) {
  return join(runtimeDir(storageRoot), 'instances', `${runtimeInstanceId}.json`);
}

export function computeInstanceHash(instance) {
  const { instance_hash, ...rest } = instance;
  return canonicalHash(rest);
}

export function computeLockHash(lock) {
  const { lock_hash, ...rest } = lock;
  return canonicalHash(rest);
}

/** Validate the storage-root boundary: absolute, existing, not a symlink. */
export async function validateStorageRootBoundary(storageRoot) {
  if (typeof storageRoot !== 'string' || storageRoot.length === 0 || !isAbsolute(storageRoot)) {
    return fail(ERR.RUNTIME_BOUNDARY_VIOLATION, 'storageRoot must be an absolute path');
  }
  let st;
  try {
    st = await lstat(storageRoot);
  } catch {
    return fail(ERR.RUNTIME_BOUNDARY_VIOLATION, 'storageRoot does not exist');
  }
  if (st.isSymbolicLink()) return fail(ERR.RUNTIME_BOUNDARY_VIOLATION, 'storageRoot is a symlink');
  if (!st.isDirectory()) return fail(ERR.RUNTIME_BOUNDARY_VIOLATION, 'storageRoot is not a directory');
  return { ok: true, storageRoot: resolve(storageRoot) };
}

/**
 * Build a runtime instance identity record (ourself.runtime-instance.v1).
 * All identity inputs are explicit; nothing is read from the environment here
 * except what trusted composition passes in.
 */
export function createRuntimeInstance({ timeself, storageRoot, kernelHead, bootId, processId, hostname, runtimeVersion = 'ourself.runtime.v1' }) {
  if (!timeself || typeof timeself.now !== 'function') throw new TypeError('createRuntimeInstance requires timeself');
  if (typeof storageRoot !== 'string' || storageRoot.length === 0) throw new TypeError('createRuntimeInstance requires storageRoot');
  const startedAt = timeself.now();
  const instance = {
    runtime_instance_version: RUNTIME_INSTANCE_VERSION,
    runtime_instance_id: `rt-${sha256Hex(`${storageRoot}|${bootId}|${processId}|${startedAt}`).slice(0, 24)}`,
    process_id: processId ?? null,
    boot_id: bootId ?? null,
    hostname_hash: hostname ? `sha256:${sha256Hex(hostname)}` : null,
    kernel_git_head: kernelHead ?? null,
    started_at: startedAt,
    last_heartbeat_at: startedAt,
    status: RUNTIME_STATUSES.STARTING,
    manifest_checksums: null, // unavailable until T-035
    storage_root_fingerprint: `sha256:${sha256Hex(resolve(storageRoot))}`,
    runtime_version: runtimeVersion,
    instance_hash: null,
  };
  instance.instance_hash = computeInstanceHash(instance);
  return instance;
}

async function appendRuntimeEvent(storageRoot, timeself, type, instance, extra = {}) {
  return appendGlobalEvent(storageRoot, {
    event_version: RUNTIME_EVENT_VERSION,
    type,
    runtime_instance_id: instance.runtime_instance_id,
    process_id: instance.process_id,
    boot_id: instance.boot_id,
    instance_hash: instance.instance_hash,
    at: timeself.now(),
    ...extra,
  });
}

/** Persist the durable instance record and append a lifecycle witness event. */
export async function writeRuntimeStatus(storageRoot, timeself, instance, status, extra = {}) {
  if (!Object.values(RUNTIME_STATUSES).includes(status)) {
    return fail(ERR.INVALID_RUNTIME_CONFIG, `unknown runtime status: ${status}`);
  }
  const updated = { ...instance, status, last_heartbeat_at: timeself.now(), instance_hash: null };
  updated.instance_hash = computeInstanceHash(updated);
  try {
    await appendRuntimeEvent(storageRoot, timeself, `RUNTIME_${status}`, updated, extra);
    await atomicWriteJson(instancePath(storageRoot, updated.runtime_instance_id), updated);
  } catch (err) {
    return fail(ERR.RUNTIME_WRITE_FAILED, String(err && err.message || err));
  }
  return { ok: true, instance: updated };
}

/**
 * Acquire the exclusive runtime lock (O_EXCL). On conflict:
 * - unreadable/invalid lock → RUNTIME_LOCK_INVALID (fail closed);
 * - live or uncertain owner → RUNTIME_LOCK_HELD / RECONCILIATION_REQUIRED;
 * - proven-dead owner (injected livenessVerifier: ownerDead === true AND the
 *   lock heartbeat is stale) → archive the old lock as superseded-*, append a
 *   ledger event, and acquire.
 */
export async function acquireRuntimeLock(storageRoot, timeself, instance, { livenessVerifier } = {}) {
  const lockPath = runtimeLockPath(storageRoot);
  if (!(await assertNotSymlink(lockPath))) {
    return fail(ERR.RUNTIME_LOCK_INVALID, 'runtime lock path is a symlink — refusing');
  }
  const lock = {
    runtime_instance_id: instance.runtime_instance_id,
    process_id: instance.process_id,
    boot_id: instance.boot_id,
    acquired_at: timeself.now(),
    heartbeat_at: timeself.now(),
    storage_root_fingerprint: instance.storage_root_fingerprint,
    lock_hash: null,
  };
  lock.lock_hash = computeLockHash(lock);

  async function writeLockExclusive() {
    await mkdir(runtimeDir(storageRoot), { recursive: true });
    await writeFile(lockPath, JSON.stringify(lock, null, 2) + '\n', { flag: 'wx' });
  }

  try {
    await writeLockExclusive();
  } catch (err) {
    if (!err || err.code !== 'EEXIST') {
      return fail(ERR.RUNTIME_WRITE_FAILED, String(err && err.message || err));
    }
    // Lock exists — reconcile, never silently delete.
    const raw = await readFile(lockPath, 'utf8').catch(() => null);
    if (raw === null) return fail(ERR.RUNTIME_LOCK_INVALID, 'existing lock unreadable');
    let existing;
    try {
      existing = JSON.parse(raw);
    } catch {
      return fail(ERR.RUNTIME_LOCK_INVALID, 'existing lock is malformed JSON — reconciliation required');
    }
    if (computeLockHash(existing) !== existing.lock_hash) {
      return fail(ERR.RUNTIME_LOCK_INVALID, 'existing lock fails integrity — reconciliation required');
    }
    if (existing.runtime_instance_id === instance.runtime_instance_id) {
      return { ok: true, lock: existing, alreadyOwned: true };
    }
    const heartbeatStale = timeself.isHeartbeatStale(existing.heartbeat_at, HEARTBEAT_STALE_AFTER_MS);
    if (typeof livenessVerifier !== 'function') {
      return fail(ERR.RUNTIME_LOCK_RECONCILIATION_REQUIRED, 'another runtime holds this storage root and no liveness verifier was supplied');
    }
    let verdict;
    try {
      verdict = await livenessVerifier({ lock: existing, heartbeatStale });
    } catch (err2) {
      return fail(ERR.RUNTIME_LOCK_RECONCILIATION_REQUIRED, `liveness verifier threw: ${String(err2 && err2.message || err2)}`);
    }
    if (!verdict || verdict.ownerDead !== true || typeof verdict.evidence !== 'string' || !heartbeatStale) {
      // Alive, or uncertain, or heartbeat still fresh — never take over.
      return verdict && verdict.ownerDead === false
        ? fail(ERR.RUNTIME_LOCK_HELD, 'another active runtime owns this storage root')
        : fail(ERR.RUNTIME_LOCK_RECONCILIATION_REQUIRED, 'owner liveness is uncertain or heartbeat is not stale — takeover forbidden');
    }
    // Proven dead + stale heartbeat: archive (never delete) and take over.
    const supersededPath = join(runtimeDir(storageRoot), `runtime.lock.superseded-${existing.runtime_instance_id}`);
    try {
      await rename(lockPath, supersededPath);
      await appendRuntimeEvent(storageRoot, timeself, 'RUNTIME_LOCK_SUPERSEDED', instance, {
        superseded_runtime_instance_id: existing.runtime_instance_id,
        liveness_evidence: verdict.evidence.slice(0, 300),
        superseded_lock_hash: existing.lock_hash,
      });
      await writeLockExclusive();
    } catch (err3) {
      return fail(ERR.RUNTIME_WRITE_FAILED, String(err3 && err3.message || err3));
    }
  }

  try {
    await appendRuntimeEvent(storageRoot, timeself, 'RUNTIME_LOCK_ACQUIRED', instance, { lock_hash: lock.lock_hash });
  } catch (err) {
    return fail(ERR.RUNTIME_WRITE_FAILED, String(err && err.message || err));
  }
  return { ok: true, lock, alreadyOwned: false };
}

/** Read and integrity-check the current lock. Read-only. */
export async function getRuntimeLock(storageRoot) {
  const lockPath = runtimeLockPath(storageRoot);
  if (!(await assertNotSymlink(lockPath))) {
    return { ok: true, locked: true, valid: false, lock: null };
  }
  const raw = await readFile(lockPath, 'utf8').catch(() => null);
  if (raw === null) return { ok: true, locked: false, valid: false, lock: null };
  try {
    const lock = JSON.parse(raw);
    return { ok: true, locked: true, valid: computeLockHash(lock) === lock.lock_hash, lock };
  } catch {
    return { ok: true, locked: true, valid: false, lock: null };
  }
}

/** Refresh the lock heartbeat — owner only. */
export async function heartbeatRuntimeLock(storageRoot, timeself, instance) {
  const current = await getRuntimeLock(storageRoot);
  if (!current.locked || !current.valid || current.lock.runtime_instance_id !== instance.runtime_instance_id) {
    return fail(ERR.RUNTIME_LOCK_NOT_OWNED, 'heartbeat requires ownership of a valid lock');
  }
  const updated = { ...current.lock, heartbeat_at: timeself.now(), lock_hash: null };
  updated.lock_hash = computeLockHash(updated);
  try {
    await atomicWriteJson(runtimeLockPath(storageRoot), updated);
  } catch (err) {
    return fail(ERR.RUNTIME_WRITE_FAILED, String(err && err.message || err));
  }
  return { ok: true, lock: updated };
}

/**
 * Release the runtime lock — owner only, lawful shutdown only. The lock file
 * is ARCHIVED (renamed released-*), never deleted, and the release is ledgered.
 */
export async function releaseRuntimeLock(storageRoot, timeself, instance, { shutdownLawful } = {}) {
  if (shutdownLawful !== true) {
    return fail(ERR.RUNTIME_LOCK_NOT_OWNED, 'release requires a lawfully completed shutdown');
  }
  const current = await getRuntimeLock(storageRoot);
  if (!current.locked || !current.valid || current.lock.runtime_instance_id !== instance.runtime_instance_id) {
    return fail(ERR.RUNTIME_LOCK_NOT_OWNED, 'only the owning runtime may release the lock');
  }
  const releasedPath = join(runtimeDir(storageRoot), `runtime.lock.released-${instance.runtime_instance_id}`);
  try {
    await rename(runtimeLockPath(storageRoot), releasedPath);
    await appendRuntimeEvent(storageRoot, timeself, 'RUNTIME_LOCK_RELEASED', instance, { lock_hash: current.lock.lock_hash });
  } catch (err) {
    return fail(ERR.RUNTIME_WRITE_FAILED, String(err && err.message || err));
  }
  return { ok: true, archived_at: releasedPath };
}
