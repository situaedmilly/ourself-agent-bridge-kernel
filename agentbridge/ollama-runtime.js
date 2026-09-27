// AgentBridge -> OURLLAMMASELF runtime boundary v1
// Cognition is routed through AgentBridge; model output never directly actuates a tool.

'use strict';

import { ollamaChat } from '../adapters/ollama-self.js';

export const AGENTBRIDGE_OLLAMA_RUNTIME_VERSION = 'agentbridge-ollama-runtime.v1';

export async function runOllamaCognition({
  prompt,
  model = 'qwen2.5-coder:7b',
  baseUrl = 'http://127.0.0.1:11434',
  signal = 'OURSELF-SIG-20260922-001',
  message = 'OURSELF-MSG-20260922-001',
}) {
  if (typeof prompt !== 'string' || prompt.length === 0) {
    throw new Error('prompt must be a non-empty string');
  }

  const startedAt = new Date().toISOString();
  const result = await ollamaChat({
    model,
    baseUrl,
    messages: [{ role: 'user', content: prompt }],
  });
  const finishedAt = new Date().toISOString();

  return {
    receipt_type: 'AgentBridgeOllamaCognitionReceipt',
    runtime: AGENTBRIDGE_OLLAMA_RUNTIME_VERSION,
    signal,
    message,
    started_at: startedAt,
    finished_at: finishedAt,
    substrate: result.substrate,
    jurisdiction: result.jurisdiction,
    model: result.model,
    done: result.done,
    done_reason: result.done_reason,
    response: result.message?.content ?? null,
    tool_calls: result.tool_calls,
    execution_authority: result.execution_authority,
    requires_agentbridge_admission: result.requires_agentbridge_admission,
    actuation: 'NOT_PERFORMED',
  };
}
