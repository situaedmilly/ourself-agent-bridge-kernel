// runtime/timeself.js
// ── T-034: TIMESELF — the single injectable institutional clock ─────────────
//
// PURPOSE
//   Provide every T-034 runtime module with one governed source of
//   institutional time: wall-clock timestamps (ISO-8601 UTC), monotonic
//   durations, work eligibility, lease expiry, retry deadlines, queue age,
//   heartbeat deadlines, and maintenance-window state.
//
// FOUNDATIONAL LAW
//   TIMESELF ≠ AUTHORITY.
//   TIMESELF answers "what time is it / when is work eligible / has a lease
//   expired / when is maintenance scheduled". TIMESELF never authorizes work,
//   selects execution classes, overrides policy, fabricates HUMAN-TURN,
//   automatically retries consequential execution, or mutates proposals.
//   Nothing in this module reads, writes, or references authority state.
//
// CLOCK LAW
//   The ONLY place in T-034 runtime logic permitted to touch Date /
//   process.hrtime is createSystemClock below. Every other runtime module
//   receives an injected TIMESELF and must not construct its own time.
//   Tests use createFakeClock for full determinism.
//
// MONOTONIC LAW
//   Durations derive from monotonicNow(), never from wall-clock subtraction.
//   A wall-clock rollback can never produce a negative duration: elapsed
//   values clamp at zero and monotonicNow never moves backward.

'use strict';

export const TIMESELF_VERSION = 'ourself.timeself.v1';

// ── Clock adapters ───────────────────────────────────────────────────────────

/**
 * Production clock adapter. The single authorized Date / hrtime boundary for
 * all T-034 runtime logic.
 */
export function createSystemClock() {
  return {
    clock_kind: 'system',
    nowMs: () => Date.now(),
    monotonicMs: () => Number(process.hrtime.bigint() / 1_000_000n),
  };
}

/**
 * Deterministic test clock. Starts at a fixed instant and advances only when
 * told to. Wall and monotonic time are independently controllable so
 * wall-rollback scenarios can be proven.
 */
export function createFakeClock({ startIso = '2026-07-11T00:00:00.000Z', startMonotonicMs = 0 } = {}) {
  let wallMs = Date.parse(startIso);
  if (!Number.isFinite(wallMs)) {
    throw new TypeError('createFakeClock requires a valid ISO startIso');
  }
  let monoMs = startMonotonicMs;
  return {
    clock_kind: 'fake',
    nowMs: () => wallMs,
    monotonicMs: () => monoMs,
    /** Advance both wall and monotonic time forward. */
    advance(ms) {
      if (!Number.isFinite(ms) || ms < 0) throw new TypeError('advance requires a non-negative ms');
      wallMs += ms;
      monoMs += ms;
    },
    /** Move ONLY the wall clock (may go backward) — monotonic never moves back. */
    setWall(iso) {
      const parsed = Date.parse(iso);
      if (!Number.isFinite(parsed)) throw new TypeError('setWall requires a valid ISO string');
      wallMs = parsed;
    },
  };
}

// ── TIMESELF service ─────────────────────────────────────────────────────────

const DEFAULT_LEASE_DURATION_MS = 60_000;
const MAX_LEASE_DURATION_MS = 15 * 60_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_RETRY_BASE_MS = 5_000;
const MAX_RETRY_DELAY_MS = 60 * 60_000;

function toIso(ms) {
  return new Date(ms).toISOString();
}

/**
 * Construct TIMESELF over an injected clock. Pure computation over the clock;
 * no I/O, no authority, no mutation of any record it inspects.
 */
export function createTimeself(clock) {
  if (!clock || typeof clock.nowMs !== 'function' || typeof clock.monotonicMs !== 'function') {
    throw new TypeError('createTimeself requires a clock with nowMs() and monotonicMs()');
  }
  let lastMonotonic = clock.monotonicMs();

  function monotonicNow() {
    // Monotonic time never moves backward even if the adapter misbehaves.
    const m = clock.monotonicMs();
    if (m > lastMonotonic) lastMonotonic = m;
    return lastMonotonic;
  }

  function nowMs() {
    return clock.nowMs();
  }

  return Object.freeze({
    timeself_version: TIMESELF_VERSION,
    clock_kind: clock.clock_kind ?? 'unknown',

    /** Current institutional wall-clock instant, ISO-8601 UTC. */
    now: () => toIso(nowMs()),
    nowMs,
    /** Monotonic milliseconds — for durations only, never persisted as a timestamp. */
    monotonicNow,
    /** Non-negative elapsed duration between two monotonic readings. */
    elapsedMs: (startMonotonicMs) => Math.max(0, monotonicNow() - startMonotonicMs),

    /** Bounded scheduler hook: how long until an ISO instant (never negative). */
    delayUntilMs: (iso) => Math.max(0, Date.parse(iso) - nowMs()),

    /** Is a queue item eligible to run now (eligible_at reached or absent)? */
    isEligible: (item) => {
      const at = item?.eligible_at;
      if (at === null || at === undefined) return true;
      const parsed = Date.parse(at);
      return Number.isFinite(parsed) ? nowMs() >= parsed : false;
    },

    /** Has a queue item expired (expires_at passed; NO_EXPIRY never expires)? */
    isExpired: (item) => {
      const at = item?.expires_at;
      if (at === null || at === undefined || at === 'NO_EXPIRY') return false;
      const parsed = Date.parse(at);
      return Number.isFinite(parsed) ? nowMs() > parsed : false;
    },

    /** Has a lease's expiry instant passed? */
    isLeaseExpired: (lease) => {
      const parsed = Date.parse(lease?.lease_expires_at ?? '');
      return Number.isFinite(parsed) ? nowMs() > parsed : true;
    },

    /** Compute a lease deadline from now, bounded to the maximum lease law. */
    leaseDeadline: (durationMs = DEFAULT_LEASE_DURATION_MS) => {
      const bounded = Math.min(Math.max(Number.isFinite(durationMs) ? durationMs : DEFAULT_LEASE_DURATION_MS, 1), MAX_LEASE_DURATION_MS);
      return toIso(nowMs() + bounded);
    },

    /**
     * Deterministic retry-eligibility deadline: bounded exponential backoff on
     * attempt count. Answers WHEN a retryable item becomes eligible — it never
     * decides WHETHER retry is permitted (that is the queue retry-class law).
     */
    retryDeadline: (policy, attempt) => {
      const base = Number.isFinite(policy?.baseDelayMs) ? policy.baseDelayMs : DEFAULT_RETRY_BASE_MS;
      const n = Number.isInteger(attempt) && attempt > 0 ? attempt : 1;
      const delay = Math.min(base * 2 ** (n - 1), MAX_RETRY_DELAY_MS);
      return toIso(nowMs() + delay);
    },

    /** Age of a queue item in ms (never negative). */
    queueAgeMs: (item) => {
      const parsed = Date.parse(item?.created_at ?? '');
      return Number.isFinite(parsed) ? Math.max(0, nowMs() - parsed) : 0;
    },

    /** Next heartbeat deadline from now. */
    heartbeatDeadline: (intervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS) => toIso(nowMs() + Math.max(1, intervalMs)),

    /** Is a heartbeat stale relative to an allowed staleness window? */
    isHeartbeatStale: (lastHeartbeatIso, staleAfterMs) => {
      const parsed = Date.parse(lastHeartbeatIso ?? '');
      if (!Number.isFinite(parsed)) return true;
      return nowMs() - parsed > staleAfterMs;
    },

    /**
     * Maintenance-window state. T-034 defines no scheduled windows; the
     * deterministic answer is NONE. Future gates may declare windows as data.
     */
    maintenanceWindowState: () => Object.freeze({ state: 'NONE', window: null }),
  });
}
