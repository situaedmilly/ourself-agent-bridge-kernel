// adapters/ourself-intake.js
// ── OURSELF Æ Packet to Kernel Handshake Adapter ────────────────────────────
//
// PURPOSE
//   Translate deterministic Æ packets and route plans from the control plane
//   (ourself-agent-bridge) into kernel proposals. This adapter enforces the
//   contract boundary without duplicating route-planning logic from the control
//   plane.
//
// HARD INVARIANTS (this adapter NEVER executes)
//   • Plan-only. No dispatch, no execution, no mutation.
//   • No calls to the filesystem, network, or external services.
//   • No child_process, shell, or terminal interaction.
//   • All failures are deterministic and safe to log.
//   • Validation is fail-closed: unknown classes are rejected, not guessed.
//   • Authority state must be PENDING_HUMAN_TURN; no other state passes.
//   • HUMAN-TURN is always required, no exceptions.
//
// REQUIRED REJECTION CODES (used by error responses)
//   • INVALID_PROTOCOL
//   • INVALID_ENVELOPE
//   • UNKNOWN_EXECUTION_CLASS
//   • AUTHORITY_STATE_INVALID
//   • HUMAN_TURN_REQUIRED
//   • SEMANTIC_CHECKSUM_INVALID
//   • UNSAFE_TOKEN
//   • ROUTE_PLAN_PACKET_MISMATCH

'use strict';

import { createHash } from 'node:crypto';
import { EXECUTION_CLASSES, EXECUTION_CLASS_NAMES } from '../tools/execution-classes.js';

const SAFE_TOKEN_REGEX = /^[a-z0-9][a-z0-9:_+-]{0,63}$/;

/**
 * Compute a deterministic semantic checksum from canonicalized semantic input.
 * Input includes packet fields, route_plan fields, and requested_execution.
 * Key order is fixed; timestamps and insertion order do not affect the result.
 * @param {object} packet
 * @param {object} routePlan
 * @param {object} requestedExecution
 * @returns {string} SHA256 hex digest
 */
export function computeSemanticChecksum(packet, routePlan, requestedExecution) {
  const semantic = {
    packet_route: packet.route,
    packet_execution_class: packet.execution_class,
    packet_status: packet.status,
    packet_node: packet.node,
    packet_source: packet.source,
    packet_risk: packet.risk,
    route_plan_route: routePlan.route,
    route_plan_execution_class: routePlan.execution_class,
    route_plan_mutation: routePlan.mutation,
    route_plan_requires_approval: routePlan.requires_approval,
    requested_class: requestedExecution.class,
    requested_mutation: requestedExecution.mutation_requested,
  };
  const canonical = JSON.stringify(semantic, Object.keys(semantic).sort());
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Validate an envelope against the contract schema (loose schema validation).
 * Returns { ok, error } where error is a safe deterministic code if validation fails.
 * @param {object} envelope
 * @returns {object} { ok: boolean, error?: string }
 */
export function validateOurselfEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object') {
    return { ok: false, error: 'INVALID_ENVELOPE' };
  }

  // Protocol validation
  if (envelope.protocol !== 'ourself.ae-kernel.v1') {
    return { ok: false, error: 'INVALID_PROTOCOL' };
  }

  // Packet validation
  if (!envelope.packet || typeof envelope.packet !== 'object') {
    return { ok: false, error: 'INVALID_ENVELOPE' };
  }
  const p = envelope.packet;
  if (!p.packet_id || !p.created || !p.route || !p.execution_class || !p.status) {
    return { ok: false, error: 'INVALID_ENVELOPE' };
  }
  if (!['planned', 'discarded'].includes(p.status)) {
    return { ok: false, error: 'INVALID_ENVELOPE' };
  }

  // Discard status = kernel rejects immediately
  if (p.status === 'discarded') {
    return { ok: false, error: 'ROUTE_PLAN_PACKET_MISMATCH' };
  }

  // Route plan validation
  if (!envelope.route_plan || typeof envelope.route_plan !== 'object') {
    return { ok: false, error: 'INVALID_ENVELOPE' };
  }
  const rp = envelope.route_plan;
  if (!rp.route || !rp.execution_class || typeof rp.requires_approval !== 'boolean' || !rp.reason) {
    return { ok: false, error: 'INVALID_ENVELOPE' };
  }

  // Route and execution class must match between packet and route_plan
  if (p.route !== rp.route || p.execution_class !== rp.execution_class) {
    return { ok: false, error: 'ROUTE_PLAN_PACKET_MISMATCH' };
  }

  // Origin validation
  if (!envelope.origin || envelope.origin.self !== 'ourself-agent-bridge') {
    return { ok: false, error: 'INVALID_ENVELOPE' };
  }
  if (!envelope.origin.source) {
    return { ok: false, error: 'INVALID_ENVELOPE' };
  }

  // Authority validation
  if (!envelope.authority || typeof envelope.authority !== 'object') {
    return { ok: false, error: 'INVALID_ENVELOPE' };
  }
  if (envelope.authority.state !== 'PENDING_HUMAN_TURN') {
    return { ok: false, error: 'AUTHORITY_STATE_INVALID' };
  }
  if (envelope.authority.human_turn_required !== true) {
    return { ok: false, error: 'HUMAN_TURN_REQUIRED' };
  }

  // Requested execution validation
  if (!envelope.requested_execution || typeof envelope.requested_execution !== 'object') {
    return { ok: false, error: 'INVALID_ENVELOPE' };
  }
  const re = envelope.requested_execution;
  if (!re.class || typeof re.mutation_requested !== 'boolean') {
    return { ok: false, error: 'INVALID_ENVELOPE' };
  }

  // Execution class must be recognized by the kernel registry
  if (!EXECUTION_CLASS_NAMES.includes(re.class)) {
    return { ok: false, error: 'UNKNOWN_EXECUTION_CLASS' };
  }

  // Execution class must not be non-terminal (forbidden, reverse_engineer)
  const execClass = EXECUTION_CLASSES[re.class];
  if (!execClass.terminal) {
    return { ok: false, error: 'UNKNOWN_EXECUTION_CLASS' };
  }

  // Expected evidence validation
  if (!Array.isArray(envelope.expected_evidence)) {
    return { ok: false, error: 'INVALID_ENVELOPE' };
  }
  for (const token of envelope.expected_evidence) {
    if (typeof token !== 'string' || !SAFE_TOKEN_REGEX.test(token)) {
      return { ok: false, error: 'UNSAFE_TOKEN' };
    }
  }

  // Semantic checksum validation
  if (!envelope.semantic_checksum || typeof envelope.semantic_checksum !== 'string') {
    return { ok: false, error: 'INVALID_ENVELOPE' };
  }
  const computed = computeSemanticChecksum(p, rp, re);
  if (envelope.semantic_checksum !== computed) {
    return { ok: false, error: 'SEMANTIC_CHECKSUM_INVALID' };
  }

  return { ok: true };
}

/**
 * Translate a valid envelope into a kernel proposal.
 * Assumes validateOurselfEnvelope has passed.
 * @param {object} envelope
 * @returns {object} kernel proposal object
 */
export function translateToKernelProposal(envelope) {
  const p = envelope.packet;
  const rp = envelope.route_plan;
  const re = envelope.requested_execution;

  return {
    id: p.packet_id,
    source: 'ourself-intake',
    origin: envelope.origin,
    kind: 'proposal',
    executionClass: re.class,
    mutation: re.mutation_requested,
    route: rp.route,
    reason: rp.reason,
    requiresApproval: rp.requires_approval,
    proof: rp.proof_required || [],
    evidence: envelope.expected_evidence,
    data: {
      packet: p,
      routePlan: rp,
      requestedExecution: re,
    },
    authority: {
      state: 'PENDING_HUMAN_TURN',
      human_turn_required: true,
    },
  };
}

/**
 * Main entry point: process an OURSELF intake envelope.
 * Validates, translates, and returns a deterministic response.
 * Never executes anything.
 * @param {object} envelope
 * @returns {object} { status, execution_performed, human_turn_required, proposal?, error? }
 */
export function processOurselfIntake(envelope) {
  const validation = validateOurselfEnvelope(envelope);
  if (!validation.ok) {
    return {
      status: 'REJECTED',
      execution_performed: false,
      human_turn_required: true,
      error: {
        code: validation.error,
        message: `Control plane envelope validation failed: ${validation.error}`,
      },
    };
  }

  let proposal;
  try {
    proposal = translateToKernelProposal(envelope);
  } catch (err) {
    return {
      status: 'REJECTED',
      execution_performed: false,
      human_turn_required: true,
      error: {
        code: 'INVALID_ENVELOPE',
        message: 'Failed to translate envelope to kernel proposal',
      },
    };
  }

  return {
    status: 'ACCEPTED_FOR_REVIEW',
    execution_performed: false,
    human_turn_required: true,
    proposal,
  };
}
