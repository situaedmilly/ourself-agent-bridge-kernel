// persistence/canonical-json.js
// ── Deterministic canonicalization and hashing for durable OURSELF records ──
//
// PURPOSE
//   Produce a stable JSON string for any plain-data object regardless of key
//   insertion order, so hashes computed over the same logical content are
//   always identical. Used by persistence/pending-proposals.js to bind
//   identity and detect tampering.

'use strict';

import { createHash } from 'node:crypto';

/**
 * Recursively sort object keys so JSON.stringify output is order-independent.
 * Arrays preserve their existing order (order is semantically meaningful).
 * @param {*} value
 * @returns {*}
 */
function sortForCanonicalization(value) {
  if (Array.isArray(value)) {
    return value.map(sortForCanonicalization);
  }
  if (value && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortForCanonicalization(value[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Canonical JSON string for the given value — same logical content always
 * produces the same string, independent of key insertion order.
 * @param {*} value
 * @returns {string}
 */
export function canonicalize(value) {
  return JSON.stringify(sortForCanonicalization(value));
}

/**
 * SHA-256 hex digest of the canonical JSON form of a value.
 * @param {*} value
 * @returns {string} 64-char hex digest
 */
export function canonicalHash(value) {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}
