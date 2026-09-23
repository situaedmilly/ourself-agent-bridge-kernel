import test from 'node:test';
import assert from 'node:assert/strict';
import { githubActionsControl } from '../adapters/github-actions-control.js';

function transportCapture() {
  const calls = [];
  return {
    calls,
    transport: async (request) => {
      calls.push(request);
      return { ok: true };
    },
  };
}

test('read operations are allowlisted and do not require control admission', async () => {
  const { calls, transport } = transportCapture();
  const receipt = await githubActionsControl({
    operation: 'workflow.read',
    repo: 'situaedmilly/ourself-agent-bridge-kernel',
    workflowId: '311518895',
    transport,
  });

  assert.equal(receipt.control, false);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].path, '/repos/situaedmilly/ourself-agent-bridge-kernel/actions/workflows/311518895');
});

test('control operations fail closed without explicit admission', async () => {
  const { transport } = transportCapture();

  await assert.rejects(
    githubActionsControl({
      operation: 'workflow.disable',
      repo: 'situaedmilly/ourself-agent-bridge-kernel',
      workflowId: '311518895',
      transport,
    }),
    /requires explicit AgentBridge admission/,
  );
});

test('workflow dispatch is bounded to a workflow id, ref, and inputs object', async () => {
  const { calls, transport } = transportCapture();
  const receipt = await githubActionsControl({
    operation: 'workflow.dispatch',
    repo: 'situaedmilly/ourself-agent-bridge-kernel',
    workflowId: '311518895',
    ref: 'signal/local-ollama-cognition-20260922',
    inputs: { proof: 'control-plane' },
    transport,
    admission: true,
  });

  assert.equal(receipt.control, true);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].path, '/repos/situaedmilly/ourself-agent-bridge-kernel/actions/workflows/311518895/dispatches');
  assert.deepEqual(JSON.parse(calls[0].body), {
    ref: 'signal/local-ollama-cognition-20260922',
    inputs: { proof: 'control-plane' },
  });
});

test('arbitrary operations and arbitrary URLs cannot enter the membrane', async () => {
  const { transport } = transportCapture();

  await assert.rejects(
    githubActionsControl({
      operation: 'repository.delete',
      repo: 'situaedmilly/ourself-agent-bridge-kernel',
      transport,
    }),
    /unsupported GitHub Actions operation/,
  );

  await assert.rejects(
    githubActionsControl({
      operation: 'workflow.read',
      repo: 'https://api.github.com/repos/situaedmilly/ourself-agent-bridge-kernel',
      workflowId: '311518895',
      transport,
    }),
    /repo must be owner\/name/,
  );
});
