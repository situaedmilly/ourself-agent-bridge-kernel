import test from 'node:test';
import assert from 'node:assert/strict';
import { runOllamaCognition } from '../agentbridge/ollama-runtime.js';

test('AgentBridge -> Ollama deterministic cognition proof', async () => {
  const receipt = await runOllamaCognition({
    prompt: 'Respond with exactly: AGENTBRIDGE OLLAMA RUNTIME ONLINE',
  });

  assert.equal(receipt.substrate, 'OLLAMA');
  assert.equal(receipt.jurisdiction, 'CHAMBOXREALITY');
  assert.equal(receipt.model, 'qwen2.5-coder:7b');
  assert.equal(receipt.done, true);
  assert.equal(receipt.response, 'AGENTBRIDGE OLLAMA RUNTIME ONLINE');
  assert.equal(receipt.execution_authority, 'NONE');
  assert.equal(receipt.requires_agentbridge_admission, true);
  assert.equal(receipt.actuation, 'NOT_PERFORMED');

  process.stdout.write(JSON.stringify(receipt) + '\n');
});
