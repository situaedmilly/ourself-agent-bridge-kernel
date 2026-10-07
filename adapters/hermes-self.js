// MODELSELF local Hermes adapter v0.1
// Runtime witness: llama.cpp serving Hermes 3 3B Q4_K_M on loopback:11435.
// Cognition is not execution authority; tool proposals still require AgentBridge admission.

'use strict';

export const MODELSELF_HERMES_VERSION = 'modelself-hermes.v0.1';
export const DEFAULT_HERMES_URL = 'http://127.0.0.1:11435';
export const DEFAULT_HERMES_MODEL = 'NousResearch/Hermes-3-Llama-3.2-3B-GGUF:Q4_K_M';
export const DEFAULT_HERMES_CONTEXT = 32768;

function normalizeBaseUrl(value) {
  return String(value || DEFAULT_HERMES_URL).replace(/\/$/, '');
}

export async function hermesChat({
  messages,
  tools = [],
  model = DEFAULT_HERMES_MODEL,
  baseUrl = DEFAULT_HERMES_URL,
  signal,
  temperature = 0.7,
}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('messages must be a non-empty array');
  }

  const payload = { model, messages, stream: false, temperature };
  if (Array.isArray(tools) && tools.length > 0) payload.tools = tools;

  const response = await fetch(normalizeBaseUrl(baseUrl) + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error('llama.cpp HTTP ' + response.status + ': ' + body.slice(0, 500));
  }

  const result = await response.json();
  const choice = result.choices?.[0] || {};

  return {
    substrate: 'LLAMA_CPP',
    model: result.model || model,
    endpoint: normalizeBaseUrl(baseUrl),
    context_size: DEFAULT_HERMES_CONTEXT,
    message: choice.message || null,
    done: choice.finish_reason === 'stop',
    finish_reason: choice.finish_reason || null,
    tool_calls: Array.isArray(choice.message?.tool_calls) ? choice.message.tool_calls : [],
    execution_authority: 'NONE',
    requires_agentbridge_admission: true,
    timings: result.timings || null,
    usage: result.usage || null,
    raw: result,
  };
}
