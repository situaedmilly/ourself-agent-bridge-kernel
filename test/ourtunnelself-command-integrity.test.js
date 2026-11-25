import test from "node:test";
import assert from "node:assert/strict";
import {
  COMMAND_ENCODING, canonicalJsonBytes, canonicalJsonStringify,
  parseCanonicalJson, commandDigest, verifyCommandBytes
} from "../runtime/ourtunnelself/command-integrity.js";

test("RFC 8785 JCS sorts object keys and preserves array order", () => {
  assert.equal(canonicalJsonStringify({ z: 1, a: { y: 2, b: 3 } }), '{"a":{"b":3,"y":2},"z":1}');
  assert.notEqual(canonicalJsonStringify([1, 2]), canonicalJsonStringify([2, 1]));
});

test("JCS parser rejects whitespace, key-order variants, and duplicate members", () => {
  assert.deepEqual(parseCanonicalJson(Buffer.from('{"a":1,"b":2}')), { a: 1, b: 2 });
  assert.throws(() => parseCanonicalJson(Buffer.from('{ "a":1,"b":2}')), /JCS_BYTES_MISMATCH/);
  assert.throws(() => parseCanonicalJson(Buffer.from('{"b":2,"a":1}')), /JCS_BYTES_MISMATCH/);
  assert.throws(() => parseCanonicalJson(Buffer.from('{"a":1,"a":1}')), /JCS_BYTES_MISMATCH/);
});

test("command digest is domain-separated and length-bound", () => {
  const bytes = canonicalJsonBytes({ action: "repo.status", target: "." });
  const digest = commandDigest(bytes);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(verifyCommandBytes({
    bytes, encoding: COMMAND_ENCODING, byteLength: bytes.length, digest
  }), true);
  assert.throws(() => verifyCommandBytes({
    bytes, encoding: COMMAND_ENCODING, byteLength: bytes.length + 1, digest
  }), /COMMAND_BYTE_LENGTH_INVALID/);
  assert.throws(() => verifyCommandBytes({
    bytes: Buffer.from(bytes.toString("utf8") + " "), encoding: COMMAND_ENCODING,
    byteLength: bytes.length + 1, digest
  }), /COMMAND_DIGEST_MISMATCH/);
});

test("JCS serializer rejects ambiguous or unsupported JavaScript values", () => {
  assert.throws(() => canonicalJsonStringify({ value: undefined }), /JCS_UNDEFINED_REJECTED/);
  assert.throws(() => canonicalJsonStringify({ value: Number.NaN }), /JCS_NONFINITE_NUMBER/);
  assert.throws(() => canonicalJsonStringify(new Date()), /JCS_NON_PLAIN_OBJECT/);
  const sparse = new Array(2);
  assert.throws(() => canonicalJsonStringify(sparse), /JCS_SPARSE_ARRAY/);
});

test("RFC 8785 number serialization uses ECMAScript shortest representations", () => {
  const value = { numbers: [333333333.33333329, 1e30, 4.50, 2e-3, 1e-27] };
  assert.equal(canonicalJsonStringify(value), '{"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27]}');
});
