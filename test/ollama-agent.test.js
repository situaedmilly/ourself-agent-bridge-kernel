import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createOllamaClient,
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_MODEL,
  OURSELF_OLLAMA_SYSTEM_PROMPT
} from '../agents/ollama-agent.js';

function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    const key = new URL(url).pathname;
    const handler = routes[key];
    if (!handler) return { ok: false, status: 404, json: async () => ({}) };
    return handler(options);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test('Ollama client defaults to loopback and Qwen coder model', () => {
  const fetchImpl = fakeFetch({});
  const client = createOllamaClient({ fetchImpl });
  assert.equal(client.baseUrl, DEFAULT_OLLAMA_BASE_URL);
  assert.equal(client.model, DEFAULT_OLLAMA_MODEL);
});

test('runtime recontact reads version, model inventory, running models, and model metadata', async () => {
  const fetchImpl = fakeFetch({
    '/api/version': async () => ({ ok: true, status: 200, json: async () => ({ version: '0.34.1' }) }),
    '/api/tags': async () => ({ ok: true, status: 200, json: async () => ({ models: [{ name: DEFAULT_OLLAMA_MODEL }] }) }),
    '/api/ps': async () => ({ ok: true, status: 200, json: async () => ({ models: [{ name: DEFAULT_OLLAMA_MODEL }] }) }),
    '/api/show': async (options) => {
      const body = JSON.parse(options.body);
      return { ok: true, status: 200, json: async () => ({ model: body.name, details: { family: 'qwen2' } }) };
    }
  });
  const client = createOllamaClient({ fetchImpl });
  assert.equal((await client.version()).version, '0.34.1');
  assert.equal((await client.tags()).models[0].name, DEFAULT_OLLAMA_MODEL);
  assert.equal((await client.ps()).models[0].name, DEFAULT_OLLAMA_MODEL);
  assert.equal((await client.show()).model, DEFAULT_OLLAMA_MODEL);
  assert.equal(fetchImpl.calls.length, 4);
});

test('chat requests OURSELF constitutional system prompt and structured cognitive output', async () => {
  const fetchImpl = fakeFetch({
    '/api/chat': async (options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.model, DEFAULT_OLLAMA_MODEL);
      assert.equal(body.stream, false);
      assert.match(body.messages[0].content, /OURSELFLLM/);
      assert.match(body.messages[0].content, /ALCHEMYSELF/);
      assert.match(body.messages[0].content, /THIRDEYE_HARNESS/);
      assert.match(body.messages[0].content, /CHAMBOXREALITY/);
      assert.ok(body.format);
      const object = {
        reality: 'OURSELF_OLLAMA_REALITY',
        instance: 'OURSELFLLM_V1',
        matter: 'COGNITION',
        state: 'COGNITIVELY_BOUND',
        intent: 'TEST',
        semantic_object: {},
        constraints: [],
        authority: { declared: true, admitted: false },
        transition_contract: { status: 'PROPOSED' },
        thirdeye_findings: { status: 'INSPECTED' },
        next_transition: { state: 'OPEN' }
      };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          message: { content: JSON.stringify(object) },
          done: true,
          prompt_eval_count: 10,
          eval_count: 20
        })
      };
    }
  });

  const result = await createOllamaClient({ fetchImpl }).chat('BOOT OURSELF');
  assert.equal(result.structured, true);
  assert.equal(result.cognitiveObject.state, 'COGNITIVELY_BOUND');
  assert.equal(result.done, true);
  assert.equal(result.metrics.prompt_eval_count, 10);
});

test('malformed model output never becomes a valid cognitive object', async () => {
  const fetchImpl = fakeFetch({
    '/api/chat': async () => ({
      ok: true,
      status: 200,
      json: async () => ({ message: { content: 'not-json' }, done: true })
    })
  });
  const result = await createOllamaClient({ fetchImpl }).chat('TEST');
  assert.equal(result.structured, false);
  assert.equal(result.cognitiveObject, null);
});

test('HTTP failures fail closed', async () => {
  const fetchImpl = fakeFetch({
    '/api/version': async () => ({ ok: false, status: 503, json: async () => ({}) })
  });
  await assert.rejects(() => createOllamaClient({ fetchImpl }).version(), /HTTP 503/);
});

test('custom endpoint remains explicit and never changes default exposure semantics', () => {
  const fetchImpl = fakeFetch({});
  const client = createOllamaClient({
    baseUrl: 'http://127.0.0.1:11434/',
    fetchImpl,
    model: 'custom:model'
  });
  assert.equal(client.baseUrl, 'http://127.0.0.1:11434');
  assert.equal(client.model, 'custom:model');
  assert.ok(OURSELF_OLLAMA_SYSTEM_PROMPT.includes('MODEL OUTPUT != WORLD STATE'));
});
