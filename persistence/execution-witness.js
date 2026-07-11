// persistence/execution-witness.js
// ── T-033 (part 1): Execution Witness primitives for OURSELF Æ proposals ────
//
// PURPOSE
//   Provide the kernel-owned witness layer: a frozen witness-profile registry,
//   a read-only bounded observation runner, deterministic profile-specific
//   normalization, target fingerprinting, versioned witness-packet
//   construction/verification, and the pure deterministic reconciliation
//   computation consumed by persistence/semantic-reconciliation.js.
//
// FOUNDATIONAL DISTINCTIONS (enforced across this module)
//   EXECUTION_COMPLETED      ≠  OBSERVED EFFECT
//   PROCESS OUTPUT           ≠  INDEPENDENT WITNESS
//   WITNESS_CAPTURED         ≠  RECONCILED
//   RECONCILED               ≠  FREE-FORM HUMAN INTENT PROVEN
//   RECONCILIATION_DIVERGED  ≠  AUTOMATIC ROLLBACK AUTHORITY
//   RECONCILIATION_INDETERMINATE ≠ SUCCESS
//
//   The exact defensible claim: a T-033 reconciliation result proves only
//   whether a fresh, bounded, deterministic observation agrees with the
//   execution result and witness profile bound to the authorized execution
//   plan. It does not independently prove every human, institutional,
//   metaphysical, economic, or real-world consequence implied by the
//   original free-form intent.
//
// HARD INVARIANTS (this module NEVER)
//   • executes or re-executes a proposal;
//   • mutates the observed target;
//   • invokes an LLM or any model judgment (all comparison is exact,
//     versioned, deterministic normalization — no fuzzy similarity);
//   • accepts a caller-supplied profile, executable, argv, cwd, environment,
//     timeout, output limit, or normalization rule;
//   • uses a shell, stdin, network, or inherited environment;
//   • treats the T-032 execution result as its own witness.
//
// OBSERVATION RUNNER NOTE
//   T-032's internal bounded spawn (persistence/proposal-execution.js) is not
//   exported, and the T-033 gate authorizes sealed-module changes only for
//   existing READ or INTEGRITY helpers — so this module carries its own
//   read-only bounded observer under the same process law rather than
//   widening a sealed module's surface. The duplication is deliberate and
//   recorded in the gate report.

'use strict';

import { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { getPendingProposal } from './pending-proposals.js';
import { canonicalHash } from './canonical-json.js';
import { computeExecutionPlanHash, computeExecutionResultHash } from './proposal-execution.js';

export const WITNESS_VERSION = 'ourself.execution-witness.v1';
export const WITNESS_EVENT_VERSION = 'ourself.execution-witness-event.v1';
export const TARGET_FINGERPRINT_VERSION = 'ourself.target-fingerprint.v1';
export const COLLECTION_METHOD = 'kernel-bounded-readonly-spawn.v1';

export const EXECUTION_WITNESS_ERRORS = Object.freeze({
  INVALID_WITNESS_REQUEST: 'INVALID_WITNESS_REQUEST',
  WITNESS_EXECUTION_NOT_TERMINAL: 'WITNESS_EXECUTION_NOT_TERMINAL',
  UNSUPPORTED_WITNESS_PROFILE: 'UNSUPPORTED_WITNESS_PROFILE',
  WITNESS_OVERRIDE_FORBIDDEN: 'WITNESS_OVERRIDE_FORBIDDEN',
  WITNESS_CWD_BOUNDARY_VIOLATION: 'WITNESS_CWD_BOUNDARY_VIOLATION',
  WITNESS_CWD_SYMLINK_VIOLATION: 'WITNESS_CWD_SYMLINK_VIOLATION',
  WITNESS_TARGET_FINGERPRINT_MISMATCH: 'WITNESS_TARGET_FINGERPRINT_MISMATCH',
  WITNESS_COLLECTION_TIMEOUT: 'WITNESS_COLLECTION_TIMEOUT',
  WITNESS_SPAWN_FAILED: 'WITNESS_SPAWN_FAILED',
  WITNESS_OUTPUT_LIMIT_INDETERMINATE: 'WITNESS_OUTPUT_LIMIT_INDETERMINATE',
  WITNESS_ALREADY_CAPTURED: 'WITNESS_ALREADY_CAPTURED',
  WITNESS_INTEGRITY_FAILURE: 'WITNESS_INTEGRITY_FAILURE',
  CONCURRENT_WITNESS_CONFLICT: 'CONCURRENT_WITNESS_CONFLICT',
  WITNESS_WRITE_FAILED: 'WITNESS_WRITE_FAILED',
});

export const RECONCILIATION_STATUSES = Object.freeze({
  RECONCILED: 'RECONCILED',
  RECONCILIATION_DIVERGED: 'RECONCILIATION_DIVERGED',
  RECONCILIATION_INDETERMINATE: 'RECONCILIATION_INDETERMINATE',
});

export const OUTCOME_CLASSES = Object.freeze({
  SUCCESS_CONFIRMED: 'SUCCESS_CONFIRMED',
  FAILURE_CONFIRMED: 'FAILURE_CONFIRMED',
});

// Enumerated, bounded indeterminate reasons — never free prose from a model.
export const INDETERMINATE_REASONS = Object.freeze({
  RECORDED_OUTPUT_TRUNCATED: 'RECORDED_OUTPUT_TRUNCATED',
  WITNESS_OUTPUT_TRUNCATED: 'WITNESS_OUTPUT_TRUNCATED',
  OBSERVATION_TIMEOUT: 'OBSERVATION_TIMEOUT',
  OBSERVATION_SPAWN_FAILED: 'OBSERVATION_SPAWN_FAILED',
  RECORDED_FAILURE_CLASS_UNSUPPORTED: 'RECORDED_FAILURE_CLASS_UNSUPPORTED',
  OBSERVED_FAILURE_CLASS_UNSUPPORTED: 'OBSERVED_FAILURE_CLASS_UNSUPPORTED',
});

const MAX_EXCERPT_LENGTH = 200;
const MAX_SPAWN_ERROR_LENGTH = 500;

function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

// ── Normalization law (versioned, deterministic, profile-shared) ────────────
// v1 law: CRLF and CR are normalized to LF; trailing blank lines are removed
// (final-newline neutral); line ORDER IS SIGNIFICANT for both profiles (git
// status --short and ls both emit deterministically ordered output); no line
// is ever silently discarded; no timestamps or volatile values exist in either
// profile's output, so NO field is excluded (named exclusions: none).
export const NORMALIZATION_VERSION = 'ourself.witness-normalization.v1';

export function normalizeOutput(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

/**
 * Deterministic failure-class normalization for a nonzero git/ls result.
 * Returns a stable class token, or null when no deterministic class can be
 * established (e.g. the recorded failure was a timeout or spawn failure —
 * those carry no reproducible process semantics to confirm).
 */
export function normalizeFailureClass(profileId, { failure_code, exit_code, stderr }) {
  if (failure_code !== 'EXECUTION_NONZERO_EXIT') return null;
  const err = normalizeOutput(stderr ?? '').toLowerCase();
  if (profileId === 'git-status-short.witness.v1' && exit_code === 128 && err.includes('not a git repository')) {
    return 'NOT_A_GIT_REPOSITORY';
  }
  if (typeof exit_code === 'number') return `NONZERO_EXIT_${exit_code}`;
  return null;
}

/** Same classification applied to a fresh observation (no failure_code field). */
function classifyObservation(profileId, observation) {
  if (observation.exit_code === 0) return 'EXIT_ZERO';
  return normalizeFailureClass(profileId, {
    failure_code: 'EXECUTION_NONZERO_EXIT',
    exit_code: observation.exit_code,
    stderr: observation.stderr,
  });
}

// ── Frozen witness-profile registry ─────────────────────────────────────────
// Exactly the two T-032 frozen operations are witnessable. Selection is by
// the PERSISTED execution plan only; no caller input participates. Unknown
// operations fail closed as UNSUPPORTED_WITNESS_PROFILE.
export const WITNESS_PROFILES = Object.freeze({
  'git-status-short.witness.v1': Object.freeze({
    profile_id: 'git-status-short.witness.v1',
    normalization_version: NORMALIZATION_VERSION,
    applies: Object.freeze({ execution_class: 'git-read', executable: 'git', argv: Object.freeze(['status', '--short']) }),
    observation: Object.freeze({ executable: 'git', argv: Object.freeze(['status', '--short']) }),
  }),
  'directory-list.witness.v1': Object.freeze({
    profile_id: 'directory-list.witness.v1',
    normalization_version: NORMALIZATION_VERSION,
    applies: Object.freeze({ execution_class: 'inspect', executable: 'ls', argv: Object.freeze([]) }),
    observation: Object.freeze({ executable: 'ls', argv: Object.freeze([]) }),
  }),
});

/** Select the witness profile for a persisted execution plan. Fail closed. */
export function selectWitnessProfile(plan) {
  if (!plan || typeof plan !== 'object') {
    return { ok: false, error: EXECUTION_WITNESS_ERRORS.UNSUPPORTED_WITNESS_PROFILE, message: 'no execution plan' };
  }
  for (const profile of Object.values(WITNESS_PROFILES)) {
    const a = profile.applies;
    if (
      plan.execution_class === a.execution_class &&
      plan.executable === a.executable &&
      Array.isArray(plan.argv) &&
      plan.argv.length === a.argv.length &&
      plan.argv.every((v, i) => v === a.argv[i])
    ) {
      return { ok: true, profile };
    }
  }
  return {
    ok: false,
    error: EXECUTION_WITNESS_ERRORS.UNSUPPORTED_WITNESS_PROFILE,
    message: `no witness profile is registered for class "${plan.execution_class}" executable "${plan.executable}"`,
  };
}

// ── Target fingerprint ───────────────────────────────────────────────────────
/**
 * Capture a bounded fingerprint of the observation target WITHOUT mutating it.
 * Fails closed when the target is missing, is a symlink, or has been swapped
 * behind the persisted plan cwd (the plan stored the execution-time realpath).
 */
export async function captureTargetFingerprint({ planCwd, authorizedRoot }) {
  let st;
  try {
    st = await lstat(planCwd);
  } catch {
    return { ok: false, error: EXECUTION_WITNESS_ERRORS.WITNESS_TARGET_FINGERPRINT_MISMATCH, message: 'observation target no longer exists' };
  }
  if (st.isSymbolicLink()) {
    return { ok: false, error: EXECUTION_WITNESS_ERRORS.WITNESS_CWD_SYMLINK_VIOLATION, message: 'observation target is a symlink' };
  }
  if (!st.isDirectory()) {
    return { ok: false, error: EXECUTION_WITNESS_ERRORS.WITNESS_TARGET_FINGERPRINT_MISMATCH, message: 'observation target is not a directory' };
  }
  let realWd;
  let realRoot;
  try {
    realWd = await realpath(planCwd);
    realRoot = await realpath(authorizedRoot);
  } catch {
    return { ok: false, error: EXECUTION_WITNESS_ERRORS.WITNESS_TARGET_FINGERPRINT_MISMATCH, message: 'observation target cannot be resolved' };
  }
  if (realWd !== planCwd) {
    // The T-032 plan stored the execution-time realpath; a differing fresh
    // realpath means a symlink now sits somewhere in the path.
    return { ok: false, error: EXECUTION_WITNESS_ERRORS.WITNESS_CWD_SYMLINK_VIOLATION, message: 'observation target path no longer resolves to itself' };
  }
  if (!(realWd === realRoot || realWd.startsWith(realRoot + '/'))) {
    return { ok: false, error: EXECUTION_WITNESS_ERRORS.WITNESS_CWD_BOUNDARY_VIOLATION, message: 'observation target escapes the trusted observation root' };
  }
  let gitRootPresent = false;
  try {
    const g = await lstat(join(planCwd, '.git'));
    gitRootPresent = g.isDirectory() || g.isFile();
  } catch { /* absent */ }
  return {
    ok: true,
    fingerprint: {
      fingerprint_version: TARGET_FINGERPRINT_VERSION,
      realpath_hash: `sha256:${sha256Hex(realWd)}`,
      execution_root_hash: `sha256:${sha256Hex(realRoot)}`,
      device: st.dev ?? null,
      inode: st.ino ?? null,
      is_symlink: false,
      git_root_present: gitRootPresent,
    },
    stat: { dev: st.dev ?? null, ino: st.ino ?? null },
  };
}

// ── Read-only bounded observation runner (process law identical to T-032) ───
const MINIMAL_ENV = Object.freeze({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' });

function boundedUtf8(buffers, limitBytes) {
  const joined = Buffer.concat(buffers);
  if (joined.length <= limitBytes) return { text: joined.toString('utf8'), truncated: false };
  return { text: joined.subarray(0, limitBytes).toString('utf8'), truncated: true };
}

/**
 * Run one read-only bounded observation. Never a shell, never stdin, never
 * network, never target mutation (the profile registry contains only
 * read-only operations and nothing caller-supplied can reach this call).
 * Resolves with a classification — never throws for process-level failure.
 */
export function runBoundedObservation({ spawnImpl, executable, argv, cwd, timeoutMs, maxOutputBytes, now }) {
  const spawner = typeof spawnImpl === 'function' ? spawnImpl : nodeSpawn;
  return new Promise((resolvePromise) => {
    const startedAtIso = now();
    const startedAtMs = Date.now();
    let child;
    const finish = (partial) => resolvePromise({
      started_at: startedAtIso,
      completed_at: now(),
      duration_ms: Date.now() - startedAtMs,
      ...partial,
    });
    try {
      child = spawner(executable, [...argv], {
        cwd,
        env: { ...MINIMAL_ENV },
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      finish({ classification: 'spawn_failed', exit_code: null, signal: null, stdout: '', stderr: '', stdout_truncated: false, stderr_truncated: false, spawn_error: String(err && err.message || err).slice(0, MAX_SPAWN_ERROR_LENGTH) });
      return;
    }
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* gone */ }
    }, timeoutMs);
    if (child.stdout) child.stdout.on('data', (c) => { if (stdoutBytes < maxOutputBytes + 1) { stdoutChunks.push(c); stdoutBytes += c.length; } });
    if (child.stderr) child.stderr.on('data', (c) => { if (stderrBytes < maxOutputBytes + 1) { stderrChunks.push(c); stderrBytes += c.length; } });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish({ classification: 'spawn_failed', exit_code: null, signal: null, stdout: '', stderr: '', stdout_truncated: false, stderr_truncated: false, spawn_error: String(err && err.message || err).slice(0, MAX_SPAWN_ERROR_LENGTH) });
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = boundedUtf8(stdoutChunks, maxOutputBytes);
      const stderr = boundedUtf8(stderrChunks, maxOutputBytes);
      finish({
        classification: timedOut ? 'timeout' : 'completed',
        exit_code: code,
        signal: signal || null,
        stdout: stdout.text,
        stdout_truncated: stdout.truncated,
        stderr: stderr.text,
        stderr_truncated: stderr.truncated,
        spawn_error: null,
      });
    });
  });
}

// ── Witness packet ───────────────────────────────────────────────────────────
export function computeWitnessHash(packet) {
  const { witness_hash, ...rest } = packet;
  return canonicalHash(rest);
}

/**
 * Build the versioned witness packet binding the fresh observation to the
 * persisted execution. Contains no credentials, no environment dump, no
 * unrelated filesystem content, no caller commentary, no model conclusion.
 */
export function buildWitnessPacket({ proposalId, record, profile, observation, fingerprint }) {
  const plan = record.execution.plan;
  const terminalEvent = record.events[record.events.length - 1];
  const packet = {
    witness_version: WITNESS_VERSION,
    witness_id: `wit-${proposalId}`,
    proposal_id: proposalId,
    execution_id: record.execution.execution_id,
    execution_plan_hash: plan.plan_hash,
    execution_result_hash: record.execution.result_hash,
    terminal_execution_event_hash: terminalEvent.event_hash,
    semantic_checksum: record.semantic_checksum,
    execution_class: plan.execution_class,
    witness_profile_id: profile.profile_id,
    normalization_version: profile.normalization_version,
    target_fingerprint: fingerprint,
    observation_executable: profile.observation.executable,
    observation_argv: [...profile.observation.argv],
    observation_cwd_fingerprint: fingerprint.realpath_hash,
    observation_started_at: observation.started_at,
    observation_completed_at: observation.completed_at,
    observation_classification: observation.classification,
    exit_code: observation.exit_code,
    signal: observation.signal,
    stdout: observation.stdout,
    stderr: observation.stderr,
    stdout_truncated: observation.stdout_truncated,
    stderr_truncated: observation.stderr_truncated,
    spawn_error: observation.spawn_error ?? null,
    duration_ms: observation.duration_ms,
    collection_method: COLLECTION_METHOD,
    witness_hash: null,
  };
  packet.witness_hash = computeWitnessHash(packet);
  return packet;
}

/**
 * Verify a persisted witness packet's integrity and its binding to the
 * persisted execution. Read-only; never mutates regardless of outcome.
 */
export async function verifyExecutionWitness(storageRoot, proposalId) {
  const got = await getPendingProposal(storageRoot, proposalId);
  if (!got.ok) return got;
  const record = got.record;
  const witness = record.witness;
  if (!witness) return { ok: true, valid: true, witnessed: false };
  const details = [];
  if (witness.witness_version !== WITNESS_VERSION) details.push('invalid_witness_version');
  if (computeWitnessHash(witness) !== witness.witness_hash) details.push('witness_hash_mismatch');
  if (witness.proposal_id !== proposalId) details.push('witness_proposal_mismatch');
  const plan = record.execution?.plan;
  if (!plan) {
    details.push('witness_without_execution');
  } else {
    if (witness.execution_plan_hash !== plan.plan_hash || computeExecutionPlanHash(plan) !== plan.plan_hash) details.push('witness_plan_binding_mismatch');
    if (witness.execution_result_hash !== record.execution.result_hash) details.push('witness_result_binding_mismatch');
    if (record.execution.result && computeExecutionResultHash(record.execution.result) !== record.execution.result_hash) details.push('execution_result_hash_mismatch');
  }
  if (witness.semantic_checksum !== record.semantic_checksum) details.push('witness_semantic_checksum_mismatch');
  if (!record.events.some((e) => e.type === 'WITNESS_CAPTURED' && e.witness_hash === witness.witness_hash)) details.push('witness_event_missing_or_mismatched');
  if (details.length > 0) {
    return { ok: true, valid: false, error: EXECUTION_WITNESS_ERRORS.WITNESS_INTEGRITY_FAILURE, details };
  }
  return { ok: true, valid: true, witnessed: true };
}

// ── Deterministic reconciliation computation (pure; no I/O; no model) ───────
function boundedExcerpt(text) {
  return String(text ?? '').slice(0, MAX_EXCERPT_LENGTH);
}

function firstDivergentLine(a, b) {
  const la = a.split('\n');
  const lb = b.split('\n');
  const n = Math.max(la.length, lb.length);
  for (let i = 0; i < n; i++) {
    if (la[i] !== lb[i]) {
      return { line: i + 1, recorded_excerpt: boundedExcerpt(la[i] ?? ''), observed_excerpt: boundedExcerpt(lb[i] ?? '') };
    }
  }
  return null;
}

function diverged(field, recordedNorm, observedNorm, extra = {}) {
  return {
    status: RECONCILIATION_STATUSES.RECONCILIATION_DIVERGED,
    outcome_class: null,
    indeterminate_reason: null,
    divergence: {
      field,
      recorded_hash: `sha256:${sha256Hex(String(recordedNorm))}`,
      observed_hash: `sha256:${sha256Hex(String(observedNorm))}`,
      ...(typeof recordedNorm === 'string' && typeof observedNorm === 'string' ? firstDivergentLine(recordedNorm, observedNorm) ?? {} : {}),
      recorded_value_excerpt: boundedExcerpt(recordedNorm),
      observed_value_excerpt: boundedExcerpt(observedNorm),
      ...extra,
    },
  };
}

function indeterminate(reason) {
  return {
    status: RECONCILIATION_STATUSES.RECONCILIATION_INDETERMINATE,
    outcome_class: null,
    divergence: null,
    indeterminate_reason: reason,
  };
}

function reconciled(outcomeClass) {
  return {
    status: RECONCILIATION_STATUSES.RECONCILED,
    outcome_class: outcomeClass,
    divergence: null,
    indeterminate_reason: null,
  };
}

/**
 * Compute the reconciliation verdict from the PERSISTED execution result and
 * the PERSISTED witness packet, under the profile's versioned normalization.
 * Pure and deterministic: same inputs always yield the same verdict. Exact
 * comparison only — no fuzzy similarity, no model judgment, no discarded
 * lines, no excluded fields (v1 profiles carry no volatile values).
 */
export function computeProfileReconciliation({ profile, recordedResult, witnessPacket }) {
  const profileId = profile.profile_id;
  const recordedCompleted = recordedResult.failure_code === null || recordedResult.failure_code === undefined;

  // Observation-level indeterminacy applies to both branches.
  if (witnessPacket.observation_classification === 'timeout') {
    return { ...indeterminate(INDETERMINATE_REASONS.OBSERVATION_TIMEOUT), compared_fields: [] };
  }
  if (witnessPacket.observation_classification === 'spawn_failed') {
    return { ...indeterminate(INDETERMINATE_REASONS.OBSERVATION_SPAWN_FAILED), compared_fields: [] };
  }

  if (recordedCompleted) {
    const compared = ['exit_code', 'stdout', 'stderr'];
    if (recordedResult.stdout_truncated || recordedResult.stderr_truncated) {
      return { ...indeterminate(INDETERMINATE_REASONS.RECORDED_OUTPUT_TRUNCATED), compared_fields: compared };
    }
    if (witnessPacket.stdout_truncated || witnessPacket.stderr_truncated) {
      return { ...indeterminate(INDETERMINATE_REASONS.WITNESS_OUTPUT_TRUNCATED), compared_fields: compared };
    }
    if (witnessPacket.exit_code !== 0) {
      return { ...diverged('exit_code', recordedResult.exit_code, witnessPacket.exit_code), compared_fields: compared };
    }
    const recOut = normalizeOutput(recordedResult.stdout);
    const obsOut = normalizeOutput(witnessPacket.stdout);
    if (recOut !== obsOut) {
      return { ...diverged('stdout', recOut, obsOut), compared_fields: compared };
    }
    const recErr = normalizeOutput(recordedResult.stderr);
    const obsErr = normalizeOutput(witnessPacket.stderr);
    if (recErr !== obsErr) {
      return { ...diverged('stderr', recErr, obsErr), compared_fields: compared };
    }
    return { ...reconciled(OUTCOME_CLASSES.SUCCESS_CONFIRMED), compared_fields: compared };
  }

  // Recorded execution failed — confirm by normalized failure class, never by
  // byte-identical platform prose.
  const compared = ['failure_class'];
  const recordedClass = normalizeFailureClass(profileId, recordedResult);
  if (recordedClass === null) {
    return { ...indeterminate(INDETERMINATE_REASONS.RECORDED_FAILURE_CLASS_UNSUPPORTED), compared_fields: compared };
  }
  if (witnessPacket.exit_code === 0) {
    return { ...diverged('failure_class', recordedClass, 'EXIT_ZERO'), compared_fields: compared };
  }
  if (witnessPacket.stderr_truncated) {
    return { ...indeterminate(INDETERMINATE_REASONS.WITNESS_OUTPUT_TRUNCATED), compared_fields: compared };
  }
  const observedClass = classifyObservation(profileId, witnessPacket);
  if (observedClass === null) {
    return { ...indeterminate(INDETERMINATE_REASONS.OBSERVED_FAILURE_CLASS_UNSUPPORTED), compared_fields: compared };
  }
  if (recordedClass !== observedClass) {
    return { ...diverged('failure_class', recordedClass, observedClass), compared_fields: compared };
  }
  return { ...reconciled(OUTCOME_CLASSES.FAILURE_CONFIRMED), compared_fields: compared };
}
