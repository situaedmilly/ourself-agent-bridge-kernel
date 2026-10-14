import test from 'node:test';
import assert from 'node:assert/strict';
import { ollamaChat } from '../adapters/ollama-self.js';

test('Ollama adapter normalizes model, response, tool calls, and usage evidence', async () => {
  const originalFetch = globalThis.fetch;
  let observedUrl;
  let observedBody;
  globalThis.fetch = async (url, init) => {
    observedUrl = String(url);
    observedBody = JSON.parse(init.body);
    return new Response(JSON.stringify({
      model: 'qwen3.5:4b',
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'friendship_lab', arguments: { query: 'get Milly' } } }],
      },
      done: true,
      done_reason: 'stop',
      prompt_eval_count: 17,
      eval_count: 9,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await ollamaChat({
      messages: [{ role: 'user', content: 'lookup' }],
      model: 'qwen3.5:4b',
      baseUrl: 'http://127.0.0.1:11434/',
      tools: [{ type: 'function', function: { name: 'friendship_lab' } }],
    });
    assert.equal(observedUrl, 'http://127.0.0.1:11434/api/chat');
    assert.equal(observedBody.model, 'qwen3.5:4b');
    assert.equal(result.substrate, 'OLLAMA');
    assert.equal(result.model, 'qwen3.5:4b');
    assert.equal(result.message.content, '');
    assert.equal(result.tool_calls.length, 1);
    assert.equal(result.raw.prompt_eval_count, 17);
    assert.equal(result.raw.eval_count, 9);
    assert.equal(result.execution_authority, 'NONE');
    assert.equal(result.requires_agentbridge_admission, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Ollama adapter rejects empty messages before contacting the runtime', async () => {
  await assert.rejects(
    () => ollamaChat({ messages: [] }),
    /messages must be a non-empty array/,
  );
});

test('Ollama adapter reports upstream HTTP failures without claiming success', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('runtime unavailable', { status: 503 });
  try {
    await assert.rejects(
      () => ollamaChat({ messages: [{ role: 'user', content: 'test' }] }),
      /Ollama HTTP 503: runtime unavailable/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
