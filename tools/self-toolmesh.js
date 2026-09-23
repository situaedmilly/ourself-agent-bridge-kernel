// SELFTOOLMESH v1
// Tool identity and admission boundary for CHAMBOXREALITY.
// Cognition may propose a tool call. This module never grants authority merely
// because a model requested a capability.

'use strict';

export const TOOLMESH_VERSION = 'self.toolmesh.v1';
export const JURISDICTION = 'CHAMBOXREALITY';

const TOOLS = Object.freeze({
  'filesystem.read': Object.freeze({
    tool_id: 'filesystem.read',
    capability: 'READ',
    jurisdiction: JURISDICTION,
    scope: 'declared_workspace',
    authority_level: 0,
    side_effect: 'NONE',
    requires_admission: false,
    receipt: 'REQUIRED',
    rollback: null,
  }),
  'filesystem.write': Object.freeze({
    tool_id: 'filesystem.write',
    capability: 'WRITE',
    jurisdiction: JURISDICTION,
    scope: 'declared_workspace',
    authority_level: 2,
    side_effect: 'WORKSPACE_MUTATION',
    requires_admission: true,
    receipt: 'REQUIRED',
    rollback: 'restore_previous_bytes_or_git_revert',
  }),
  'terminal.execute': Object.freeze({
    tool_id: 'terminal.execute',
    capability: 'EXECUTE',
    jurisdiction: JURISDICTION,
    scope: 'RUORA_BOUNDARY',
    authority_level: 4,
    side_effect: 'PROCESS_EXECUTION',
    requires_admission: true,
    receipt: 'REQUIRED',
    rollback: 'command_specific',
  }),
});

export const TOOL_REGISTRY = TOOLS;

export function listTools() {
  return Object.values(TOOLS).map(tool => ({ ...tool }));
}

export function getTool(toolId) {
  return TOOLS[toolId] ? { ...TOOLS[toolId] } : null;
}

export function evaluateToolCall({ toolId, input = {}, admission = null, scope = null }) {
  const tool = TOOLS[toolId];
  if (!tool) return { ok: false, code: 'UNKNOWN_TOOL', reason: 'unknown tool: ' + toolId };
  if (tool.jurisdiction !== JURISDICTION) {
    return { ok: false, code: 'JURISDICTION_MISMATCH', reason: 'tool is outside CHAMBOXREALITY' };
  }
  if (tool.requires_admission) {
    if (!admission || typeof admission.verify !== 'function') {
      return { ok: false, code: 'ADMISSION_REQUIRED', reason: 'mutation-capable tool requires external admission' };
    }
    const verdict = admission.verify({ tool, input, scope });
    if (!verdict?.ok) {
      return { ok: false, code: 'ADMISSION_DENIED', reason: verdict?.reason || 'admission rejected' };
    }
  }
  return {
    ok: true,
    tool,
    input,
    scope: scope || tool.scope,
    receipt_required: tool.receipt === 'REQUIRED',
  };
}
