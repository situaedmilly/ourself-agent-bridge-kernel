import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const EVIDENCE_DIR = path.resolve(process.cwd(), 'evidence');
const WITNESS_FILE = path.join(EVIDENCE_DIR, 'morph-013-write-witness.json');
const OLLAMA_ENDPOINT = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'ourself-qwen25-7b-kernel';

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical(value[key])])
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonical(value));
}

async function qwenRecontact(prompt) {
  const response = await fetch(`${OLLAMA_ENDPOINT}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
    }),
  });

  assert.equal(response.ok, true, `Ollama recontact failed: HTTP ${response.status}`);
  const body = await response.json();
  return {
    model: body.model,
    response: body.message?.content ?? '',
    done: body.done,
    done_reason: body.done_reason,
  };
}

test('MORPH-014: OURLLAMMASELF REVERSELF bounded recontact', async (t) => {
  const artifactRaw = await fs.readFile(WITNESS_FILE, 'utf8');
  const witness = JSON.parse(artifactRaw);

  await t.test('01 artifact exists and has the required witness tuple', () => {
    assert.equal(witness.cognition_source, 'LIVE_QWEN');
    assert.ok(witness.payload_identity, 'H_P missing');
    assert.ok(witness.h_mutation_before, 'H_M_before missing');
    assert.ok(witness.h_mutation_active, 'H_M_active missing');
    assert.ok(witness.h_mutation_after, 'H_M_after missing');
    assert.ok(witness.timestamps, 't_exec missing');
  });

  await t.test('02 H_artifact binds the persisted bytes', () => {
    const computedArtifactHash = sha256(artifactRaw);

    // H_A is deliberately NOT stored inside the artifact being hashed.
    // If a future schema stores it, it must be excluded from the hashed envelope.
    if (witness.artifact_identity !== undefined) {
      assert.equal(
        witness.artifact_identity,
        computedArtifactHash,
        'H_A mismatch: persisted witness bytes changed'
      );
    }

    assert.match(computedArtifactHash, /^[0-9a-f]{64}$/);
  });

  await t.test('03 reconstruct H_payload without adding authority', () => {
    const canonicalBase = {
      cognition_source: witness.cognition_source,
      qwen_raw_proposal: witness.qwen_raw_proposal,
      evaluated_command: witness.evaluated_command,
      target: witness.target,
      admission: witness.admission,
      actuator: witness.actuator,
      containment_verified: witness.containment_verified,
      mutation_verified: witness.mutation_verified,
      rollback_verified: witness.rollback_verified,
      h_mutation_before: witness.h_mutation_before,
      h_mutation_active: witness.h_mutation_active,
      h_mutation_after: witness.h_mutation_after,
      timestamps: witness.timestamps,
    };

    assert.equal(
      sha256(canonicalJson(canonicalBase)),
      witness.payload_identity,
      'H_P mismatch: decision payload is not reconstructable'
    );

    // REVERSELF may reconstruct an admission decision.
    // It may not mint a new capability or execute it.
    assert.equal(witness.admission, 'ADMITTED');
    assert.equal(witness.actuator, 'SELFTOOLMESH_WRITE_BOUNDED');
  });

  await t.test('04 verify zero-net mutation invariant', () => {
    assert.equal(
      witness.h_mutation_before,
      witness.h_mutation_after,
      'H_M_before != H_M_after: net state drift detected'
    );
    assert.equal(witness.rollback_verified, true);
    assert.equal(witness.mutation_verified, true);
  });

  await t.test('05 reconstruct bounded causal preimage', () => {
    const preimage = {
      cognition_source: witness.cognition_source,
      raw_intent: witness.qwen_raw_proposal,
      evaluated_intent: witness.evaluated_command,
      admission: witness.admission,
      actuator: witness.actuator,
      target: witness.target,
    };

    assert.equal(preimage.cognition_source, 'LIVE_QWEN');
    assert.equal(preimage.admission, 'ADMITTED');
    assert.equal(preimage.actuator, 'SELFTOOLMESH_WRITE_BOUNDED');
    assert.match(preimage.target, /workspace[\\/]morph-013-target\.tmp$/);
  });

  await t.test('06 recontact OURLLAMMASELF without executing the reconstructed intent', async () => {
    const prompt =
      'REVERSELF recontact. Respond with exactly: OURLLAMMASELF RECONTACT ONLINE';

    const recontact = await qwenRecontact(prompt);

    assert.equal(recontact.model, OLLAMA_MODEL);
    assert.equal(recontact.response.trim(), 'OURLLAMMASELF RECONTACT ONLINE');
    assert.equal(recontact.done, true);
    assert.equal(recontact.done_reason, 'stop');

    // This test only recontacts cognition. It does not replay the historical
    // write, mint authority, invoke SELFTOOLMESH, or create a new actuator.
  });
});
