// test/canonical-json.test.js
// Canonical serialization adapter differential tests.
// Compares adapter behavior against kernel's original algorithm and protocol's.

import test from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { canonicalize, canonicalHash } from '../persistence/canonical-json.js';

// ── Legacy kernel algorithm (test-only reference) ──
// Used to verify the adapter preserves behavior identically.
function legacySortForCanonicalization(value) {
  if (Array.isArray(value)) {
    return value.map(legacySortForCanonicalization);
  }
  if (value && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = legacySortForCanonicalization(value[key]);
    }
    return sorted;
  }
  return value;
}

function legacyCanonicalize(value) {
  return JSON.stringify(legacySortForCanonicalization(value));
}

function legacyCanonicalHash(value) {
  return createHash('sha256').update(legacyCanonicalize(value)).digest('hex');
}

// ── Test vectors ──
const testVectors = [
  // Ordinary values
  { name: 'null', value: null },
  { name: 'boolean_true', value: true },
  { name: 'boolean_false', value: false },
  { name: 'number_zero', value: 0 },
  { name: 'number_negative_zero', value: -0 },
  { name: 'number_positive', value: 42 },
  { name: 'number_float', value: 3.14159 },
  { name: 'number_large', value: 1e10 },
  { name: 'number_negative', value: -999 },
  { name: 'string_empty', value: '' },
  { name: 'string_ascii', value: 'hello' },
  { name: 'string_unicode', value: '你好' },
  { name: 'string_emoji', value: '😀' },
  { name: 'array_empty', value: [] },
  { name: 'array_numbers', value: [1, 2, 3] },
  { name: 'array_mixed', value: [1, 'two', null, true] },
  { name: 'array_nested', value: [[1, 2], [3, 4]] },
  { name: 'object_empty', value: {} },
  { name: 'object_single_key', value: { a: 1 } },
  { name: 'object_multiple_keys_ordered', value: { a: 1, b: 2, c: 3 } },
  { name: 'object_multiple_keys_reversed', value: { c: 3, b: 2, a: 1 } },
  { name: 'object_nested', value: { a: { b: { c: 1 } } } },
  { name: 'object_with_null_property', value: { a: null, b: 2 } },
  { name: 'object_with_undefined_property', value: { a: undefined, b: 2 } },

  // Edge cases
  { name: 'undefined_array_entry', value: [1, undefined, 3] },
  { name: 'sparse_array', value: Object.assign(new Array(5), { 0: 'first', 2: 'third' }) },
  { name: 'NaN', value: NaN },
  { name: 'Infinity', value: Infinity },
  { name: 'negative_Infinity', value: -Infinity },
  { name: 'Date', value: new Date('2026-01-01T00:00:00Z') },
  { name: 'custom_toJSON', value: { value: 1, toJSON() { return { serialized: true }; } } },
  { name: 'emoji_composed', value: '👨‍👩‍👧‍👦' },
  { name: 'escaped_newline', value: 'line1\nline2' },
  { name: 'escaped_tab', value: 'col1\tcol2' },

  // Mission kernel representative records
  {
    name: 'mission_record_shape',
    value: {
      mission_id: 'm-001',
      state: 'COMPLETED',
      current_executor: { executor_id: 'exe-1', executor_type: 'claude' },
      intent: 'accomplish task',
      history: [
        { type: 'STATE_TRANSITION', from: 'RUNNING', to: 'COMPLETED' },
      ],
      interruption_state: null,
      record_hash: undefined,
      promotion_boundary: { status: 'UNREPORTED' },
    },
  },
  {
    name: 'proposal_event_shape',
    value: {
      event_id: 'evt-1',
      packet_id: 'pkt-1',
      proposal_id: 'prop-1',
      event_type: 'PROPOSED',
      route: '/execute',
      execution_class: 'QUICK',
      status: 'PENDING',
      event_hash: null,
      provenance: null,
    },
  },
  {
    name: 'execution_plan_shape',
    value: {
      plan_id: 'plan-1',
      mission_id: 'm-001',
      steps: [
        { step_id: 's1', action: 'deploy', params: { image: 'app:v1' } },
        { step_id: 's2', action: 'verify', params: { timeout_ms: 5000 } },
      ],
      created_at: 1000,
      integrity: { plan_hash: null },
    },
  },
];

test('adapter: canonicalize preserves kernel export name', async (t) => {
  assert.strictEqual(typeof canonicalize, 'function', 'canonicalize is exported');
  const result = canonicalize({ b: 2, a: 1 });
  assert.strictEqual(typeof result, 'string', 'canonicalize returns a string');
});

test('adapter: canonicalHash preserves kernel export name', async (t) => {
  assert.strictEqual(typeof canonicalHash, 'function', 'canonicalHash is exported');
  const result = canonicalHash({ b: 2, a: 1 });
  assert.strictEqual(typeof result, 'string', 'canonicalHash returns a string');
  assert.strictEqual(result.length, 64, 'digest is 64-char hex');
  assert.match(result, /^[0-9a-f]{64}$/, 'digest is lowercase hex');
});

test('adapter: hash output is deterministic', async (t) => {
  const value = { z: 1, a: 2, m: 3 };
  const hash1 = canonicalHash(value);
  const hash2 = canonicalHash(value);
  assert.strictEqual(hash1, hash2, 'identical value produces identical hash');
});

test('adapter: unordered objects hash identically', async (t) => {
  const obj1 = { a: 1, b: 2, c: 3 };
  const obj2 = { c: 3, b: 2, a: 1 };
  const hash1 = canonicalHash(obj1);
  const hash2 = canonicalHash(obj2);
  assert.strictEqual(hash1, hash2, 'key order does not affect hash');
});

test('adapter: array order is preserved in hash', async (t) => {
  const arr1 = [1, 2, 3];
  const arr2 = [3, 2, 1];
  const hash1 = canonicalHash(arr1);
  const hash2 = canonicalHash(arr2);
  assert.notStrictEqual(hash1, hash2, 'array element order affects hash');
});

// ── Differential test: adapter vs legacy ──
test('adapter: differential vs legacy kernel algorithm', async (t) => {
  let matches = 0;
  let failures = [];

  for (const vector of testVectors) {
    // Skip undefined-at-top-level: JSON.stringify(undefined) returns undefined,
    // which cannot be hashed. Both implementations have this limitation.
    if (vector.name === 'undefined_top_level') {
      continue;
    }

    try {
      const adapterSer = canonicalize(vector.value);
      const legacySer = legacyCanonicalize(vector.value);

      if (adapterSer === legacySer) {
        matches++;
      } else {
        failures.push({
          vector: vector.name,
          reason: 'serialization_mismatch',
          adapter: String(adapterSer).substring(0, 60),
          legacy: String(legacySer).substring(0, 60),
        });
      }

      const adapterHash = canonicalHash(vector.value);
      const legacyHash = legacyCanonicalHash(vector.value);

      if (adapterHash !== legacyHash) {
        failures.push({
          vector: vector.name,
          reason: 'hash_mismatch',
          adapter: adapterHash.substring(0, 32),
          legacy: legacyHash.substring(0, 32),
        });
      }
    } catch (e) {
      const legacyError = (() => {
        try {
          legacyCanonicalize(vector.value);
          return null;
        } catch (err) {
          return err.constructor.name;
        }
      })();

      if (legacyError !== e.constructor.name) {
        failures.push({
          vector: vector.name,
          reason: 'error_behavior_mismatch',
          adapter_error: e.constructor.name,
          legacy_error: legacyError,
        });
      }
    }
  }

  if (failures.length > 0) {
    console.error('Differential failures:');
    for (const f of failures) console.error('  ', f);
  }

  assert.strictEqual(
    failures.length,
    0,
    `Differential vectors must match legacy behavior`
  );
});

// ── Historical compatibility: prove records persist identically ──
test('adapter: historical mission record compatibility', async (t) => {
  const record = {
    mission_id: 'm-hist-001',
    state: 'COMPLETED',
    history: [{ type: 'STATE_TRANSITION', from: 'RUNNING', to: 'COMPLETED' }],
  };

  const legacyHash = legacyCanonicalHash(record);
  const adapterHash = canonicalHash(record);

  assert.strictEqual(
    adapterHash,
    legacyHash,
    'Historical record hashes identically under adapter'
  );
});

test('adapter: all export names are preserved', async (t) => {
  const exports = { canonicalize, canonicalHash };
  const expectedNames = ['canonicalize', 'canonicalHash'];

  for (const name of expectedNames) {
    assert(name in exports, `${name} is exported`);
    assert.strictEqual(typeof exports[name], 'function', `${name} is a function`);
  }
});

test('adapter: no fallback algorithm embedded', async (t) => {
  const filePath = new URL('../persistence/canonical-json.js', import.meta.url);
  const src = readFileSync(filePath, 'utf8');

  assert(!src.includes('sortForCanonicalization'), 'no legacy sortForCanonicalization');
  assert(!src.includes('createHash'), 'no direct crypto usage');
  assert(src.includes('canonicalSerialize'), 'imports protocol canonicalSerialize');
  assert(src.includes('computeIntegrityDigest'), 'imports protocol computeIntegrityDigest');
});
