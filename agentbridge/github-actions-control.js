import { createGitHubActionsTransport } from '../adapters/github-actions-transport.js';

export const GITHUB_ACTIONS_CONTROL_VERSION = 'github-actions-control.v1';
const REPO = 'situaedmilly/ourself-agent-bridge-kernel';
const WORKFLOW_ID = '311518895';

function requireAdmission(admitted) {
  if (admitted !== true) throw new Error('GitHub Actions control requires explicit admission=true');
}

function requireRef(ref) {
  if (typeof ref !== 'string' || !/^[A-Za-z0-9._\/-]+$/.test(ref)) {
    throw new Error('GitHub Actions dispatch ref is invalid');
  }
  return ref;
}

export async function githubActionsControl({
  workflow_id = WORKFLOW_ID,
  ref,
  admitted = false,
  inputs = {},
  transport = createGitHubActionsTransport(),
} = {}) {
  requireAdmission(admitted);

  if (String(workflow_id) !== WORKFLOW_ID) {
    throw new Error('GitHub Actions workflow is fixed to the admitted AgentBridge workflow');
  }

  const dispatchRef = requireRef(ref);
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) {
    throw new Error('GitHub Actions dispatch inputs must be an object');
  }

  const path = `/repos/${REPO}/actions/workflows/${WORKFLOW_ID}/dispatches`;
  const body = JSON.stringify({ ref: dispatchRef, inputs });

  const result = await transport({
    method: 'POST',
    path,
    body,
  });

  return Object.freeze({
    control_version: GITHUB_ACTIONS_CONTROL_VERSION,
    operation: 'workflow_dispatch',
    method: 'POST',
    path,
    workflow_id: WORKFLOW_ID,
    ref: dispatchRef,
    admission: true,
    executed: true,
    actuation: 'GITHUB_WORKFLOW_DISPATCH',
    arbitrary_execution_authority: false,
    result,
  });
}
