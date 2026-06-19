// tools/realm-gate.js
// ── Pass 20B.1 · Deterministic Realm Gate rate limiter ──────────────────────
//
// PURPOSE
//   Extract the Pass 19C Realm Gate failure-rate-limit STATE MACHINE out of the
//   request handler into a pure, time-injected unit. The behavior is unchanged;
//   the only difference is that the current time is passed IN as `now` rather
//   than read from the wall clock inside the limiter. Production passes
//   Date.now(); tests pass a controlled value and advance it explicitly, so the
//   limiter can be proven deterministically with no sleeping and no wall-clock
//   windows (which caused a rare non-reproducible flake before 20B.1).
//
// SECURITY
//   This is the SAME limiter, relocated. It is not weaker: a VALID token is
//   never rate-limited and always clears the client's failure record; FAILED
//   attempts are counted within a window and trigger a lockout at the threshold.
//   The limiter never receives or stores the presented token — only a boolean
//   `valid` and the client key — so no secret can leak through it.
//
// CONTRACT
//   createRealmGate({ maxFailures, windowMs, lockoutMs }) -> {
//     evaluate(key, valid, now) -> {
//       outcome: 'pass' | 'unauthorized' | 'locked',
//       retryAfter?: number,   // seconds, present when outcome === 'locked'
//       justLocked?: boolean,  // true on the request that crosses the threshold
//       count?: number,        // failure count at the moment of locking
//     },
//     failures,                // Map<key, {count, windowStart, lockedUntil}> (introspection)
//     reset(),                 // clear all failure records
//   }

/**
 * Create a Realm Gate rate limiter with injectable time.
 * @param {{maxFailures:number, windowMs:number, lockoutMs:number}} cfg
 */
export function createRealmGate({ maxFailures, windowMs, lockoutMs }) {
  // clientKey -> { count, windowStart, lockedUntil }. Never stores a token.
  const failures = new Map();

  /**
   * Evaluate a request against the limiter.
   * @param {string} key   stable client key (ip / remote address).
   * @param {boolean} valid whether the presented token is valid.
   * @param {number} now   current time in ms (INJECTED — production: Date.now()).
   * @returns {{outcome:string, retryAfter?:number, justLocked?:boolean, count?:number}}
   */
  function evaluate(key, valid, now) {
    // A valid token is never rate-limited and clears accumulated failures.
    if (valid) {
      failures.delete(key);
      return { outcome: 'pass' };
    }

    let rec = failures.get(key);

    // Already locked out → reject without further counting.
    if (rec && rec.lockedUntil > now) {
      return { outcome: 'locked', retryAfter: Math.ceil((rec.lockedUntil - now) / 1000) };
    }

    // Start a fresh window if there is none or the previous one has elapsed.
    if (!rec || now - rec.windowStart > windowMs) {
      rec = { count: 0, windowStart: now, lockedUntil: 0 };
    }
    rec.count += 1;

    // Threshold reached → lock out for the cooldown period.
    if (rec.count >= maxFailures) {
      rec.lockedUntil = now + lockoutMs;
      failures.set(key, rec);
      return {
        outcome: 'locked',
        retryAfter: Math.ceil(lockoutMs / 1000),
        justLocked: true,
        count: rec.count,
      };
    }

    failures.set(key, rec);
    return { outcome: 'unauthorized' };
  }

  function reset() {
    failures.clear();
  }

  return { evaluate, failures, reset };
}
