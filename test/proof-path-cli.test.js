import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const CLI = resolve('tools/proof-path-cli.js');
const VERIFIER = pathToFileURL(resolve('persistence/human-turn-decisions.js')).href;
const uniqueId = () => `packet-cli-${randomBytes(6).toString('hex')}`;
function buildProposal({ packetId, executionClass = 'git-read', route = 'git-read', mutation = false, intent = 'show git status of the repo' }) {
  const packet = {
    packet_id: packetId, node: 'Milly', source: 'cli', route, sia: 'ClaudeCodeSELF',
    execution_class: executionClass, intent, target: null, status: 'planned',
    created: '2026-07-25T00:00:00.000Z', parent_aecho: null, mutation, requires_approval: true,
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


async function fixture(fn, decision = 'AUTHORIZE') {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-cli-'));
  try {
    const workspace = join(dir, 'workspace');
    const store = join(dir, 'store');
    await mkdir(workspace);
    await mkdir(store);
    assert.equal(spawnSync('git', ['init', '-q', workspace]).status, 0);
    const reviewResult = buildReviewResult();
    const id = reviewResult.proposal.id;
    const token = randomBytes(32).toString('hex');
    const config = join(dir, 'operator.mjs');
    await writeFile(config, `import { createStaticHumanTurnTokenVerifier } from ${JSON.stringify(VERIFIER)};
export default {
  storageRoot: ${JSON.stringify(store)},
  authorizedExecutionRoot: ${JSON.stringify(workspace)},
  verifyHumanTurnAuthorization: createStaticHumanTurnTokenVerifier({
    proposalId: ${JSON.stringify(id)}, decision: ${JSON.stringify(decision)},
    expectedToken: process.env.PROOF_TEST_TOKEN,
  }),
};\n`);
    const request = { reviewResult, decision: {
      decision, decisionId: uniqueId(), decidedBy: 'MYSELF',
      decidedAt: new Date().toISOString(), reason: 'Isolated operator integration test',
      presentedToken: token,
    } };
    const invoke = (args, body = '') => {
      const child = spawnSync(process.execPath, [CLI, ...args], {
        input: typeof body === 'string' ? body : JSON.stringify(body), encoding: 'utf8',
        env: { ...process.env, PROOF_TEST_TOKEN: token, OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' },
        timeout: 15000,
      });
      assert.equal(child.error, undefined, String(child.error));
      assert.ok(!child.stdout.includes(token), 'credential must not appear in stdout');
      assert.ok(!child.stderr.includes(token), 'credential must not appear in stderr');
      return { code: child.status, result: JSON.parse(child.stdout), stderr: child.stderr };
    };
    await fn({ dir, workspace, store, config, request, id, invoke });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('operator runs real git execution, witnesses it, and a fresh process cold-verifies custody', async () => {
  await fixture(async ({ config, request, store, id, invoke }) => {
    const run = invoke(['run', '--config', config], request);
    assert.equal(run.code, 0, JSON.stringify(run));
    assert.equal(run.result.completed, true);
    assert.equal(run.result.outcome.outcome_class, 'SUCCESS_CONFIRMED');
    assert.equal(run.result.proof_chain_valid, true);
    const verified = invoke(['verify', '--storage-root', store, '--proposal-id', id]);
    assert.equal(verified.code, 0, JSON.stringify(verified));
    assert.equal(Object.keys(verified.result.checks).length, 4);
    for (const check of Object.values(verified.result.checks)) assert.equal(check.ok, true);
    // Change the ledger bytes only after successful independent recontact.
    const ledger = join(store, 'events.jsonl');
    await writeFile(ledger, `${await readFile(ledger, 'utf8')}{"forged":true}\n`);
    const corrupt = invoke(['verify', '--storage-root', store, '--proposal-id', id]);
    assert.equal(corrupt.code, 1);
    assert.equal(corrupt.result.ok, false);
  });
});

test('lawful rejection halts without execution or witness artifacts', async () => {
  await fixture(async ({ config, request, store, id, invoke }) => {
    const run = invoke(['run', '--config', config], request);
    assert.equal(run.code, 0);
    assert.equal(run.result.completed, false);
    assert.equal(run.result.outcome, 'REJECTED_BY_HUMAN_TURN');
    assert.equal(run.result.proof_chain_valid, null);
    assert.ok(!(await readdir(store)).some(name => /execut|witness|reconcil/.test(name)));
    const verified = invoke(['verify', '--storage-root', store, '--proposal-id', id]);
    assert.equal(verified.code, 1, 'a lawful rejection is not a completed execution proof');
    assert.equal(verified.result.error, 'PROOF_CHAIN_INCOMPLETE');
  }, 'REJECT');
});

test('wrong credential halts at HUMAN_TURN', async () => {
  await fixture(async ({ config, request, store, id, invoke }) => {
    request.decision.presentedToken = 'wrong-credential';
    const run = invoke(['run', '--config', config], request);
    assert.equal(run.code, 1);
    assert.equal(run.result.halted_at, 'HUMAN_TURN');
    assert.equal(run.result.completed, false);
    const verified = invoke(['verify', '--storage-root', store, '--proposal-id', id]);
    assert.equal(verified.code, 1, 'pending integrity must not impersonate completion');
    assert.equal(verified.result.error, 'PROOF_CHAIN_INCOMPLETE');
  });
});

test('request cannot replace operator roots or verifier configuration', async () => {
  await fixture(async ({ config, request, store, invoke }) => {
    request.storageRoot = '/untrusted';
    const run = invoke(['run', '--config', config], request);
    assert.equal(run.code, 2);
    assert.equal(run.result.phase, 'input');
    assert.deepEqual(await readdir(store), []);
  });
});

test('operator entry refuses injected execution fakes', async () => {
  await fixture(async ({ config, request, store, invoke }) => {
    const contents = await readFile(config, 'utf8');
    await writeFile(config, contents.replace('export default {', 'export default { executionSpawnImpl: () => {},'));
    const run = invoke(['run', '--config', config], request);
    assert.equal(run.code, 2);
    assert.equal(run.result.phase, 'configuration');
    assert.deepEqual(await readdir(store), []);
  });
});

test('unknown args, malformed and oversized input fail without persistence', async () => {
  await fixture(async ({ config, store, invoke }) => {
    assert.equal(invoke(['run', '--config', config], '{').code, 2);
    assert.equal(invoke(['run', '--config', config], ' '.repeat(1024 * 1024 + 1)).code, 2);
    assert.equal(invoke(['run', '--config', config, '--run-agents', 'yes']).code, 2);
    assert.equal(invoke(['verify', '--storage-root', 'relative', '--proposal-id', 'x']).code, 2);
    assert.deepEqual(await readdir(store), []);
  });
});

test('fresh verifier reports missing evidence without loading operator configuration', async () => {
  await fixture(async ({ store, id, invoke }) => {
    const run = invoke(['verify', '--storage-root', store, '--proposal-id', id]);
    assert.equal(run.code, 1);
    assert.equal(run.result.ok, false);
    assert.deepEqual(await readdir(store), []);
  });
});

test('a failed real command is not reported as successful completion', async () => {
  await fixture(async ({ config, workspace, request, invoke }) => {
    await rm(join(workspace, '.git'), { recursive: true, force: true });
    const run = invoke(['run', '--config', config], request);
    assert.equal(run.code, 1);
    assert.notEqual(run.result.outcome?.outcome_class, 'SUCCESS_CONFIRMED');
  });
});
