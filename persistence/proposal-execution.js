// persistence/proposal-execution.js
// ── T-032: Bounded Imported Proposal Execution for OURSELF Æ Proposals ──────
//
// PURPOSE
//   Convert a durable AUTHORIZED_PENDING_EXECUTION proposal (T-031) into
//   exactly one bounded, firewall-revalidated process invocation, recording
//   the lifecycle in the SAME per-proposal record and store-wide hash-chained
//   events.jsonl ledger that T-030/T-031 own — WITHOUT creating authority,
//   accepting credentials, retrying consequential work, or reconciling.
//
// FOUNDATIONAL EXECUTION LAW (enforced by this module)
//   AUTHORIZED             ≠  SAFE WITHOUT REVALIDATION
//   EXECUTION CLASS        ≠  ARBITRARY TERMINAL AUTHORITY
//   EXECUTION_STARTED      ≠  EXECUTION_COMPLETED
//   EXIT CODE ZERO         ≠  SEMANTIC INTENT PROVEN
//   EXECUTION_COMPLETED    ≠  RECONCILED (T-033 remains required)
//
// TRUST BOUNDARY (mirrors the T-031 verifier pattern)
//   All execution-shaping configuration — the authorized execution root, the
//   working directory, timeout, output limits, the clock, and the spawn
//   implementation — is captured at TRUSTED CONSTRUCTION time by
//   createBoundedProposalExecutor. The untrusted per-call request carries
//   ONLY { storageRoot, proposalId }; any command-, path-, environment-,
//   class-, credential- or plan-shaped field on the request is rejected
//   outright (EXECUTION_OVERRIDE_FORBIDDEN) and is never read for any other
//   purpose. No caller input can replace or influence the authorized plan.
//
// PLAN DERIVATION LAW
//   The immutable execution plan is derived DETERMINISTICALLY from persisted
//   authorized state through a frozen (route, execution_class) → operation
//   registry. Free-form semantic intent is never model-reinterpreted and
//   arbitrary caller command text is never accepted. The derived operation is
//   then re-validated through the sealed kernel law it did not write:
//   evaluateApproval (live re-classification), enforceClassPolicy (per-class
//   shape policy), and inspectCommand (generic firewall) — all fail closed.
//
// PROCESS LAW
//   shell: false — explicit executable + frozen argv, no shell interpolation,
//   no stdin, bounded cwd, bounded timeout (SIGKILL), minimal fixed
//   environment, bounded stdout/stderr with truncation flags, deterministic
//   spawn-failure handling. tools/terminal.js (Pass-20 shell-string exec) is
//   deliberately NOT used: it violates this law and belongs to the legacy
//   /approve lane. Only the pure firewall functions are reused.
//
// ONE-SHOT LAW
//   At most one process invocation per proposal, ever — enforced by a
//   proposal-scoped exclusive lock file (O_EXCL) inside the bounded storage
//   root plus durable EXECUTION_STARTED-before-spawn ordering. Completed or
//   failed repeats return the recorded terminal result without rerunning.
//   There is NO automatic retry and NO automatic stale-lock deletion —
//   recovering an interrupted execution requires a separate explicit
//   recovery law (out of T-032 scope).
//
// HARD INVARIANTS (this module NEVER)
//   • authorizes, rejects, or re-decides a proposal;
//   • accepts a HUMAN-TURN credential in any field;
//   • mutates the packet, route plan, requested execution, or authority block;
//   • executes a proposal twice;
//   • retries a failed execution;
//   • creates a reconciliation or witness claim (T-033);
//   • adds an HTTP route or touches server.js;
//   • deletes or repairs a lock, record, or ledger line.

'use strict';

import { spawn as nodeSpawn } from 'node:child_process';
import { writeFile, mkdir, lstat, realpath, readFile } from 'node:fs/promises';
import { join, resolve, sep, isAbsolute } from 'node:path';
import {
  getPendingProposal,
  verifyPendingProposal,
  verifyEventLedger,
  resolveProposalPath,
  assertNotSymlink,
  atomicWriteJson,
  appendGlobalEvent,
  computeRecordHash,
} from './pending-proposals.js';
import { canonicalHash } from './canonical-json.js';
import { EXECUTION_CLASSES } from '../tools/execution-classes.js';
import { evaluateApproval } from '../tools/execution-classes.js';
import { inspectCommand, enforceClassPolicy } from '../tools/command-firewall.js';

export const EXECUTION_PLAN_VERSION = 'ourself.execution-plan.v1';
export const EXECUTION_EVENT_VERSION = 'ourself.proposal-execution-event.v1';

export const PROPOSAL_EXECUTION_ERRORS = Object.freeze({
  PROPOSAL_NOT_FOUND: 'PROPOSAL_NOT_FOUND',
  PROPOSAL_NOT_AUTHORIZED: 'PROPOSAL_NOT_AUTHORIZED',
  PROPOSAL_REJECTED: 'PROPOSAL_REJECTED',
  PROPOSAL_INTEGRITY_FAILURE: 'PROPOSAL_INTEGRITY_FAILURE',
  EVENT_LEDGER_INTEGRITY_FAILURE: 'EVENT_LEDGER_INTEGRITY_FAILURE',
  DECISION_INTEGRITY_FAILURE: 'DECISION_INTEGRITY_FAILURE',
  SEMANTIC_CHECKSUM_MISMATCH: 'SEMANTIC_CHECKSUM_MISMATCH',
  AUTHORIZATION_EVENT_MISMATCH: 'AUTHORIZATION_EVENT_MISMATCH',
  UNKNOWN_EXECUTION_CLASS: 'UNKNOWN_EXECUTION_CLASS',
  EXECUTION_CLASS_MISMATCH: 'EXECUTION_CLASS_MISMATCH',
  INVALID_EXECUTION_PLAN: 'INVALID_EXECUTION_PLAN',
  FIREWALL_DENIED: 'FIREWALL_DENIED',
  CWD_BOUNDARY_VIOLATION: 'CWD_BOUNDARY_VIOLATION',
  CWD_SYMLINK_VIOLATION: 'CWD_SYMLINK_VIOLATION',
  EXECUTION_ALREADY_STARTED: 'EXECUTION_ALREADY_STARTED',
  EXECUTION_ALREADY_COMPLETED: 'EXECUTION_ALREADY_COMPLETED',
  CONCURRENT_EXECUTION_CONFLICT: 'CONCURRENT_EXECUTION_CONFLICT',
  EXECUTION_TIMEOUT: 'EXECUTION_TIMEOUT',
  EXECUTION_SPAWN_FAILED: 'EXECUTION_SPAWN_FAILED',
  EXECUTION_NONZERO_EXIT: 'EXECUTION_NONZERO_EXIT',
  EXECUTION_START_WRITE_FAILED: 'EXECUTION_START_WRITE_FAILED',
  EXECUTION_RESULT_WRITE_FAILED: 'EXECUTION_RESULT_WRITE_FAILED',
  EXECUTION_OVERRIDE_FORBIDDEN: 'EXECUTION_OVERRIDE_FORBIDDEN',
  INVALID_EXECUTION_REQUEST: 'INVALID_EXECUTION_REQUEST',
});

const ERR = PROPOSAL_EXECUTION_ERRORS;

// Deterministic (route :: execution_class) → bounded operation registry.
// This is the ONLY source of executables and argv in T-032. It is frozen at
// module scope; neither trusted construction nor any call can extend it.
// Semantic intent text plays no role in derivation — two proposals with
// different intents but the same route/class produce the identical operation.
const OPERATION_REGISTRY = Object.freeze({
  'git-read::git-read': Object.freeze({
    executable: 'git',
    argv: Object.freeze(['status', '--short']),
    display: 'git status --short',
  }),
  'inspect::inspect': Object.freeze({
    executable: 'ls',
    argv: Object.freeze([]),
    display: 'ls',
  }),
});

// Fixed minimal environment — never inherited from the calling process.
const MINIMAL_ENV = Object.freeze({
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  LC_ALL: 'C',
});

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES_CAP = 256 * 1024;
const MAX_SPAWN_ERROR_LENGTH = 500;

// Any of these on the UNTRUSTED per-call request is an attempted override of
// the authorized plan (or a smuggled credential) and fails the whole call.
// None is ever read for any purpose other than this rejection.
const FORBIDDEN_REQUEST_FIELDS = Object.freeze([
  'command', 'action', 'argv', 'args', 'executable', 'operation', 'plan',
  'cwd', 'workingDir', 'working_directory', 'env', 'environment',
  'timeout', 'timeoutMs', 'timeout_ms', 'maxOutputBytes', 'shell',
  'execution_class', 'executionClass', 'spawn', 'spawnImpl',
  'token', 'presentedToken', 'authorization_token', 'expectedToken',
  'expected_authorization_token', 'expected_token',
]);

function fail(error, message) {
  return { ok: false, error, message: message || error };
}

function executionsDir(storageRoot) {
  return join(storageRoot, 'executions');
}

function executionLockPath(storageRoot, proposalId) {
  return join(executionsDir(storageRoot), `${proposalId}.lock`);
}

function planWithoutHash(plan) {
  const { plan_hash, ...rest } = plan;
  return rest;
}

/** Recompute an execution plan's hash exactly as it was created. */
export function computeExecutionPlanHash(plan) {
  return canonicalHash(planWithoutHash(plan));
}

/** Recompute an execution result's hash exactly as it was recorded. */
export function computeExecutionResultHash(result) {
  return canonicalHash(result);
}

function boundedUtf8(buffers, limitBytes) {
  const joined = Buffer.concat(buffers);
  if (joined.length <= limitBytes) {
    return { text: joined.toString('utf8'), truncated: false };
  }
  return { text: joined.subarray(0, limitBytes).toString('utf8'), truncated: true };
}

/**
 * Run one bounded process under the PROCESS LAW. Never a shell. Never stdin.
 * Resolves with a classification — it never throws for process-level failure.
 */
function runBoundedProcess({ spawnImpl, plan, now }) {
  return new Promise((resolvePromise) => {
    const startedAtMs = Date.now();
    let child;
    const finish = (partial) => resolvePromise({ started_at: now(), duration_ms: Date.now() - startedAtMs, ...partial });
    try {
      child = spawnImpl(plan.executable, [...plan.argv], {
        cwd: plan.cwd,
        env: { ...plan.environment },
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      finish({ classification: 'spawn_failed', spawn_error: String(err && err.message || err).slice(0, MAX_SPAWN_ERROR_LENGTH) });
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
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, plan.timeout_ms);

    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        if (stdoutBytes < plan.stdout_limit_bytes + 1) { stdoutChunks.push(chunk); stdoutBytes += chunk.length; }
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        if (stderrBytes < plan.stderr_limit_bytes + 1) { stderrChunks.push(chunk); stderrBytes += chunk.length; }
      });
    }

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish({ classification: 'spawn_failed', spawn_error: String(err && err.message || err).slice(0, MAX_SPAWN_ERROR_LENGTH) });
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = boundedUtf8(stdoutChunks, plan.stdout_limit_bytes);
      const stderr = boundedUtf8(stderrChunks, plan.stderr_limit_bytes);
      let classification = 'completed';
      if (timedOut) classification = 'timeout';
      else if (code !== 0) classification = 'nonzero_exit';
      finish({
        classification,
        exit_code: code,
        signal: signal || null,
        stdout: stdout.text,
        stdout_truncated: stdout.truncated,
        stderr: stderr.text,
        stderr_truncated: stderr.truncated,
      });
    });
  });
}

/**
 * Construct the T-032 bounded executor. ALL execution-shaping configuration
 * enters here, through trusted composition code (or an isolated test) —
 * never through the per-call request.
 *
 * @param {object} config
 * @param {string} config.authorizedExecutionRoot - absolute directory that bounds cwd.
 * @param {string} [config.workingDirectory] - cwd for the plan; defaults to the root;
 *   must resolve inside the root and must not escape it through symlinks.
 * @param {number} [config.timeoutMs] - bounded; clamped to [1, MAX_TIMEOUT_MS].
 * @param {number} [config.maxOutputBytes] - per stream; clamped to MAX_OUTPUT_BYTES_CAP.
 * @param {function(): string} [config.now] - injectable ISO-timestamp clock.
 * @param {function} [config.spawnImpl] - injectable spawn (tests only); defaults to node:child_process.spawn.
 * @returns {{ executeAuthorizedProposal: function }}
 */
export function createBoundedProposalExecutor(config) {
  const cfg = config || {};
  if (typeof cfg.authorizedExecutionRoot !== 'string' || cfg.authorizedExecutionRoot.length === 0 || !isAbsolute(cfg.authorizedExecutionRoot)) {
    throw new TypeError('createBoundedProposalExecutor requires an absolute authorizedExecutionRoot');
  }
  const authorizedRoot = resolve(cfg.authorizedExecutionRoot);
  const workingDirectory = resolve(typeof cfg.workingDirectory === 'string' && cfg.workingDirectory.length > 0 ? cfg.workingDirectory : authorizedRoot);
  const timeoutMs = Math.min(Math.max(Number.isInteger(cfg.timeoutMs) ? cfg.timeoutMs : DEFAULT_TIMEOUT_MS, 1), MAX_TIMEOUT_MS);
  const maxOutputBytes = Math.min(Math.max(Number.isInteger(cfg.maxOutputBytes) ? cfg.maxOutputBytes : DEFAULT_MAX_OUTPUT_BYTES, 1), MAX_OUTPUT_BYTES_CAP);
  const now = typeof cfg.now === 'function' ? cfg.now : () => new Date().toISOString();
  const spawnImpl = typeof cfg.spawnImpl === 'function' ? cfg.spawnImpl : nodeSpawn;

  async function validateCwdBoundary() {
    if (!(workingDirectory === authorizedRoot || workingDirectory.startsWith(authorizedRoot + sep))) {
      return fail(ERR.CWD_BOUNDARY_VIOLATION, 'working directory resolves outside the authorized execution root');
    }
    let st;
    try {
      st = await lstat(workingDirectory);
    } catch {
      return fail(ERR.CWD_BOUNDARY_VIOLATION, 'working directory does not exist');
    }
    if (st.isSymbolicLink()) {
      return fail(ERR.CWD_SYMLINK_VIOLATION, 'working directory is itself a symlink');
    }
    if (!st.isDirectory()) {
      return fail(ERR.CWD_BOUNDARY_VIOLATION, 'working directory is not a directory');
    }
    let realWd;
    let realRoot;
    try {
      realWd = await realpath(workingDirectory);
      realRoot = await realpath(authorizedRoot);
    } catch {
      return fail(ERR.CWD_BOUNDARY_VIOLATION, 'working directory or root cannot be resolved');
    }
    if (!(realWd === realRoot || realWd.startsWith(realRoot + sep))) {
      return fail(ERR.CWD_SYMLINK_VIOLATION, 'working directory escapes the authorized root through a symlink');
    }
    return { ok: true, cwd: realWd };
  }

  /**
   * Execute an AUTHORIZED_PENDING_EXECUTION proposal exactly once.
   * @param {object} request - UNTRUSTED. Only { storageRoot, proposalId } are read.
   * @returns {Promise<object>}
   */
  async function executeAuthorizedProposal(request) {
    if (!request || typeof request !== 'object') {
      return fail(ERR.INVALID_EXECUTION_REQUEST, 'request must be an object');
    }
    for (const field of FORBIDDEN_REQUEST_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(request, field)) {
        return fail(ERR.EXECUTION_OVERRIDE_FORBIDDEN, `request may not carry "${field}" — the plan derives only from persisted authorized state and trusted construction`);
      }
    }
    const { storageRoot, proposalId } = request;
    if (typeof storageRoot !== 'string' || storageRoot.length === 0 || typeof proposalId !== 'string' || proposalId.length === 0) {
      return fail(ERR.INVALID_EXECUTION_REQUEST, 'storageRoot and proposalId are required');
    }

    // ── Pre-execution revalidation (fail closed, in order) ──────────────────
    const got = await getPendingProposal(storageRoot, proposalId);
    if (!got.ok) return got.error ? fail(got.error, got.message) : fail(ERR.PROPOSAL_NOT_FOUND);
    const record = got.record;

    // State machine gate — terminal and in-flight states short-circuit here.
    if (record.state === 'REJECTED_FINAL') {
      return fail(ERR.PROPOSAL_REJECTED, 'a rejected proposal can never execute');
    }
    if (record.state === 'PERSISTED_PENDING') {
      return fail(ERR.PROPOSAL_NOT_AUTHORIZED, 'proposal has no HUMAN-TURN authorization');
    }
    if (record.state === 'EXECUTION_STARTED') {
      return fail(ERR.EXECUTION_ALREADY_STARTED, 'an execution already started for this proposal; recovery requires a separate explicit law — no automatic retry');
    }
    if (record.state === 'EXECUTION_COMPLETED' || record.state === 'EXECUTION_FAILED') {
      return {
        ok: true,
        idempotent: true,
        code: ERR.EXECUTION_ALREADY_COMPLETED,
        state: record.state,
        outcome: record.state,
        failure_code: record.execution?.result?.failure_code ?? null,
        proposal_id: proposalId,
        record,
      };
    }
    if (record.state !== 'AUTHORIZED_PENDING_EXECUTION') {
      return fail(ERR.PROPOSAL_NOT_AUTHORIZED, `unexpected proposal state: ${record.state}`);
    }

    // Record + ledger integrity.
    const recordIntegrity = await verifyPendingProposal(storageRoot, proposalId);
    if (!recordIntegrity.ok) return recordIntegrity;
    if (recordIntegrity.valid === false) {
      const details = recordIntegrity.details || [];
      if (details.includes('semantic_checksum_mismatch')) {
        return fail(ERR.SEMANTIC_CHECKSUM_MISMATCH, 'stored semantic checksum no longer matches recomputation');
      }
      return fail(ERR.PROPOSAL_INTEGRITY_FAILURE, JSON.stringify(details));
    }
    const ledgerIntegrity = await verifyEventLedger(storageRoot);
    if (ledgerIntegrity.valid === false) {
      return fail(ERR.EVENT_LEDGER_INTEGRITY_FAILURE, JSON.stringify(ledgerIntegrity));
    }

    // HUMAN-TURN decision integrity — authority is read, never produced here.
    const authority = record.authority || {};
    if (authority.decision_state !== 'AUTHORIZED') {
      return fail(ERR.PROPOSAL_NOT_AUTHORIZED, `decision_state is ${authority.decision_state}, not AUTHORIZED`);
    }
    if (authority.decision !== 'AUTHORIZE' || authority.decided_by !== 'MYSELF' || !authority.verification || typeof authority.verification.authority_id !== 'string' || typeof authority.verification.credential_fingerprint !== 'string') {
      return fail(ERR.DECISION_INTEGRITY_FAILURE, 'authorization lacks a complete verification receipt');
    }
    const events = Array.isArray(record.events) ? record.events : [];
    const latestEvent = events[events.length - 1];
    if (!latestEvent || latestEvent.type !== 'PROPOSAL_AUTHORIZED') {
      return fail(ERR.AUTHORIZATION_EVENT_MISMATCH, `latest event is ${latestEvent ? latestEvent.type : 'missing'}, not PROPOSAL_AUTHORIZED`);
    }
    const authorizationEventHash = latestEvent.event_hash;

    // Execution class law.
    const storedClass = record.packet?.execution_class;
    const classMeta = storedClass ? EXECUTION_CLASSES[storedClass] : undefined;
    if (!storedClass || !classMeta) {
      return fail(ERR.UNKNOWN_EXECUTION_CLASS, `unknown execution class: ${storedClass}`);
    }
    if (!classMeta.terminal) {
      return fail(ERR.UNKNOWN_EXECUTION_CLASS, `non-terminal execution class may never execute: ${storedClass}`);
    }
    if (record.requested_execution?.class !== storedClass || record.route_plan?.execution_class !== storedClass) {
      return fail(ERR.EXECUTION_CLASS_MISMATCH, 'packet, route plan, and requested execution disagree on execution class');
    }

    // Deterministic plan derivation — registry only; intent text plays no role.
    const route = record.packet?.route;
    const operation = OPERATION_REGISTRY[`${route}::${storedClass}`];
    if (!operation) {
      return fail(ERR.INVALID_EXECUTION_PLAN, `no bounded operation is registered for route "${route}" with class "${storedClass}"`);
    }

    // Firewall revalidation — the sealed law this module did not write.
    const approval = evaluateApproval(storedClass, operation.display);
    if (!approval.ok) {
      if (approval.code === 'class_mismatch') return fail(ERR.EXECUTION_CLASS_MISMATCH, approval.reason);
      if (approval.code === 'unknown_class' || approval.code === 'missing_class') return fail(ERR.UNKNOWN_EXECUTION_CLASS, approval.reason);
      return fail(ERR.FIREWALL_DENIED, approval.reason);
    }
    const classPolicy = enforceClassPolicy(operation.display, storedClass);
    if (!classPolicy.allowed) {
      return fail(ERR.FIREWALL_DENIED, `class policy denied: ${classPolicy.reason} [rule: ${classPolicy.pattern}]`);
    }
    const firewall = inspectCommand(operation.display);
    if (!firewall.allowed) {
      return fail(ERR.FIREWALL_DENIED, `firewall denied: ${firewall.reason} [rule: ${firewall.pattern}]`);
    }

    // cwd boundary + symlink law.
    const cwdVerdict = await validateCwdBoundary();
    if (!cwdVerdict.ok) return cwdVerdict;

    // Immutable execution plan.
    const executionId = `exec-${proposalId}`;
    const plan = {
      plan_version: EXECUTION_PLAN_VERSION,
      execution_id: executionId,
      proposal_id: proposalId,
      proposal_record_hash: record.integrity.record_hash,
      authorization_event_hash: authorizationEventHash,
      semantic_checksum: record.semantic_checksum,
      execution_class: storedClass,
      executable: operation.executable,
      argv: [...operation.argv],
      display_command: operation.display,
      cwd: cwdVerdict.cwd,
      timeout_ms: timeoutMs,
      environment: { ...MINIMAL_ENV },
      stdout_limit_bytes: maxOutputBytes,
      stderr_limit_bytes: maxOutputBytes,
      created_at: now(),
      plan_hash: null,
    };
    plan.plan_hash = computeExecutionPlanHash(plan);

    // ── One-shot exclusive claim (O_EXCL) — never deleted by this module ────
    const idCheck = resolveProposalPath(storageRoot, proposalId);
    if (!idCheck.ok) {
      return fail(ERR.INVALID_EXECUTION_REQUEST, 'proposal id is not a safe storage token');
    }
    const lockPath = executionLockPath(storageRoot, proposalId);
    if (!(await assertNotSymlink(lockPath))) {
      return fail(ERR.CONCURRENT_EXECUTION_CONFLICT, 'execution claim path is a symlink — refusing');
    }
    try {
      await mkdir(executionsDir(storageRoot), { recursive: true });
      await writeFile(lockPath, JSON.stringify({ execution_id: executionId, proposal_id: proposalId, claimed_at: now(), pid: process.pid }) + '\n', { flag: 'wx' });
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        return fail(ERR.CONCURRENT_EXECUTION_CONFLICT, 'another caller already holds the execution claim for this proposal');
      }
      return fail(ERR.EXECUTION_START_WRITE_FAILED, String(err && err.message || err));
    }

    // Post-claim re-read: the state we validated must still hold.
    const reread = await getPendingProposal(storageRoot, proposalId);
    if (!reread.ok || reread.record.state !== 'AUTHORIZED_PENDING_EXECUTION' || reread.record.integrity.record_hash !== record.integrity.record_hash) {
      return fail(ERR.CONCURRENT_EXECUTION_CONFLICT, 'proposal changed between validation and claim');
    }

    // ── Durable EXECUTION_STARTED before any process invocation ─────────────
    const startedAt = now();
    let startedGlobalEvent;
    try {
      startedGlobalEvent = await appendGlobalEvent(storageRoot, {
        event_version: EXECUTION_EVENT_VERSION,
        type: 'EXECUTION_STARTED',
        proposal_id: proposalId,
        execution_id: executionId,
        plan_hash: plan.plan_hash,
        proposal_record_hash: plan.proposal_record_hash,
        authorization_event_hash: authorizationEventHash,
        semantic_checksum: record.semantic_checksum,
        execution_class: storedClass,
        at: startedAt,
      });
    } catch (err) {
      return fail(ERR.EXECUTION_START_WRITE_FAILED, String(err && err.message || err));
    }

    const startedRecord = {
      ...record,
      state: 'EXECUTION_STARTED',
      execution: {
        execution_version: EXECUTION_PLAN_VERSION,
        execution_id: executionId,
        status: 'STARTED',
        started_at: startedAt,
        plan,
        result: null,
        result_hash: null,
      },
      events: [
        ...events,
        {
          event_version: EXECUTION_EVENT_VERSION,
          type: 'EXECUTION_STARTED',
          proposal_id: proposalId,
          execution_id: executionId,
          plan_hash: plan.plan_hash,
          proposal_record_hash: plan.proposal_record_hash,
          authorization_event_hash: authorizationEventHash,
          semantic_checksum: record.semantic_checksum,
          execution_class: storedClass,
          at: startedAt,
          event_hash: startedGlobalEvent.event_hash,
          previous_event_hash: startedGlobalEvent.previous_event_hash,
        },
      ],
    };
    startedRecord.integrity = { ...record.integrity, record_hash: null };
    startedRecord.integrity.record_hash = computeRecordHash(startedRecord);

    const resolved = resolveProposalPath(storageRoot, proposalId);
    if (!resolved.ok || !(await assertNotSymlink(resolved.target))) {
      return fail(ERR.EXECUTION_START_WRITE_FAILED, 'proposal record path is no longer safe to write');
    }
    try {
      await atomicWriteJson(resolved.target, startedRecord);
    } catch (err) {
      return fail(ERR.EXECUTION_START_WRITE_FAILED, String(err && err.message || err));
    }

    // ── Bounded process invocation — the single spawn of this proposal ──────
    const processOutcome = await runBoundedProcess({ spawnImpl, plan, now });

    const failureCode =
      processOutcome.classification === 'spawn_failed' ? ERR.EXECUTION_SPAWN_FAILED
      : processOutcome.classification === 'timeout' ? ERR.EXECUTION_TIMEOUT
      : processOutcome.classification === 'nonzero_exit' ? ERR.EXECUTION_NONZERO_EXIT
      : null;

    const result = {
      classification: processOutcome.classification,
      failure_code: failureCode,
      exit_code: processOutcome.exit_code ?? null,
      signal: processOutcome.signal ?? null,
      timed_out: processOutcome.classification === 'timeout',
      spawn_error: processOutcome.spawn_error ?? null,
      stdout: processOutcome.stdout ?? '',
      stdout_truncated: processOutcome.stdout_truncated ?? false,
      stderr: processOutcome.stderr ?? '',
      stderr_truncated: processOutcome.stderr_truncated ?? false,
      duration_ms: processOutcome.duration_ms,
    };
    const resultHash = computeExecutionResultHash(result);
    const terminalType = failureCode === null ? 'EXECUTION_COMPLETED' : 'EXECUTION_FAILED';
    const completedAt = now();

    let terminalGlobalEvent;
    try {
      terminalGlobalEvent = await appendGlobalEvent(storageRoot, {
        event_version: EXECUTION_EVENT_VERSION,
        type: terminalType,
        proposal_id: proposalId,
        execution_id: executionId,
        plan_hash: plan.plan_hash,
        proposal_record_hash: plan.proposal_record_hash,
        authorization_event_hash: authorizationEventHash,
        semantic_checksum: record.semantic_checksum,
        execution_class: storedClass,
        result_hash: resultHash,
        failure_code: failureCode,
        at: completedAt,
      });
    } catch (err) {
      return fail(ERR.EXECUTION_RESULT_WRITE_FAILED, String(err && err.message || err));
    }

    const terminalRecord = {
      ...startedRecord,
      state: terminalType,
      execution: {
        ...startedRecord.execution,
        status: terminalType === 'EXECUTION_COMPLETED' ? 'COMPLETED' : 'FAILED',
        completed_at: completedAt,
        result,
        result_hash: resultHash,
      },
      events: [
        ...startedRecord.events,
        {
          event_version: EXECUTION_EVENT_VERSION,
          type: terminalType,
          proposal_id: proposalId,
          execution_id: executionId,
          plan_hash: plan.plan_hash,
          proposal_record_hash: plan.proposal_record_hash,
          authorization_event_hash: authorizationEventHash,
          semantic_checksum: record.semantic_checksum,
          execution_class: storedClass,
          result_hash: resultHash,
          failure_code: failureCode,
          at: completedAt,
          event_hash: terminalGlobalEvent.event_hash,
          previous_event_hash: terminalGlobalEvent.previous_event_hash,
        },
      ],
    };
    terminalRecord.integrity = { ...startedRecord.integrity, record_hash: null };
    terminalRecord.integrity.record_hash = computeRecordHash(terminalRecord);

    try {
      await atomicWriteJson(resolved.target, terminalRecord);
    } catch (err) {
      return fail(ERR.EXECUTION_RESULT_WRITE_FAILED, String(err && err.message || err));
    }

    return {
      ok: true,
      idempotent: false,
      executed: true,
      state: terminalRecord.state,
      outcome: terminalType,
      failure_code: failureCode,
      proposal_id: proposalId,
      execution_id: executionId,
      plan,
      result,
      record: terminalRecord,
    };
  }

  return { executeAuthorizedProposal };
}

/**
 * Read-only: current execution state of a proposal. Involves no credential,
 * no lock, no process — safe to call directly.
 */
export async function getProposalExecutionState(storageRoot, proposalId) {
  const got = await getPendingProposal(storageRoot, proposalId);
  if (!got.ok) return got;
  const record = got.record;
  return {
    ok: true,
    proposal_id: proposalId,
    state: record.state,
    decision_state: record.authority?.decision_state ?? null,
    execution_status: record.execution?.status ?? null,
    failure_code: record.execution?.result?.failure_code ?? null,
    record,
  };
}

/**
 * Verify a proposal's execution-relevant integrity after (or before) a fresh
 * read: underlying T-030 record hash + ledger chain, and — when an execution
 * block exists — plan-hash, result-hash, state/event, and authority-block
 * consistency. Never mutates anything, regardless of outcome.
 */
export async function verifyProposalExecution(storageRoot, proposalId) {
  const recordIntegrity = await verifyPendingProposal(storageRoot, proposalId);
  if (!recordIntegrity.ok) return recordIntegrity;
  const details = [];
  if (recordIntegrity.valid === false) {
    details.push(...(recordIntegrity.details || ['record_integrity_failure']));
  }

  const ledgerIntegrity = await verifyEventLedger(storageRoot);
  if (ledgerIntegrity.valid === false) {
    details.push('event_ledger_integrity_failure');
  }

  const got = await getPendingProposal(storageRoot, proposalId);
  if (!got.ok) return got;
  const record = got.record;

  const execution = record.execution;
  const executionStates = ['EXECUTION_STARTED', 'EXECUTION_COMPLETED', 'EXECUTION_FAILED'];
  if (!execution) {
    if (executionStates.includes(record.state)) details.push('execution_state_without_execution_block');
    return details.length > 0
      ? { ok: true, valid: false, error: ERR.PROPOSAL_INTEGRITY_FAILURE, details }
      : { ok: true, valid: true, executed: false };
  }

  if (!executionStates.includes(record.state)) details.push('execution_block_without_execution_state');

  const plan = execution.plan;
  if (!plan || plan.plan_version !== EXECUTION_PLAN_VERSION) {
    details.push('invalid_plan_version');
  } else {
    if (computeExecutionPlanHash(plan) !== plan.plan_hash) details.push('plan_hash_mismatch');
    if (plan.proposal_id !== proposalId) details.push('plan_proposal_mismatch');
    if (plan.semantic_checksum !== record.semantic_checksum) details.push('plan_semantic_checksum_mismatch');
    if (plan.execution_class !== record.packet?.execution_class) details.push('plan_execution_class_mismatch');
  }

  // The authority block must have survived execution untouched.
  if (record.authority?.decision_state !== 'AUTHORIZED' || record.authority?.decision !== 'AUTHORIZE') {
    details.push('authority_block_mutated');
  }
  if (!record.events.some((e) => e.type === 'PROPOSAL_AUTHORIZED')) {
    details.push('authorization_event_missing');
  }

  const lastEvent = record.events[record.events.length - 1];
  if (record.state === 'EXECUTION_COMPLETED' || record.state === 'EXECUTION_FAILED') {
    if (!execution.result || typeof execution.result_hash !== 'string') {
      details.push('missing_execution_result');
    } else if (computeExecutionResultHash(execution.result) !== execution.result_hash) {
      details.push('result_hash_mismatch');
    }
    const expectedType = record.state;
    if (!lastEvent || lastEvent.type !== expectedType) details.push('terminal_event_type_mismatch');
    else if (execution.result_hash && lastEvent.result_hash !== execution.result_hash) details.push('terminal_event_result_hash_mismatch');
    const expectedStatus = record.state === 'EXECUTION_COMPLETED' ? 'COMPLETED' : 'FAILED';
    if (execution.status !== expectedStatus) details.push('execution_status_state_mismatch');
  } else if (record.state === 'EXECUTION_STARTED') {
    if (!lastEvent || lastEvent.type !== 'EXECUTION_STARTED') details.push('started_event_type_mismatch');
    if (execution.status !== 'STARTED') details.push('execution_status_state_mismatch');
  }

  if (details.length > 0) {
    return { ok: true, valid: false, error: ERR.PROPOSAL_INTEGRITY_FAILURE, details };
  }
  return { ok: true, valid: true, executed: record.state === 'EXECUTION_COMPLETED' || record.state === 'EXECUTION_FAILED' };
}

/**
 * Read-only: report whether an execution claim (lock) exists for a proposal.
 * This module never deletes a claim — stale-claim recovery is a separate,
 * explicitly authorized law outside T-032.
 */
export async function getExecutionClaim(storageRoot, proposalId) {
  const lockPath = executionLockPath(storageRoot, proposalId);
  if (!(await assertNotSymlink(lockPath))) {
    return { ok: true, claimed: true, claim: null, symlink: true };
  }
  const raw = await readFile(lockPath, 'utf8').catch(() => null);
  if (raw === null) return { ok: true, claimed: false, claim: null };
  let claim = null;
  try { claim = JSON.parse(raw); } catch { /* malformed claim is still a claim */ }
  return { ok: true, claimed: true, claim };
}
