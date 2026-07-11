// test/proposal-execution.test.js
// ── T-032: Bounded Imported Proposal Execution — targeted proof suite ───────
// Every test uses its own isolated temp storageRoot and (where a process runs)
// its own isolated temp workspace OUTSIDE both live repositories. Numbers in
// comments map to the T-032 REQUIRED TARGETED TESTS list (1-58).
//
// Session-level items proven outside this file, per the T-031 precedent:
//   57 (no API route created — server.js untouched, verified by git status/diff)
//   58 (control plane not mutated — verified by git status in that repository)
// Items 21/23/27 are proven as layered law: the frozen operation registry
// cannot express a mutating/traversing/network operation (module denies any
// unregistered route/class pair), AND the sealed firewall is asserted directly
// to deny such shapes if one were ever presented.
//
// Class-convention note (diagnostic correction recorded in the gate report):
// the kernel's sealed law routes git commands to class git-read — policyInspect
// explicitly denies git under inspect. The mandated proof operation
// `git status --short` therefore runs under route/class git-read, and a real
// `ls` operation proves the inspect class (test 20).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile, readFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { persistPendingProposal, getPendingProposal, verifyEventLedger, eventsLedgerPath, computeRecordHash } from '../persistence/pending-proposals.js';
import {
  createStaticHumanTurnTokenVerifier,
  createHumanTurnDecisionService,
  DECISION_VERSION,
} from '../persistence/human-turn-decisions.js';
import {
  createBoundedProposalExecutor,
  getProposalExecutionState,
  verifyProposalExecution,
  getExecutionClaim,
  computeExecutionPlanHash,
  PROPOSAL_EXECUTION_ERRORS as ERRS,
  EXECUTION_PLAN_VERSION,
} from '../persistence/proposal-execution.js';
import { computeSemanticChecksum } from '../adapters/ourself-intake.js';
import { canonicalHash } from '../persistence/canonical-json.js';
import { enforceClassPolicy } from '../tools/command-firewall.js';
import { evaluateApproval } from '../tools/execution-classes.js';

const TOKEN = 'human-turn-t032-test-token-do-not-reuse';

// ── Fixtures (same shapes the T-030/T-031 suites established) ───────────────

async function withTempStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'ourself-proposal-execution-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function withTempWorkspace(fn, { gitInit = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ourself-t032-workspace-'));
  try {
    if (gitInit) {
      execFileSync('git', ['init', '--quiet'], { cwd: dir });
      await writeFile(join(dir, 'proof-untracked.txt'), 'untracked evidence\n');
    }
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function uniqueId(label = 't032') {
  return `packet-${label}-${randomBytes(4).toString('hex')}`;
}

function buildProposal({ packetId, executionClass = 'git-read', route = 'git-read', mutation = false, intent = 'show git status of the repo' }) {
  const packet = {
    packet_id: packetId, node: 'Milly', source: 'cli', route, sia: 'ClaudeCodeSELF',
    execution_class: executionClass, intent, target: null, status: 'planned',
    created: '2026-07-11T00:00:00.000Z', parent_aecho: null, mutation, requires_approval: true,
    proof_required: ['stdout'], reason: 'matched route heuristic',
  };
  const routePlan = {
    route, sia: 'ClaudeCodeSELF', execution_class: executionClass, mutation, requires_approval: true,
    proof_required: ['stdout'], reason: 'matched route heuristic', status: 'planned',
  };
  const requestedExecution = { class: executionClass, mutation_requested: mutation };
  const origin = { self: 'ourself-agent-bridge', source: 'local-handshake-runner' };
  return {
    id: packetId, source: 'ourself-intake', origin, kind: 'proposal', executionClass, mutation, route,
    reason: routePlan.reason, requiresApproval: true, proof: ['stdout'], evidence: [],
    data: { packet, routePlan, requestedExecution },
    authority: { state: 'PENDING_HUMAN_TURN', human_turn_required: true },
  };
}

function buildReviewResult(overrides = {}) {
  const packetId = overrides.packetId || uniqueId();
  const proposal = buildProposal({ packetId, ...overrides });
  return {
    protocol: 'ourself.ae-kernel.v1', status: 'ACCEPTED_FOR_REVIEW', execution_performed: false,
    human_turn_required: true, proposal,
  };
}

async function persistFresh(dir, overrides = {}) {
  const result = await persistPendingProposal(dir, buildReviewResult(overrides));
  assert.equal(result.ok, true, 'fixture persist must succeed');
  return result;
}

function decisionFor(record, { decision, decisionId, reason = 'Authorize isolated T-032 proof only.', constraints = [], decidedAt = '2026-07-11T00:05:00.000Z' } = {}) {
  const latestEvent = record.events[record.events.length - 1];
  return {
    decision_version: DECISION_VERSION,
    decision_id: decisionId || uniqueId('decision'),
    proposal_id: record.proposal_id,
    decision,
    decided_by: 'MYSELF',
    decided_at: decidedAt,
    proposal_integrity: {
      record_hash: record.integrity.record_hash,
      semantic_checksum: record.semantic_checksum,
      latest_event_hash: latestEvent.event_hash,
    },
    reason,
    constraints,
  };
}

async function decide(dir, record, decision) {
  const verifier = createStaticHumanTurnTokenVerifier({ proposalId: record.proposal_id, decision, expectedToken: TOKEN });
  const service = createHumanTurnDecisionService({ verifyHumanTurnAuthorization: verifier });
  const res = await service.recordHumanTurnDecision({
    storageRoot: dir,
    proposalId: record.proposal_id,
    decisionInput: decisionFor(record, { decision }),
    presentedToken: TOKEN,
  });
  assert.equal(res.ok, true, `fixture ${decision} must succeed: ${res.error || ''}`);
  return res;
}

/** Persist + AUTHORIZE through the real T-030/T-031 chain. */
async function persistedAuthorized(dir, overrides = {}) {
  const persisted = await persistFresh(dir, overrides);
  return decide(dir, persisted.record, 'AUTHORIZE');
}

function recordPath(dir, proposalId) {
  return join(dir, 'proposals', `${proposalId}.json`);
}

/**
 * Tamper with a persisted record while keeping every integrity hash
 * self-consistent, so exactly one targeted revalidation check trips.
 * Replicates the module's documented identity-binding formula.
 */
async function tamperConsistently(dir, proposalId, mutate, { refreshChecksum = true } = {}) {
  const path = recordPath(dir, proposalId);
  const record = JSON.parse(await readFile(path, 'utf8'));
  mutate(record);
  if (refreshChecksum) {
    record.semantic_checksum = computeSemanticChecksum(record.packet, record.route_plan, record.requested_execution);
  }
  record.integrity.identity_binding_hash = canonicalHash({
    protocol: record.protocol,
    semantic_checksum: record.semantic_checksum,
    proposal_id: record.packet.packet_id,
    route: record.packet.route,
    execution_class: record.packet.execution_class,
    origin_self: record.origin.self,
    origin_source: record.origin.source,
    packet_created: record.packet.created,
  });
  record.integrity.record_hash = computeRecordHash(record);
  await writeFile(path, JSON.stringify(record, null, 2));
  return record;
}

async function ledgerEvents(dir, proposalId = null) {
  const raw = await readFile(eventsLedgerPath(dir), 'utf8').catch(() => '');
  const events = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return proposalId ? events.filter((e) => e.proposal_id === proposalId) : events;
}

// ── Fake bounded-spawn implementations (trusted-construction test seam) ─────

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {
    child.emit('close', null, 'SIGKILL');
    return true;
  };
  return child;
}

function makeSpawnRecorder(behavior) {
  const calls = [];
  const spawnImpl = (cmd, args, opts) => {
    const child = fakeChild();
    calls.push({ cmd, args, opts });
    setImmediate(() => behavior(child, calls));
    return child;
  };
  spawnImpl.calls = calls;
  return spawnImpl;
}

const behaviorExitZero = (child) => {
  child.stdout.emit('data', Buffer.from('fake ok\n'));
  child.emit('close', 0, null);
};
const behaviorNeverExit = () => { /* only the timeout SIGKILL ends it */ };
const behaviorSpawnError = (child) => {
  child.emit('error', new Error('spawn git ENOENT (simulated)'));
};
const behaviorHugeOutput = (child) => {
  child.stdout.emit('data', Buffer.alloc(200 * 1024, 0x61));
  child.stderr.emit('data', Buffer.alloc(200 * 1024, 0x62));
  child.emit('close', 0, null);
};
const behaviorSlowExit = (child) => {
  setTimeout(() => {
    child.stdout.emit('data', Buffer.from('slow ok\n'));
    child.emit('close', 0, null);
  }, 100);
};

function executorFor(root, opts = {}) {
  return createBoundedProposalExecutor({ authorizedExecutionRoot: root, ...opts });
}

// ═════════════════════════════ Authority and integrity (1-11) ═══════════════

test('1. an authorized proposal may execute', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const authorized = await persistedAuthorized(dir);
      const spawnImpl = makeSpawnRecorder(behaviorExitZero);
      const { executeAuthorizedProposal } = executorFor(ws, { spawnImpl });
      const res = await executeAuthorizedProposal({ storageRoot: dir, proposalId: authorized.proposal_id });
      assert.equal(res.ok, true, res.message);
      assert.equal(res.executed, true);
      assert.equal(res.outcome, 'EXECUTION_COMPLETED');
      assert.equal(spawnImpl.calls.length, 1);
    }, { gitInit: false });
  });
});

test('2. a pending (undecided) proposal cannot execute', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const persisted = await persistFresh(dir);
      const spawnImpl = makeSpawnRecorder(behaviorExitZero);
      const { executeAuthorizedProposal } = executorFor(ws, { spawnImpl });
      const res = await executeAuthorizedProposal({ storageRoot: dir, proposalId: persisted.proposal_id });
      assert.equal(res.ok, false);
      assert.equal(res.error, ERRS.PROPOSAL_NOT_AUTHORIZED);
      assert.equal(spawnImpl.calls.length, 0);
    }, { gitInit: false });
  });
});

test('3/55. a rejected proposal can never execute', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const persisted = await persistFresh(dir);
      await decide(dir, persisted.record, 'REJECT');
      const spawnImpl = makeSpawnRecorder(behaviorExitZero);
      const { executeAuthorizedProposal } = executorFor(ws, { spawnImpl });
      const res = await executeAuthorizedProposal({ storageRoot: dir, proposalId: persisted.proposal_id });
      assert.equal(res.ok, false);
      assert.equal(res.error, ERRS.PROPOSAL_REJECTED);
      assert.equal(spawnImpl.calls.length, 0);
    }, { gitInit: false });
  });
});

test('4. a missing proposal cannot execute', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const { executeAuthorizedProposal } = executorFor(ws, { spawnImpl: makeSpawnRecorder(behaviorExitZero) });
      const res = await executeAuthorizedProposal({ storageRoot: dir, proposalId: 'packet-does-not-exist' });
      assert.equal(res.ok, false);
      assert.equal(res.error, ERRS.PROPOSAL_NOT_FOUND);
    }, { gitInit: false });
  });
});

test('5. a corrupted proposal record cannot execute', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const authorized = await persistedAuthorized(dir);
      // Raw tamper WITHOUT rehashing — record hash must now mismatch.
      const path = recordPath(dir, authorized.proposal_id);
      const record = JSON.parse(await readFile(path, 'utf8'));
      record.origin.self = 'attacker-self';
      await writeFile(path, JSON.stringify(record, null, 2));
      const spawnImpl = makeSpawnRecorder(behaviorExitZero);
      const { executeAuthorizedProposal } = executorFor(ws, { spawnImpl });
      const res = await executeAuthorizedProposal({ storageRoot: dir, proposalId: authorized.proposal_id });
      assert.equal(res.ok, false);
      assert.equal(res.error, ERRS.PROPOSAL_INTEGRITY_FAILURE);
      assert.equal(spawnImpl.calls.length, 0);
    }, { gitInit: false });
  });
});

test('6. a corrupted event ledger cannot execute', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const authorized = await persistedAuthorized(dir);
      const ledger = eventsLedgerPath(dir);
      const lines = (await readFile(ledger, 'utf8')).split('\n').filter(Boolean);
      const tampered = JSON.parse(lines[0]);
      tampered.at = '1999-01-01T00:00:00.000Z';
      lines[0] = JSON.stringify(tampered);
      await writeFile(ledger, lines.join('\n') + '\n');
      const spawnImpl = makeSpawnRecorder(behaviorExitZero);
      const { executeAuthorizedProposal } = executorFor(ws, { spawnImpl });
      const res = await executeAuthorizedProposal({ storageRoot: dir, proposalId: authorized.proposal_id });
      assert.equal(res.ok, false);
      assert.equal(res.error, ERRS.EVENT_LEDGER_INTEGRITY_FAILURE);
      assert.equal(spawnImpl.calls.length, 0);
    }, { gitInit: false });
  });
});

test('7. invalid decision integrity cannot execute', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const authorized = await persistedAuthorized(dir);
      await tamperConsistently(dir, authorized.proposal_id, (r) => {
        delete r.authority.verification; // authorization without a verification receipt
      });
      const spawnImpl = makeSpawnRecorder(behaviorExitZero);
      const { executeAuthorizedProposal } = executorFor(ws, { spawnImpl });
      const res = await executeAuthorizedProposal({ storageRoot: dir, proposalId: authorized.proposal_id });
      assert.equal(res.ok, false);
      assert.equal(res.error, ERRS.DECISION_INTEGRITY_FAILURE);
      assert.equal(spawnImpl.calls.length, 0);
    }, { gitInit: false });
  });
});

test('8. semantic-checksum drift cannot execute', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const authorized = await persistedAuthorized(dir);
      await tamperConsistently(dir, authorized.proposal_id, (r) => {
        r.semantic_checksum = 'f'.repeat(64); // drifted stored checksum
      }, { refreshChecksum: false });
      const spawnImpl = makeSpawnRecorder(behaviorExitZero);
      const { executeAuthorizedProposal } = executorFor(ws, { spawnImpl });
      const res = await executeAuthorizedProposal({ storageRoot: dir, proposalId: authorized.proposal_id });
      assert.equal(res.ok, false);
      assert.equal(res.error, ERRS.SEMANTIC_CHECKSUM_MISMATCH);
      assert.equal(spawnImpl.calls.length, 0);
    }, { gitInit: false });
  });
});

test('9. authorization-event mismatch cannot execute', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const authorized = await persistedAuthorized(dir);
      await tamperConsistently(dir, authorized.proposal_id, (r) => {
        r.events.push({ ...r.events[0], type: 'PROPOSAL_PERSISTED' }); // latest event no longer PROPOSAL_AUTHORIZED
      });
      const spawnImpl = makeSpawnRecorder(behaviorExitZero);
      const { executeAuthorizedProposal } = executorFor(ws, { spawnImpl });
      const res = await executeAuthorizedProposal({ storageRoot: dir, proposalId: authorized.proposal_id });
      assert.equal(res.ok, false);
      assert.equal(res.error, ERRS.AUTHORIZATION_EVENT_MISMATCH);
      assert.equal(spawnImpl.calls.length, 0);
    }, { gitInit: false });
  });
});

test('10. an unknown execution class cannot execute (and non-terminal is unknown to the executor)', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const authorized = await persistedAuthorized(dir);
      await tamperConsistently(dir, authorized.proposal_id, (r) => {
        r.packet.execution_class = 'warp-drive';
        r.route_plan.execution_class = 'warp-drive';
        r.requested_execution.class = 'warp-drive';
      });
      const spawnImpl = makeSpawnRecorder(behaviorExitZero);
      const { executeAuthorizedProposal } = executorFor(ws, { spawnImpl });
      const res = await executeAuthorizedProposal({ storageRoot: dir, proposalId: authorized.proposal_id });
      assert.equal(res.ok, false);
      assert.equal(res.error, ERRS.UNKNOWN_EXECUTION_CLASS);

      const authorized2 = await persistedAuthorized(dir, { packetId: uniqueId('nonterminal') });
      await tamperConsistently(dir, authorized2.proposal_id, (r) => {
        r.packet.execution_class = 'reverse_engineer';
        r.route_plan.execution_class = 'reverse_engineer';
        r.requested_execution.class = 'reverse_engineer';
      });
      const res2 = await executeAuthorizedProposal({ storageRoot: dir, proposalId: authorized2.proposal_id });
      assert.equal(res2.ok, false);
      assert.equal(res2.error, ERRS.UNKNOWN_EXECUTION_CLASS);
      assert.equal(spawnImpl.calls.length, 0);
    }, { gitInit: false });
  });
});

test('11. an execution-class mismatch cannot execute', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const authorized = await persistedAuthorized(dir);
      await tamperConsistently(dir, authorized.proposal_id, (r) => {
        r.requested_execution.class = 'test'; // disagree with packet/route plan
      });
      const spawnImpl = makeSpawnRecorder(behaviorExitZero);
      const { executeAuthorizedProposal } = executorFor(ws, { spawnImpl });
      const res = await executeAuthorizedProposal({ storageRoot: dir, proposalId: authorized.proposal_id });
      assert.equal(res.ok, false);
      assert.equal(res.error, ERRS.EXECUTION_CLASS_MISMATCH);
      assert.equal(spawnImpl.calls.length, 0);
    }, { gitInit: false });
  });
});

// ═════════════════════════════ Plan derivation (12-19) ══════════════════════

test('12. the plan derives deterministically from persisted authorized state', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const authorized = await persistedAuthorized(dir);
      const { executeAuthorizedProposal } = executorFor(ws, { spawnImpl: makeSpawnRecorder(behaviorExitZero) });
      const res = await executeAuthorizedProposal({ storageRoot: dir, proposalId: authorized.proposal_id });
      assert.equal(res.ok, true);
      assert.equal(res.plan.plan_version, EXECUTION_PLAN_VERSION);
      assert.equal(res.plan.executable, 'git');
      assert.deepEqual(res.plan.argv, ['status', '--short']);
      assert.equal(res.plan.display_command, 'git status --short');
      assert.equal(res.plan.execution_id, `exec-${authorized.proposal_id}`);
      assert.equal(res.plan.semantic_checksum, res.record.semantic_checksum);
      assert.equal(computeExecutionPlanHash(res.plan), res.plan.plan_hash);
    }, { gitInit: false });
  });
});

test('13-17. no caller field can override executable, argv, cwd, class, timeout, or environment', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const authorized = await persistedAuthorized(dir);
      const spawnImpl = makeSpawnRecorder(behaviorExitZero);
      const { executeAuthorizedProposal } = executorFor(ws, { spawnImpl });
      const overrides = [
        { command: 'rm -rf /' },                    // 13 executable/command
        { argv: ['push', 'origin', 'main'] },        // 14 argv
        { executable: '/tmp/evil' },                 // 13 executable
        { cwd: '/' },                                // 15 cwd
        { execution_class: 'project-mutation' },     // 16 class
        { timeoutMs: 999999 },                       // 17 timeout
        { env: { PATH: '/tmp/evil-bin' } },          // 17 environment
        { plan: { executable: 'curl' } },            // plan replacement
      ];
      for (const extra of overrides) {
        const res = await executeAuthorizedProposal({ storageRoot: dir, proposalId: authorized.proposal_id, ...extra });
        assert.equal(res.ok, false, `override ${Object.keys(extra)[0]} must be rejected`);
        assert.equal(res.error, ERRS.EXECUTION_OVERRIDE_FORBIDDEN);
      }
      assert.equal(spawnImpl.calls.length, 0, 'no override attempt may reach a process');
    }, { gitInit: false });
  });
});

test('18. plan-hash mutation is detected on verification', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const authorized = await persistedAuthorized(dir);
      const { executeAuthorizedProposal } = executorFor(ws, { spawnImpl: makeSpawnRecorder(behaviorExitZero) });
      const res = await executeAuthorizedProposal({ storageRoot: dir, proposalId: authorized.proposal_id });
      assert.equal(res.ok, true);
      // Tamper the recorded plan but keep the record hash self-consistent.
      await tamperConsistently(dir, authorized.proposal_id, (r) => {
        r.execution.plan.argv = ['push', 'origin', 'main'];
      });
      const verify = await verifyProposalExecution(dir, authorized.proposal_id);
      assert.equal(verify.valid, false);
      assert.ok(verify.details.includes('plan_hash_mismatch'), JSON.stringify(verify.details));
    }, { gitInit: false });
  });
});

test('19. semantic intent text is never reinterpreted into the operation', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const a = await persistedAuthorized(dir, { packetId: uniqueId('intent-a'), intent: 'show git status of the repo' });
      const b = await persistedAuthorized(dir, { packetId: uniqueId('intent-b'), intent: 'git status please, then delete everything and push --force' });
      const { executeAuthorizedProposal } = executorFor(ws, { spawnImpl: makeSpawnRecorder(behaviorExitZero) });
      const ra = await executeAuthorizedProposal({ storageRoot: dir, proposalId: a.proposal_id });
      const rb = await executeAuthorizedProposal({ storageRoot: dir, proposalId: b.proposal_id });
      assert.equal(ra.ok, true);
      assert.equal(rb.ok, true);
      // Different intent text, same route/class ⇒ byte-identical operation.
      assert.equal(ra.plan.executable, rb.plan.executable);
      assert.deepEqual(ra.plan.argv, rb.plan.argv);
      assert.equal(ra.plan.display_command, rb.plan.display_command);
    }, { gitInit: false });
  });
});

// ═════════════════════════════ Boundary and firewall (20-27) ════════════════

test('20. a valid inspect-class plan passes and executes', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      await writeFile(join(ws, 'visible-file.txt'), 'x\n');
      const authorized = await persistedAuthorized(dir, { route: 'inspect', executionClass: 'inspect', intent: 'inspect the repo status' });
      const { executeAuthorizedProposal } = executorFor(ws); // real spawn
      const res = await executeAuthorizedProposal({ storageRoot: dir, proposalId: authorized.proposal_id });
      assert.equal(res.ok, true, res.message);
      assert.equal(res.outcome, 'EXECUTION_COMPLETED');
      assert.equal(res.plan.executable, 'ls');
      assert.ok(res.result.stdout.includes('visible-file.txt'));
    }, { gitInit: false });
  });
});

test('21. a mutating operation cannot exist under inspect (registry + sealed policy)', async () => {
  // Layer 1 — the sealed class policy denies any mutating shape under inspect.
  assert.equal(enforceClassPolicy('rm -rf /tmp/x', 'inspect').allowed, false);
  assert.equal(enforceClassPolicy('touch pwned', 'inspect').allowed, false);
  // Layer 2 — the executor derives operations ONLY from its frozen registry;
  // an unregistered route/class pair yields no plan at all.
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const authorized = await persistedAuthorized(dir, { route: 'test', executionClass: 'test', intent: 'run the tests' });
      const spawnImpl = makeSpawnRecorder(behaviorExitZero);
      const { executeAuthorizedProposal } = executorFor(ws, { spawnImpl });
      const res = await executeAuthorizedProposal({ storageRoot: dir, proposalId: authorized.proposal_id });
      assert.equal(res.ok, false);
      assert.equal(res.error, ERRS.INVALID_EXECUTION_PLAN);
      assert.equal(spawnImpl.calls.length, 0);
    }, { gitInit: false });
  });
});

test('22. shell metacharacters remain inert argv — no shell exists', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      // A filename full of metacharacters: with shell:false + fixed argv it is
      // just untracked data in git's stdout, never an executed word.
      await writeFile(join(ws, 'x;echo INJECTED'), 'inert\n');
      const authorized = await persistedAuthorized(dir);
      const { executeAuthorizedProposal } = executorFor(ws); // real spawn
      const res = await executeAuthorizedProposal({ storageRoot: dir, proposalId: authorized.proposal_id });
      assert.equal(res.ok, true, res.message);
      assert.equal(res.outcome, 'EXECUTION_COMPLETED');
      assert.ok(res.result.stdout.includes('x;echo INJECTED'), 'metacharacter filename is data, not code');
      const after = execFileSync('ls', [], { cwd: ws }).toString();
      assert.ok(!after.split('\n').includes('INJECTED'), 'no injected side effect may exist');
    });
  });
});

test('23. path traversal is denied by the sealed law the executor revalidates with', async () => {
  // Traversal is enforced by the live classifier layer (evaluateApproval →
  // classifyCommand → forbidden), which the executor invokes on every plan.
  assert.equal(evaluateApproval('inspect', 'cat ../../etc/passwd').ok, false);
  const traversal = evaluateApproval('git-read', 'git status --short ../../..');
  assert.equal(traversal.ok, false, 'live re-classification must fail closed on traversal');
  // The registry itself contains no path argument at all:
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const authorized = await persistedAuthorized(dir);
      const { executeAuthorizedProposal } = executorFor(ws, { spawnImpl: makeSpawnRecorder(behaviorExitZero) });
      const res = await executeAuthorizedProposal({ storageRoot: dir, proposalId: authorized.proposal_id });
      assert.equal(res.ok, true);
      for (const arg of res.plan.argv) assert.ok(!arg.includes('..') && !arg.startsWith('/'));
    }, { gitInit: false });
  });
});

test('24. a working directory outside the authorized root is denied', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      await withTempWorkspace(async (outside) => {
        const authorized = await persistedAuthorized(dir);
        const spawnImpl = makeSpawnRecorder(behaviorExitZero);
        const { executeAuthorizedProposal } = createBoundedProposalExecutor({
          authorizedExecutionRoot: ws,
          workingDirectory: outside, // trusted-construction mistake — still refused
          spawnImpl,
        });
        const res = await executeAuthorizedProposal({ storageRoot: dir, proposalId: authorized.proposal_id });
        assert.equal(res.ok, false);
        assert.equal(res.error, ERRS.CWD_BOUNDARY_VIOLATION);
        assert.equal(spawnImpl.calls.length, 0);
      }, { gitInit: false });
    }, { gitInit: false });
  });
});

test('25. a symlink escape of the working directory is denied', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      await withTempWorkspace(async (outside) => {
        const authorized = await persistedAuthorized(dir);
        const linkPath = join(ws, 'escape');
        await symlink(outside, linkPath);
        const spawnImpl = makeSpawnRecorder(behaviorExitZero);
        const { executeAuthorizedProposal } = createBoundedProposalExecutor({
          authorizedExecutionRoot: ws,
          workingDirectory: linkPath, // inside the root textually, escapes via symlink
          spawnImpl,
        });
        const res = await executeAuthorizedProposal({ storageRoot: dir, proposalId: authorized.proposal_id });
        assert.equal(res.ok, false);
        assert.equal(res.error, ERRS.CWD_SYMLINK_VIOLATION);
        assert.equal(spawnImpl.calls.length, 0);
      }, { gitInit: false });
    }, { gitInit: false });
  });
});

test('26. the process environment is bounded and never inherited', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      process.env.OURSELF_T032_CANARY = 'must-not-leak';
      try {
        const authorized = await persistedAuthorized(dir);
        const spawnImpl = makeSpawnRecorder(behaviorExitZero);
        const { executeAuthorizedProposal } = executorFor(ws, { spawnImpl });
        const res = await executeAuthorizedProposal({ storageRoot: dir, proposalId: authorized.proposal_id });
        assert.equal(res.ok, true);
        const env = spawnImpl.calls[0].opts.env;
        assert.deepEqual(Object.keys(env).sort(), ['LC_ALL', 'PATH']);
        assert.equal(env.OURSELF_T032_CANARY, undefined);
        assert.equal(env.HOME, undefined);
      } finally {
        delete process.env.OURSELF_T032_CANARY;
      }
    }, { gitInit: false });
  });
});

test('27. no network operation can be derived or would pass revalidation', async () => {
  // The frozen registry holds exactly two local read operations.
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const authorized = await persistedAuthorized(dir);
      const { executeAuthorizedProposal } = executorFor(ws, { spawnImpl: makeSpawnRecorder(behaviorExitZero) });
      const res = await executeAuthorizedProposal({ storageRoot: dir, proposalId: authorized.proposal_id });
      assert.ok(['git', 'ls'].includes(res.plan.executable));
    }, { gitInit: false });
  });
  // And the sealed law denies network shapes for both registered classes —
  // network git is caught by the class policy and the live classifier, not by
  // the generic denylist; the executor invokes all three layers.
  assert.equal(enforceClassPolicy('curl http://example.com', 'inspect').allowed, false);
  assert.equal(enforceClassPolicy('git push origin main', 'git-read').allowed, false);
  assert.equal(evaluateApproval('git-read', 'git push origin main').ok, false);
});

// ═════════════════════════════ Execution lifecycle (28-38) ══════════════════

test('28/30. a real isolated git-read operation executes exactly once and completes', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const authorized = await persistedAuthorized(dir);
      const { executeAuthorizedProposal } = executorFor(ws); // real spawn, real git
      const res = await executeAuthorizedProposal({ storageRoot: dir, proposalId: authorized.proposal_id });
      assert.equal(res.ok, true, res.message);
      assert.equal(res.outcome, 'EXECUTION_COMPLETED');
      assert.equal(res.result.exit_code, 0);
      assert.ok(res.result.stdout.includes('?? proof-untracked.txt'), `stdout was: ${res.result.stdout}`);
      const events = await ledgerEvents(dir, authorized.proposal_id);
      assert.equal(events.filter((e) => e.type === 'EXECUTION_STARTED').length, 1);
      assert.equal(events.filter((e) => e.type === 'EXECUTION_COMPLETED').length, 1);
    });
  });
});

test('29. EXECUTION_STARTED is durable before process invocation', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const authorized = await persistedAuthorized(dir);
      let stateAtSpawn = null;
      let ledgerTypesAtSpawn = null;
      const spawnImpl = (cmd, args, opts) => {
        const rec = JSON.parse(readFileSync(recordPath(dir, authorized.proposal_id), 'utf8'));
        stateAtSpawn = rec.state;
        ledgerTypesAtSpawn = readFileSync(eventsLedgerPath(dir), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).type);
        const child = fakeChild();
        setImmediate(() => behaviorExitZero(child));
        return child;
      };
      const { executeAuthorizedProposal } = executorFor(ws, { spawnImpl });
      const res = await executeAuthorizedProposal({ storageRoot: dir, proposalId: authorized.proposal_id });
      assert.equal(res.ok, true);
      assert.equal(stateAtSpawn, 'EXECUTION_STARTED', 'record must be durably STARTED before spawn');
      assert.ok(ledgerTypesAtSpawn.includes('EXECUTION_STARTED'), 'ledger must carry EXECUTION_STARTED before spawn');
    }, { gitInit: false });
  });
});

test('31. a nonzero exit creates EXECUTION_FAILED (real process, non-git workspace)', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const authorized = await persistedAuthorized(dir);
      const { executeAuthorizedProposal } = executorFor(ws); // real git, but ws is NOT a repository
      const res = await executeAuthorizedProposal({ storageRoot: dir, proposalId: authorized.proposal_id });
      assert.equal(res.ok, true, res.message);
      assert.equal(res.outcome, 'EXECUTION_FAILED');
      assert.equal(res.failure_code, ERRS.EXECUTION_NONZERO_EXIT);
      assert.notEqual(res.result.exit_code, 0);
      assert.ok(res.result.stderr.toLowerCase().includes('not a git repository'), `stderr was: ${res.result.stderr}`);
    }, { gitInit: false });
  });
});

test('32. a spawn failure creates EXECUTION_FAILED with EXECUTION_SPAWN_FAILED', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const authorized = await persistedAuthorized(dir);
      const { executeAuthorizedProposal } = executorFor(ws, { spawnImpl: makeSpawnRecorder(behaviorSpawnError) });
      const res = await executeAuthorizedProposal({ storageRoot: dir, proposalId: authorized.proposal_id });
      assert.equal(res.ok, true);
      assert.equal(res.outcome, 'EXECUTION_FAILED');
      assert.equal(res.failure_code, ERRS.EXECUTION_SPAWN_FAILED);
      assert.ok(res.result.spawn_error.includes('ENOENT'));
    }, { gitInit: false });
  });
});

test('33. a timeout terminates the process and creates EXECUTION_FAILED', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const authorized = await persistedAuthorized(dir);
      const { executeAuthorizedProposal } = executorFor(ws, { spawnImpl: makeSpawnRecorder(behaviorNeverExit), timeoutMs: 50 });
      const res = await executeAuthorizedProposal({ storageRoot: dir, proposalId: authorized.proposal_id });
      assert.equal(res.ok, true);
      assert.equal(res.outcome, 'EXECUTION_FAILED');
      assert.equal(res.failure_code, ERRS.EXECUTION_TIMEOUT);
      assert.equal(res.result.timed_out, true);
      assert.equal(res.result.signal, 'SIGKILL');
    }, { gitInit: false });
  });
});

test('34/35. stdout and stderr are bounded with correct truncation flags', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const authorized = await persistedAuthorized(dir);
      const limit = 1024;
      const { executeAuthorizedProposal } = executorFor(ws, { spawnImpl: makeSpawnRecorder(behaviorHugeOutput), maxOutputBytes: limit });
      const res = await executeAuthorizedProposal({ storageRoot: dir, proposalId: authorized.proposal_id });
      assert.equal(res.ok, true);
      assert.ok(Buffer.byteLength(res.result.stdout, 'utf8') <= limit);
      assert.ok(Buffer.byteLength(res.result.stderr, 'utf8') <= limit);
      assert.equal(res.result.stdout_truncated, true);
      assert.equal(res.result.stderr_truncated, true);

      // And an untruncated run reports false flags.
      const authorized2 = await persistedAuthorized(dir, { packetId: uniqueId('small') });
      const { executeAuthorizedProposal: exec2 } = executorFor(ws, { spawnImpl: makeSpawnRecorder(behaviorExitZero), maxOutputBytes: limit });
      const res2 = await exec2({ storageRoot: dir, proposalId: authorized2.proposal_id });
      assert.equal(res2.result.stdout_truncated, false);
      assert.equal(res2.result.stderr_truncated, false);
    }, { gitInit: false });
  });
});

test('36. the process gets no stdin and no shell', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const authorized = await persistedAuthorized(dir);
      const spawnImpl = makeSpawnRecorder(behaviorExitZero);
      const { executeAuthorizedProposal } = executorFor(ws, { spawnImpl });
      await executeAuthorizedProposal({ storageRoot: dir, proposalId: authorized.proposal_id });
      const { opts, args, cmd } = spawnImpl.calls[0];
      assert.equal(opts.shell, false);
      assert.equal(opts.stdio[0], 'ignore');
      assert.equal(cmd, 'git');
      assert.ok(Array.isArray(args));
    }, { gitInit: false });
  });
});

test('37/38. the proposal body and the HUMAN-TURN decision survive execution unchanged', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const authorized = await persistedAuthorized(dir);
      const before = authorized.record;
      const { executeAuthorizedProposal } = executorFor(ws, { spawnImpl: makeSpawnRecorder(behaviorExitZero) });
      const res = await executeAuthorizedProposal({ storageRoot: dir, proposalId: authorized.proposal_id });
      assert.equal(res.ok, true);
      const after = (await getPendingProposal(dir, authorized.proposal_id)).record;
      assert.deepEqual(after.packet, before.packet);
      assert.deepEqual(after.route_plan, before.route_plan);
      assert.deepEqual(after.requested_execution, before.requested_execution);
      assert.deepEqual(after.origin, before.origin);
      assert.deepEqual(after.authority, before.authority);
      assert.equal(after.semantic_checksum, before.semantic_checksum);
    }, { gitInit: false });
  });
});

// ═════════════════════════ Idempotency and concurrency (39-44) ══════════════

test('39/43/44. a completed repeat does not rerun and cannot duplicate events', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const authorized = await persistedAuthorized(dir);
      const spawnImpl = makeSpawnRecorder(behaviorExitZero);
      const { executeAuthorizedProposal } = executorFor(ws, { spawnImpl });
      const first = await executeAuthorizedProposal({ storageRoot: dir, proposalId: authorized.proposal_id });
      assert.equal(first.ok, true);
      const eventsAfterFirst = (await ledgerEvents(dir, authorized.proposal_id)).length;

      const repeat = await executeAuthorizedProposal({ storageRoot: dir, proposalId: authorized.proposal_id });
      assert.equal(repeat.ok, true);
      assert.equal(repeat.idempotent, true);
      assert.equal(repeat.code, ERRS.EXECUTION_ALREADY_COMPLETED);
      assert.equal(repeat.state, 'EXECUTION_COMPLETED');
      assert.equal(spawnImpl.calls.length, 1, 'the process must not run again');

      const events = await ledgerEvents(dir, authorized.proposal_id);
      assert.equal(events.length, eventsAfterFirst, 'no new event on repeat');
      assert.equal(events.filter((e) => e.type === 'EXECUTION_STARTED').length, 1);
      assert.equal(events.filter((e) => e.type === 'EXECUTION_COMPLETED').length, 1);
    }, { gitInit: false });
  });
});

test('40. a failed repeat returns the recorded failure without rerunning', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const authorized = await persistedAuthorized(dir);
      const spawnImpl = makeSpawnRecorder(behaviorSpawnError);
      const { executeAuthorizedProposal } = executorFor(ws, { spawnImpl });
      const first = await executeAuthorizedProposal({ storageRoot: dir, proposalId: authorized.proposal_id });
      assert.equal(first.outcome, 'EXECUTION_FAILED');

      const repeat = await executeAuthorizedProposal({ storageRoot: dir, proposalId: authorized.proposal_id });
      assert.equal(repeat.ok, true);
      assert.equal(repeat.idempotent, true);
      assert.equal(repeat.state, 'EXECUTION_FAILED');
      assert.equal(repeat.failure_code, ERRS.EXECUTION_SPAWN_FAILED);
      assert.equal(spawnImpl.calls.length, 1, 'a failed execution must never auto-retry');
    }, { gitInit: false });
  });
});

test('41/42. two concurrent callers produce exactly one process; the loser gets a deterministic conflict', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const authorized = await persistedAuthorized(dir);
      const spawnImpl = makeSpawnRecorder(behaviorSlowExit);
      const { executeAuthorizedProposal } = executorFor(ws, { spawnImpl });
      const [a, b] = await Promise.all([
        executeAuthorizedProposal({ storageRoot: dir, proposalId: authorized.proposal_id }),
        executeAuthorizedProposal({ storageRoot: dir, proposalId: authorized.proposal_id }),
      ]);
      assert.equal(spawnImpl.calls.length, 1, 'exactly one process invocation');
      const winner = [a, b].find((r) => r.ok === true && r.executed === true);
      const loser = [a, b].find((r) => r !== winner);
      assert.ok(winner, 'exactly one caller must win the claim');
      assert.equal(winner.outcome, 'EXECUTION_COMPLETED');
      assert.equal(loser.ok, false);
      assert.equal(loser.error, ERRS.CONCURRENT_EXECUTION_CONFLICT);
      const events = await ledgerEvents(dir, authorized.proposal_id);
      assert.equal(events.filter((e) => e.type === 'EXECUTION_STARTED').length, 1, 'duplicate started event impossible');
      assert.equal(events.filter((e) => e.type === 'EXECUTION_COMPLETED' || e.type === 'EXECUTION_FAILED').length, 1, 'duplicate terminal event impossible');
    }, { gitInit: false });
  });
});

// ═════════════════════════ Integrity and recovery (45-52) ═══════════════════

test('45/46. execution plan and result integrity verify after a fresh read', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const authorized = await persistedAuthorized(dir);
      const { executeAuthorizedProposal } = executorFor(ws); // real
      const res = await executeAuthorizedProposal({ storageRoot: dir, proposalId: authorized.proposal_id });
      assert.equal(res.ok, true);
      const verify = await verifyProposalExecution(dir, authorized.proposal_id);
      assert.equal(verify.valid, true, JSON.stringify(verify.details || []));
      assert.equal(verify.executed, true);
    });
  });
});

test('47. execution-result tampering is detected', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const authorized = await persistedAuthorized(dir);
      const { executeAuthorizedProposal } = executorFor(ws, { spawnImpl: makeSpawnRecorder(behaviorExitZero) });
      await executeAuthorizedProposal({ storageRoot: dir, proposalId: authorized.proposal_id });
      await tamperConsistently(dir, authorized.proposal_id, (r) => {
        r.execution.result.stdout = 'forged output claiming success';
      });
      const verify = await verifyProposalExecution(dir, authorized.proposal_id);
      assert.equal(verify.valid, false);
      assert.ok(verify.details.includes('result_hash_mismatch'), JSON.stringify(verify.details));
    }, { gitInit: false });
  });
});

test('48. event reordering is detected by the ledger chain', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const authorized = await persistedAuthorized(dir);
      const { executeAuthorizedProposal } = executorFor(ws, { spawnImpl: makeSpawnRecorder(behaviorExitZero) });
      await executeAuthorizedProposal({ storageRoot: dir, proposalId: authorized.proposal_id });
      const ledger = eventsLedgerPath(dir);
      const lines = (await readFile(ledger, 'utf8')).split('\n').filter(Boolean);
      assert.ok(lines.length >= 3);
      [lines[0], lines[1]] = [lines[1], lines[0]];
      await writeFile(ledger, lines.join('\n') + '\n');
      const verdict = await verifyEventLedger(dir);
      assert.equal(verdict.valid, false);
    }, { gitInit: false });
  });
});

test('49. a previous-hash mismatch is detected', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const authorized = await persistedAuthorized(dir);
      const { executeAuthorizedProposal } = executorFor(ws, { spawnImpl: makeSpawnRecorder(behaviorExitZero) });
      await executeAuthorizedProposal({ storageRoot: dir, proposalId: authorized.proposal_id });
      const ledger = eventsLedgerPath(dir);
      const lines = (await readFile(ledger, 'utf8')).split('\n').filter(Boolean);
      const last = JSON.parse(lines[lines.length - 1]);
      last.previous_event_hash = 'a'.repeat(64);
      lines[lines.length - 1] = JSON.stringify(last);
      await writeFile(ledger, lines.join('\n') + '\n');
      const verdict = await verifyEventLedger(dir);
      assert.equal(verdict.valid, false);
    }, { gitInit: false });
  });
});

test('50. a fresh read reconstructs the completed state', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const authorized = await persistedAuthorized(dir);
      const { executeAuthorizedProposal } = executorFor(ws); // real
      await executeAuthorizedProposal({ storageRoot: dir, proposalId: authorized.proposal_id });
      const state = await getProposalExecutionState(dir, authorized.proposal_id);
      assert.equal(state.state, 'EXECUTION_COMPLETED');
      assert.equal(state.execution_status, 'COMPLETED');
      assert.equal(state.failure_code, null);
      assert.ok(state.record.execution.result.stdout.includes('proof-untracked.txt'));
    });
  });
});

test('51. a fresh read reconstructs the failed state', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const authorized = await persistedAuthorized(dir);
      const { executeAuthorizedProposal } = executorFor(ws); // real git, non-git ws
      await executeAuthorizedProposal({ storageRoot: dir, proposalId: authorized.proposal_id });
      const state = await getProposalExecutionState(dir, authorized.proposal_id);
      assert.equal(state.state, 'EXECUTION_FAILED');
      assert.equal(state.execution_status, 'FAILED');
      assert.equal(state.failure_code, ERRS.EXECUTION_NONZERO_EXIT);
      const verify = await verifyProposalExecution(dir, authorized.proposal_id);
      assert.equal(verify.valid, true, JSON.stringify(verify.details || []));
    }, { gitInit: false });
  });
});

test('52. recovery does not auto-retry: an in-flight or claimed proposal is refused', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      // Simulated crash AFTER the durable EXECUTION_STARTED write.
      const authorized = await persistedAuthorized(dir);
      await tamperConsistently(dir, authorized.proposal_id, (r) => {
        r.state = 'EXECUTION_STARTED';
        r.execution = { execution_version: EXECUTION_PLAN_VERSION, execution_id: `exec-${r.proposal_id}`, status: 'STARTED', started_at: '2026-07-11T00:10:00.000Z', plan: null, result: null, result_hash: null };
      });
      const spawnImpl = makeSpawnRecorder(behaviorExitZero);
      const { executeAuthorizedProposal } = executorFor(ws, { spawnImpl });
      const res = await executeAuthorizedProposal({ storageRoot: dir, proposalId: authorized.proposal_id });
      assert.equal(res.ok, false);
      assert.equal(res.error, ERRS.EXECUTION_ALREADY_STARTED);
      assert.equal(spawnImpl.calls.length, 0);

      // Simulated crash AFTER the claim but BEFORE EXECUTION_STARTED.
      const authorized2 = await persistedAuthorized(dir, { packetId: uniqueId('claimed') });
      await mkdir(join(dir, 'executions'), { recursive: true });
      await writeFile(join(dir, 'executions', `${authorized2.proposal_id}.lock`), JSON.stringify({ execution_id: `exec-${authorized2.proposal_id}`, claimed_at: '2026-07-11T00:10:00.000Z' }) + '\n', { flag: 'wx' });
      const res2 = await executeAuthorizedProposal({ storageRoot: dir, proposalId: authorized2.proposal_id });
      assert.equal(res2.ok, false);
      assert.equal(res2.error, ERRS.CONCURRENT_EXECUTION_CONFLICT);
      assert.equal(spawnImpl.calls.length, 0);
      // And the claim is never deleted by this module.
      const claim = await getExecutionClaim(dir, authorized2.proposal_id);
      assert.equal(claim.claimed, true);
    }, { gitInit: false });
  });
});

// ═════════════════════════ Authority containment (53-56) ════════════════════

test('53. T-032 creates no authorization: a refused proposal gains no state or events', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const persisted = await persistFresh(dir);
      const eventsBefore = (await ledgerEvents(dir)).length;
      const { executeAuthorizedProposal } = executorFor(ws, { spawnImpl: makeSpawnRecorder(behaviorExitZero) });
      const res = await executeAuthorizedProposal({ storageRoot: dir, proposalId: persisted.proposal_id });
      assert.equal(res.ok, false);
      const after = (await getPendingProposal(dir, persisted.proposal_id)).record;
      assert.equal(after.state, 'PERSISTED_PENDING');
      assert.equal(after.authority.decision_state, 'PENDING');
      assert.equal((await ledgerEvents(dir)).length, eventsBefore, 'refusal must append nothing');
    }, { gitInit: false });
  });
});

test('54. T-032 accepts no HUMAN-TURN credential in any request field', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const authorized = await persistedAuthorized(dir);
      const spawnImpl = makeSpawnRecorder(behaviorExitZero);
      const { executeAuthorizedProposal } = executorFor(ws, { spawnImpl });
      for (const field of ['token', 'presentedToken', 'authorization_token', 'expectedToken', 'expected_authorization_token']) {
        const res = await executeAuthorizedProposal({ storageRoot: dir, proposalId: authorized.proposal_id, [field]: TOKEN });
        assert.equal(res.ok, false, `credential field ${field} must be rejected`);
        assert.equal(res.error, ERRS.EXECUTION_OVERRIDE_FORBIDDEN);
      }
      assert.equal(spawnImpl.calls.length, 0);
    }, { gitInit: false });
  });
});

test('56. T-032 creates no reconciliation or witness claim', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const authorized = await persistedAuthorized(dir);
      const { executeAuthorizedProposal } = executorFor(ws, { spawnImpl: makeSpawnRecorder(behaviorExitZero) });
      const res = await executeAuthorizedProposal({ storageRoot: dir, proposalId: authorized.proposal_id });
      assert.equal(res.ok, true);
      const allowedTypes = new Set(['PROPOSAL_PERSISTED', 'PROPOSAL_AUTHORIZED', 'PROPOSAL_REJECTED', 'EXECUTION_STARTED', 'EXECUTION_COMPLETED', 'EXECUTION_FAILED']);
      for (const e of await ledgerEvents(dir)) {
        assert.ok(allowedTypes.has(e.type), `unexpected event type ${e.type}`);
      }
      assert.ok(!JSON.stringify(res.record).includes('RECONCILED'), 'no reconciliation claim may exist');
    }, { gitInit: false });
  });
});

// ═════════════════════════ Request-shape law ════════════════════════════════

test('an invalid or incomplete request is rejected before any read', async () => {
  await withTempWorkspace(async (ws) => {
    const { executeAuthorizedProposal } = executorFor(ws, { spawnImpl: makeSpawnRecorder(behaviorExitZero) });
    assert.equal((await executeAuthorizedProposal(null)).error, ERRS.INVALID_EXECUTION_REQUEST);
    assert.equal((await executeAuthorizedProposal({})).error, ERRS.INVALID_EXECUTION_REQUEST);
    assert.equal((await executeAuthorizedProposal({ storageRoot: '/tmp/x' })).error, ERRS.INVALID_EXECUTION_REQUEST);
  }, { gitInit: false });
});

test('trusted construction rejects a non-absolute or missing execution root', async () => {
  assert.throws(() => createBoundedProposalExecutor({}), TypeError);
  assert.throws(() => createBoundedProposalExecutor({ authorizedExecutionRoot: 'relative/path' }), TypeError);
});
