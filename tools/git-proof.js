import { executeCommand } from './terminal.js';

const RUORA_ROOT = '/Users/millysituated/RUORA';
const AXIOM_ROOT = `${RUORA_ROOT}/projects/axiom-trial-engine-v1`;

// Pre-built proof commands — each is safe and read-only.
// These are submitted to the approval queue, not executed directly.

export function firstTestCommand() {
  return {
    action: 'git log --oneline -5',
    working_dir: AXIOM_ROOT,
    rationale:
      'First safe test: read-only git log of the AXIOM child repository. ' +
      'Proves the full transmission → approval → execution → proof chain without any mutation.',
  };
}

export function ruoraStatusCommand() {
  return {
    action: 'git status --short',
    working_dir: RUORA_ROOT,
    rationale: 'Read-only git status of RUORA root. Proves repository alignment.',
  };
}

export function axiomBuildCommand() {
  return {
    action: 'npm run build',
    working_dir: AXIOM_ROOT,
    rationale: 'Rebuild AXIOM Trial Engine v1 dist. Proves current source compiles cleanly.',
  };
}

// Execute an already-approved git proof (called from approval route after OURSELF consent).
export async function runProof(command, workingDir) {
  return executeCommand(command, workingDir);
}
