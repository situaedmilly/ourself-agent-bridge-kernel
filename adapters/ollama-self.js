// OURLLAMMASELF v1
// Local cognition adapter. Ollama is a cognition substrate, never an execution
// authority. Tool calls returned by the model are proposals for AgentBridge.

'use strict';

export const OURLLAMMASELF_VERSION = 'ourllammaself.v1';
export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
export const DEFAULT_MODEL = 'qwen2.5-coder:7b';

function normalizeBaseUrl(value) {
  return String(value || DEFAULT_OLLAMA_URL).replace(/\\/$/, '');
}

export async function ollamaChat({
  messages,
  tools = [],
  model = DEFAULT_MODEL,
  baseUrl = DEFAULT_OLLAMA_URL,
  signal,
}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('messages must be a non-empty array');
  }

  const payload = { model, messages, stream: false };
  if (Array.isArray(tools) && tools.length > 0) payload.tools = tools;

  const response = await fetch(normalizeBaseUrl(baseUrl) + '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error('Ollama HTTP ' + response.status + ': ' + body.slice(0, 500));
  }

  const result = await response.json();

  return {
    substrate: 'OLLAMA',
    jurisdiction: 'CHAMBOXREALITY',
    model: result.model || model,
    message: result.message || null,
    done: result.done === true,
    done_reason: result.done_reason || null,
    tool_calls: Array.isArray(result.message?.tool_calls) ? result.message.tool_calls : [],
    execution_authority: 'NONE',
    requires_agentbridge_admission: true,
    raw: result,
  };
}
