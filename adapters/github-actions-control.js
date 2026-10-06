// GitHub Actions control-plane membrane.
// Only allowlisted Actions endpoints are reachable through this adapter.
// Transport is injected so AgentBridge can bind the adapter to an authorized
// GitHub connection without giving this module arbitrary HTTP authority.

'use strict';

const OWNER_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const WORKFLOW_ID = /^[0-9]+$/;

const OPERATION_DEFS = Object.freeze({
  'workflow.list': { method: 'GET', path: ({ repo }) => `/repos/${repo}/actions/workflows` },
  'workflow.read': { method: 'GET', path: ({ repo, workflowId }) => `/repos/${repo}/actions/workflows/${workflowId}` },
  'workflow.enable': { method: 'PUT', path: ({ repo, workflowId }) => `/repos/${repo}/actions/workflows/${workflowId}/enable`, control: true },
  'workflow.disable': { method: 'PUT', path: ({ repo, workflowId }) => `/repos/${repo}/actions/workflows/${workflowId}/disable`, control: true },
  'workflow.dispatch': { method: 'POST', path: ({ repo, workflowId }) => `/repos/${repo}/actions/workflows/${workflowId}/dispatches`, control: true },
  'actions.permissions.read': { method: 'GET', path: ({ repo }) => `/repos/${repo}/actions/permissions` },
  'actions.workflow.permissions.read': { method: 'GET', path: ({ repo }) => `/repos/${repo}/actions/permissions/workflow` },
  'runner.groups.read': { method: 'GET', path: ({ repo }) => `/repos/${repo}/actions/runner-groups` },
  'runners.read': { method: 'GET', path: ({ repo }) => `/repos/${repo}/actions/runners` },
});

function assertInput({ operation, repo, workflowId, ref, inputs }) {
  if (!Object.prototype.hasOwnProperty.call(OPERATION_DEFS, operation)) {
    throw new Error(`unsupported GitHub Actions operation: ${operation}`);
  }
  if (!OWNER_REPO.test(repo ?? '')) throw new Error('repo must be owner/name');
  if (operation.startsWith('workflow.') && operation !== 'workflow.list' && !WORKFLOW_ID.test(String(workflowId ?? ''))) {
    throw new Error('workflowId must be a numeric GitHub workflow id');
  }
  if (operation === 'workflow.dispatch' && (!ref || typeof ref !== 'string' || ref.length > 256)) {
    throw new Error('workflow.dispatch requires a bounded ref');
  }
  if (inputs !== undefined && (inputs === null || typeof inputs !== 'object' || Array.isArray(inputs))) {
    throw new Error('workflow.dispatch inputs must be an object');
  }
}

function buildRequest({ operation, repo, workflowId, ref, inputs }) {
  assertInput({ operation, repo, workflowId, ref, inputs });
  const def = OPERATION_DEFS[operation];
  const body = operation === 'workflow.dispatch' ? JSON.stringify({ ref, inputs: inputs ?? {} }) : undefined;
  return Object.freeze({
    method: def.method,
    path: def.path({ repo, workflowId }),
    body,
    control: def.control === true,
    operation,
  });
}

/**
 * Execute one allowlisted Actions control-plane operation.
 *
 * transport(request) is the already-authorized GitHub connection.
 * This adapter never accepts a URL, token, arbitrary method, or arbitrary path.
 */
export async function githubActionsControl({
  operation,
  repo,
  workflowId,
  ref,
  inputs,
  transport,
  admission = false,
}) {
  if (typeof transport !== 'function') throw new Error('authorized GitHub transport is required');

  const request = buildRequest({ operation, repo, workflowId, ref, inputs });

  if (request.control && admission !== true) {
    throw new Error(`control operation requires explicit AgentBridge admission: ${operation}`);
  }

  const result = await transport(request);

  return Object.freeze({
    receipt_type: 'GitHubActionsControlReceipt',
    operation,
    method: request.method,
    path: request.path,
    control: request.control,
    admission: request.control ? 'GRANTED' : 'NOT_REQUIRED',
    executed: true,
    actuation: 'GITHUB_ACTIONS_CONTROL_ONLY',
    arbitrary_execution_authority: 'NONE',
    result,
  });
}

export const GITHUB_ACTIONS_CONTROL_OPERATIONS = Object.freeze(Object.keys(OPERATION_DEFS));
