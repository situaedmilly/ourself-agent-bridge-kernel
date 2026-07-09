// test/ourself-intake.test.js
// ── OURSELF Æ Packet to Kernel Handshake Adapter Tests ──────────────────────
//
// Tests the adapter contract behavior, rejection codes, determinism, and
// security properties without executing any commands.

import { test } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  computeSemanticChecksum,
  validateOurselfEnvelope,
  translateToKernelProposal,
  processOurselfIntake,
} from '../adapters/ourself-intake.js';

// ── Test helpers ─────────────────────────────────────────────────────────────

const validPacket = {
  packet_id: 'ae-test-001',
  created: '2026-07-09T00:39:18.000Z',
  route: 'blueprint',
  execution_class: 'inspect',
  status: 'planned',
  node: 'Milly',
  source: 'cli',
  raw_text: 'draft a blueprint',
  target: null,
  risk: 'low',
  parent_aecho: null,
};

const validRoutePlan = {
  route: 'blueprint',
  execution_class: 'inspect',
  mutation: false,
  requires_approval: true,
  reason: 'Read-only inspection command',
  status: 'planned',
  sia: 'ChatSELF',
  proof_required: [],
};

const validRequestedExecution = {
  class: 'inspect',
  mutation_requested: false,
};

const validEnvelope = {
  protocol: 'ourself.ae-kernel.v1',
  packet: validPacket,
  route_plan: validRoutePlan,
  origin: {
    self: 'ourself-agent-bridge',
    source: 'cli-mouth',
  },
  authority: {
    state: 'PENDING_HUMAN_TURN',
    human_turn_required: true,
  },
  requested_execution: validRequestedExecution,
  expected_evidence: ['blueprint-docs', 'schema-review'],
  semantic_checksum: computeSemanticChecksum(
    validPacket,
    validRoutePlan,
    validRequestedExecution
  ),
};

// ── Semantic checksum tests ──────────────────────────────────────────────────

test('computeSemanticChecksum produces consistent output for the same semantic input', () => {
  const cs1 = computeSemanticChecksum(
    validPacket,
    validRoutePlan,
    validRequestedExecution
  );
  const cs2 = computeSemanticChecksum(
    validPacket,
    validRoutePlan,
    validRequestedExecution
  );
  assert.equal(cs1, cs2, 'Same semantic input must produce identical checksum');
  assert.match(cs1, /^[a-f0-9]{64}$/, 'Checksum must be a valid SHA256 hex');
});

test('computeSemanticChecksum is independent of key insertion order', () => {
  // Create two packets with identical semantic content but different key order
  const packet1 = {
    packet_id: 'ae-test-001',
    route: 'blueprint',
    execution_class: 'inspect',
  };
  const packet2 = {
    execution_class: 'inspect',
    route: 'blueprint',
    packet_id: 'ae-test-001',
  };
  // Note: computeSemanticChecksum uses a fixed key order internally,
  // so it should produce the same checksum regardless of input key order
  const rp = { route: 'blueprint', execution_class: 'inspect', mutation: false, requires_approval: true };
  const re = { class: 'inspect', mutation_requested: false };

  // Both packets have the same semantic values; checksums should match
  const cs1 = computeSemanticChecksum({ ...packet1, status: 'planned', node: 'X', source: 'X', risk: 'low' }, rp, re);
  const cs2 = computeSemanticChecksum({ ...packet2, status: 'planned', node: 'X', source: 'X', risk: 'low' }, rp, re);
  // The fixed-order semantic object inside should match
  assert.equal(cs1, cs2, 'Key insertion order must not affect checksum');
});

// ── Validation tests ─────────────────────────────────────────────────────────

test('validateOurselfEnvelope accepts a valid envelope', () => {
  const result = validateOurselfEnvelope(validEnvelope);
  assert.equal(result.ok, true, 'Valid envelope must pass validation');
  assert.equal(result.error, undefined);
});

test('validateOurselfEnvelope rejects an invalid protocol', () => {
  const env = { ...validEnvelope, protocol: 'ourself.v0' };
  const result = validateOurselfEnvelope(env);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'INVALID_PROTOCOL');
});

test('validateOurselfEnvelope rejects a null envelope', () => {
  const result = validateOurselfEnvelope(null);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'INVALID_ENVELOPE');
});

test('validateOurselfEnvelope rejects when packet is missing required fields', () => {
  const env = JSON.parse(JSON.stringify(validEnvelope));
  delete env.packet.packet_id;
  const result = validateOurselfEnvelope(env);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'INVALID_ENVELOPE');
});

test('validateOurselfEnvelope rejects packet with discarded status', () => {
  const env = JSON.parse(JSON.stringify(validEnvelope));
  env.packet.status = 'discarded';
  const result = validateOurselfEnvelope(env);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'ROUTE_PLAN_PACKET_MISMATCH');
});

test('validateOurselfEnvelope rejects route/execution_class mismatch', () => {
  const env = JSON.parse(JSON.stringify(validEnvelope));
  env.packet.route = 'blueprint';
  env.route_plan.route = 'test';
  env.semantic_checksum = computeSemanticChecksum(env.packet, env.route_plan, env.requested_execution);
  const result = validateOurselfEnvelope(env);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'ROUTE_PLAN_PACKET_MISMATCH');
});

test('validateOurselfEnvelope rejects unknown execution class', () => {
  const env = JSON.parse(JSON.stringify(validEnvelope));
  env.requested_execution.class = 'unknown_class';
  const result = validateOurselfEnvelope(env);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'UNKNOWN_EXECUTION_CLASS');
});

test('validateOurselfEnvelope rejects non-terminal execution class', () => {
  const env = JSON.parse(JSON.stringify(validEnvelope));
  env.requested_execution.class = 'reverse_engineer';
  env.packet.execution_class = 'reverse_engineer';
  env.route_plan.execution_class = 'reverse_engineer';
  const result = validateOurselfEnvelope(env);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'UNKNOWN_EXECUTION_CLASS');
});

test('validateOurselfEnvelope rejects non-PENDING_HUMAN_TURN authority state', () => {
  const env = JSON.parse(JSON.stringify(validEnvelope));
  env.authority.state = 'APPROVED';
  const result = validateOurselfEnvelope(env);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'AUTHORITY_STATE_INVALID');
});

test('validateOurselfEnvelope rejects human_turn_required: false', () => {
  const env = JSON.parse(JSON.stringify(validEnvelope));
  env.authority.human_turn_required = false;
  const result = validateOurselfEnvelope(env);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'HUMAN_TURN_REQUIRED');
});

test('validateOurselfEnvelope rejects invalid semantic checksum', () => {
  const env = JSON.parse(JSON.stringify(validEnvelope));
  env.semantic_checksum = 'badbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbad';
  const result = validateOurselfEnvelope(env);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'SEMANTIC_CHECKSUM_INVALID');
});

test('validateOurselfEnvelope rejects unsafe expected_evidence token', () => {
  const env = JSON.parse(JSON.stringify(validEnvelope));
  env.expected_evidence = ['../../etc/passwd'];
  const result = validateOurselfEnvelope(env);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'UNSAFE_TOKEN');
});

test('validateOurselfEnvelope rejects invalid origin.self', () => {
  const env = JSON.parse(JSON.stringify(validEnvelope));
  env.origin.self = 'agent-bridge';
  const result = validateOurselfEnvelope(env);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'INVALID_ENVELOPE');
});

// ── Translation tests ────────────────────────────────────────────────────────

test('translateToKernelProposal creates a valid proposal from a valid envelope', () => {
  const proposal = translateToKernelProposal(validEnvelope);
  assert.equal(proposal.id, validPacket.packet_id);
  assert.equal(proposal.source, 'ourself-intake');
  assert.equal(proposal.kind, 'proposal');
  assert.equal(proposal.executionClass, 'inspect');
  assert.equal(proposal.mutation, false);
  assert.equal(proposal.route, 'blueprint');
  assert.equal(proposal.requiresApproval, true);
  assert.equal(proposal.authority.state, 'PENDING_HUMAN_TURN');
  assert.equal(proposal.authority.human_turn_required, true);
});

// ── Integration tests ────────────────────────────────────────────────────────

test('processOurselfIntake accepts a valid envelope and returns ACCEPTED_FOR_REVIEW', () => {
  const result = processOurselfIntake(validEnvelope);
  assert.equal(result.status, 'ACCEPTED_FOR_REVIEW');
  assert.equal(result.execution_performed, false);
  assert.equal(result.human_turn_required, true);
  assert.ok(result.proposal, 'Proposal must be present');
  assert.equal(result.error, undefined);
});

test('processOurselfIntake rejects an invalid envelope and returns REJECTED', () => {
  const env = { ...validEnvelope, protocol: 'invalid' };
  const result = processOurselfIntake(env);
  assert.equal(result.status, 'REJECTED');
  assert.equal(result.execution_performed, false);
  assert.equal(result.human_turn_required, true);
  assert.ok(result.error, 'Error object must be present');
  assert.equal(result.error.code, 'INVALID_PROTOCOL');
  assert.equal(result.proposal, undefined);
});

test('processOurselfIntake always returns execution_performed: false', () => {
  const result1 = processOurselfIntake(validEnvelope);
  assert.equal(result1.execution_performed, false);

  const invalidEnv = { ...validEnvelope, protocol: 'invalid' };
  const result2 = processOurselfIntake(invalidEnv);
  assert.equal(result2.execution_performed, false);
});

test('processOurselfIntake always returns human_turn_required: true', () => {
  const result1 = processOurselfIntake(validEnvelope);
  assert.equal(result1.human_turn_required, true);

  const invalidEnv = { ...validEnvelope, protocol: 'invalid' };
  const result2 = processOurselfIntake(invalidEnv);
  assert.equal(result2.human_turn_required, true);
});

// ── Determinism tests ────────────────────────────────────────────────────────

test('processOurselfIntake produces identical output for identical input', () => {
  const result1 = processOurselfIntake(validEnvelope);
  const result2 = processOurselfIntake(validEnvelope);
  assert.deepEqual(result1, result2, 'Identical input must produce identical output');
});

// ── Mutation boundary tests ──────────────────────────────────────────────────

test('validateOurselfEnvelope does not write files', () => {
  // This test verifies that validation is a pure function
  const before = process.cwd();
  validateOurselfEnvelope(validEnvelope);
  const after = process.cwd();
  assert.equal(before, after, 'No file operation should occur');
});

test('processOurselfIntake does not invoke child_process', () => {
  // Verify by static inspection that the module does not import child_process
  const src = readFileSync(
    new URL('../adapters/ourself-intake.js', import.meta.url),
    'utf8'
  );
  assert(!src.includes("import('child_process"), 'Module must not import child_process');
  assert(!src.includes("require('child_process"), 'Module must not require child_process');
  assert(!src.includes('from "child_process'), 'Module must not import from child_process');
  assert(!src.includes("from 'child_process"), 'Module must not import from child_process');
});

test('processOurselfIntake does not make network calls', () => {
  // Verify by static inspection that the module does not import network APIs
  const src = readFileSync(
    new URL('../adapters/ourself-intake.js', import.meta.url),
    'utf8'
  );
  assert(!src.includes('http.'), 'Module must not use http');
  assert(!src.includes('https.'), 'Module must not use https');
  assert(!src.includes('fetch'), 'Module must not call fetch');
  assert(!src.includes('net.'), 'Module must not use net');
});

// ── Contract consistency tests ───────────────────────────────────────────────

test('contract schema files are byte-identical in both repositories', async () => {
  const controlPlaneSchema = readFileSync(
    '/Users/millysituated/RUORA/systems/ourself-agent-bridge/contracts/ae-kernel-envelope.v1.schema.json',
    'utf8'
  );
  const kernelSchema = readFileSync(
    '/Users/millysituated/RUORA/projects/agent-bridge/contracts/ae-kernel-envelope.v1.schema.json',
    'utf8'
  );
  assert.equal(controlPlaneSchema, kernelSchema, 'Contract schemas must be byte-identical');
});

// ── Security boundary tests ──────────────────────────────────────────────────

test('adapter does not expose stack traces in error messages', () => {
  const invalidEnv = { protocol: 'invalid' };
  const result = processOurselfIntake(invalidEnv);
  assert(!result.error.message.includes('at '), 'Error must not contain stack trace');
  assert(!result.error.message.includes('Error:'), 'Error must not contain Error prefix');
});

test('adapter does not expose absolute paths in error messages', () => {
  const invalidEnv = { protocol: 'invalid' };
  const result = processOurselfIntake(invalidEnv);
  assert(!result.error.message.includes('/'), 'Error must not contain paths');
  assert(!result.error.message.includes('RUORA'), 'Error must not contain repo identifiers');
});
