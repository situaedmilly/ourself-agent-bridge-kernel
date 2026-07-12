// persistence/canonical-json.js
// ── Deterministic canonicalization and hashing via SELF Protocol Core ──
//
// This adapter delegates canonical serialization and hashing to the SELF
// Protocol Core (self-protocol-suite), which owns the canonical algorithm.
// The kernel preserves its historical export names (canonicalize, canonicalHash)
// while adopting the protocol's implementation, reversing the dependency at
// one choke point: this single file.
//
// Sealed kernel consumers import from this module unchanged.
// Their behavior is preserved; their implementation is delegated.

import { canonicalSerialize, computeIntegrityDigest } from 'self-protocol-suite';

// Preserve kernel's historical export: canonical JSON serialization.
// Input: any value; Output: canonical JSON string (order-independent).
export function canonicalize(value) {
  return canonicalSerialize(value);
}

// Preserve kernel's historical export: SHA-256 hex digest of canonical form.
// Input: any value; Output: 64-char lowercase hex digest string.
export function canonicalHash(value) {
  return computeIntegrityDigest(value);
}
