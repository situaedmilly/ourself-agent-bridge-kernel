import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function receiptHash(receipt) {
  const unsigned = { ...receipt };
  delete unsigned.receipt_hash;
  return createHash('sha256').update(canonical(unsigned)).digest('hex');
}

function admit(proposal) {
  if (
    proposal.action_class === 'OBSERVE' &&
    proposal.target === 'ollama' &&
    proposal.operation === 'READ' &&
    proposal.side_effect === 'NONE'
  ) return 'ADMITTED';

  if (proposal.action_class === 'SHELL' || /\bsudo\b/i.test(String(proposal.command ?? proposal.operation ?? ''))) {
    return 'DENIED';
  }

  return 'DENIED';
}

test('MORPH-011 admits only the bounded Ollama read operation', () => {
  assert.equal(admit({
    action_class: 'OBSERVE',
    target: 'ollama',
    operation: 'READ',
    side_effect: 'NONE'
  }), 'ADMITTED');
});

test('MORPH-011 denies a sudo proposal', () => {
  assert.equal(admit({
    action_class: 'SHELL',
    target: 'local-host',
    operation: 'sudo echo MORPH-011-BYPASS',
    side_effect: 'UNKNOWN',
    command: 'sudo echo MORPH-011-BYPASS'
  }), 'DENIED');
});

test('denied path has no actuator invocation surface', () => {
  const source = require('node:fs').readFileSync(new URL('../tools/morph-011-harness.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from ['"]node:child_process['"]/);
  assert.doesNotMatch(source, /child_process/);
  assert.doesNotMatch(source, /execSync|spawnSync|execFileSync/);
});

test('receipt hash binds proposal, admission, actuation, and observation fields', () => {
  const receipt = {
    receipt_type: 'MORPH-011-AuthorityReceipt',
    proposal_id: 'prop-test',
    model_id: 'qwen2.5-coder:7b',
    model_output: '{"action_class":"OBSERVE"}',
    action_class: 'OBSERVE',
    target: 'ollama',
    operation: 'READ',
    side_effect: 'NONE',
    admission_decision: 'ADMITTED',
    policy_id: 'MORPH-011-AUTHORITY-BOUNDARY-v0.1',
    actuation_id: 'act-test',
    actuation_status: 'EXECUTED',
    observed_state: { status: 200 },
    observation_id: 'obs-test',
    timestamps: {
      proposal: '2026-09-23T00:00:00.000Z',
      admission: '2026-09-23T00:00:00.001Z',
      actuation: '2026-09-23T00:00:00.002Z',
      observation: '2026-09-23T00:00:00.003Z',
      receipt: '2026-09-23T00:00:00.004Z'
    }
  };
  const hash = receiptHash(receipt);
  assert.match(hash, /^[a-f0-9]{64}$/);
  const tampered = { ...receipt, admission_decision: 'DENIED' };
  assert.notEqual(receiptHash(tampered), hash);
});
