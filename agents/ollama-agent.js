// agents/ollama-agent.js
// OURSELF Ollama / QWENSELF cognitive runtime adapter.
// The adapter performs cognition only. It does not execute terminal commands,
// mutate repositories, authorize transitions, or claim external effects.
//
// Runtime boundary:
//   OURSELFLLM -> ALCHEMYSELF -> ThirdEye -> CHAMBOXREALITY -> tools
//
// Ollama is a local model-serving runtime. QWENSELF is the model realization.
// Default endpoint is loopback-only by design.

'use strict';

export const OLLAMA_RUNTIME_VERSION = 'ourself.ollama-runtime.v1';
export const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
export const DEFAULT_OLLAMA_MODEL = 'qwen2.5-coder:7b';

export const OURSELF_OLLAMA_SYSTEM_PROMPT = `You are OURSELFLLM operating as the cognitive language substrate of the OURSELF ecosystem.

You are not a conversational chatbot and you are not an execution authority.

Identity layers:
- OURSELFLLM = language, cognition, semantic compilation, algorithmic reasoning.
- ALCHEMYSELF = agentic orchestration and transformation.
- THIRDEYE_HARNESS = inspection, adversarial pressure testing, and witnessing.
- CHAMBOXREALITY = bounded admission, execution, observation, and verification.
- OLLAMA = local model-serving runtime.
- QWENSELF = model realization running through Ollama.
- TOOLS = external capabilities. Tool output is evidence, not automatic truth.

Constitutional invariants:
VALID != AUTHORIZED != ACTUATABLE != EXECUTED != OBSERVED != VERIFIED != PERSISTED.
INTENT != EFFECT.
MODEL OUTPUT != WORLD STATE.
TOOL RESULT != PROOF OF WORLD EFFECT.
UNKNOWN MUST REMAIN UNKNOWN UNTIL RESOLVED.
NEVER CLAIM EXTERNAL EXECUTION, PERSISTENCE, MEMORY INSTALLATION, DEPLOYMENT, OR VERIFICATION WITHOUT CORRESPONDING EVIDENCE.

Compile substantial input through:
REALITY -> INSTANCE -> MATTER -> STATE -> INTENT -> SEMANTIC OBJECT -> CONSTRAINTS -> CAPABILITIES -> AUTHORITY -> TRANSITION CONTRACT -> THIRDEYE -> CHAMBOXREALITY -> ACTUATION -> OBSERVATION -> VERIFICATION -> RECEIPT -> MEMORY -> RECONTACT.

Treat natural language as a high-level programming language. Preserve semantic distinctions and expose semantic drift.

Your output is cognition. If an action is required, construct an executable transition contract for ALCHEMYSELF/CHAMBOXREALITY rather than executing it yourself.

When information is insufficient, emit UNKNOWN or PENDING rather than inventing state.`;

const COGNITIVE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    reality: { type: 'string' },
    instance: { type: 'string' },
    matter: { type: 'string' },
    state: { type: 'string' },
    intent: { type: 'string' },
    semantic_object: { type: 'object', additionalProperties: true },
    constraints: { type: 'array', items: { type: 'string' } },
    authority: { type: 'object', additionalProperties: true },
    transition_contract: { type: 'object', additionalProperties: true },
    thirdeye_findings: { type: 'object', additionalProperties: true },
    next_transition: { type: 'object', additionalProperties: true }
  },
  required: [
    'reality',
    'instance',
    'matter',
    'state',
    'intent',
    'semantic_object',
    'constraints',
    'authority',
    'transition_contract',
    'thirdeye_findings',
    'next_transition'
  ]
});

function normalizeBaseUrl(value) {
  const raw = String(value || DEFAULT_OLLAMA_BASE_URL).replace(/\/$/, '');
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('OLLAMA_BASE_URL must use http or https');
  }
  return url.toString().replace(/\\/$/, '');
}

function buildUrl(baseUrl, path) {
  return `${baseUrl}${path}`;
}

function assertResponse(response, operation) {
  if (!response || typeof response.ok !== 'boolean') {
    throw new TypeError(`${operation}: invalid fetch response`);
  }
  if (!response.ok) {
    throw new Error(`${operation}: Ollama returned HTTP ${response.status}`);
  }
}

export function createOllamaClient(config = {}) {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const model = config.model || DEFAULT_OLLAMA_MODEL;
  const fetchImpl = config.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('createOllamaClient requires fetch');
  }

  async function version() {
    const response = await fetchImpl(buildUrl(baseUrl, '/api/version'), { method: 'GET' });
    assertResponse(response, 'version');
    return response.json();
  }

  async function tags() {
    const response = await fetchImpl(buildUrl(baseUrl, '/api/tags'), { method: 'GET' });
    assertResponse(response, 'tags');
    return response.json();
  }

  async function ps() {
    const response = await fetchImpl(buildUrl(baseUrl, '/api/ps'), { method: 'GET' });
    assertResponse(response, 'ps');
    return response.json();
  }

  async function show(name = model) {
    const response = await fetchImpl(buildUrl(baseUrl, '/api/show'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name })
    });
    assertResponse(response, 'show');
    return response.json();
  }

  async function chat(message, options = {}) {
    const system = options.system || OURSELF_OLLAMA_SYSTEM_PROMPT;
    const requestedModel = options.model || model;
    const schema = options.schema || COGNITIVE_SCHEMA;
    const payload = {
      model: requestedModel,
      messages: [
        { role: 'system', content: system },
        ...(Array.isArray(options.history) ? options.history : []),
        { role: 'user', content: String(message) }
      ],
      stream: false,
      format: options.format || schema,
      ...(options.options ? { options: options.options } : {}),
      ...(options.think !== undefined ? { think: options.think } : {})
    };

    const response = await fetchImpl(buildUrl(baseUrl, '/api/chat'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    assertResponse(response, 'chat');

    const data = await response.json();
    const content = data?.message?.content ?? '';
    let cognitiveObject = null;

    if (content) {
      try {
        cognitiveObject = JSON.parse(content);
      } catch {
        // Structured output was requested, but malformed model output is not
        // silently promoted to a valid cognitive object.
      }
    }

    return {
      runtime: 'OLLAMA',
      model: requestedModel,
      response: content,
      cognitiveObject,
      structured: cognitiveObject !== null,
      done: data?.done === true,
      metrics: {
        total_duration: data?.total_duration,
        load_duration: data?.load_duration,
        prompt_eval_count: data?.prompt_eval_count,
        prompt_eval_duration: data?.prompt_eval_duration,
        eval_count: data?.eval_count,
        eval_duration: data?.eval_duration
      }
    };
  }

  return Object.freeze({
    baseUrl,
    model,
    version,
    tags,
    ps,
    show,
    chat
  });
}

export async function callOllama(message, context = {}, config = {}) {
  const client = createOllamaClient(config);
  return client.chat(message, context);
}

export { COGNITIVE_SCHEMA };
