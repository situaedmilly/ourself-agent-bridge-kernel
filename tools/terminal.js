import { exec } from 'child_process';
import { promisify } from 'util';
import { resolve } from 'path';

const execAsync = promisify(exec);

const RUORA_BOUNDARY = '/Users/millysituated/RUORA';
const TIMEOUT_MS = 30_000;

function isWithinBoundary(workingDir) {
  const resolved = resolve(workingDir);
  return resolved === RUORA_BOUNDARY || resolved.startsWith(RUORA_BOUNDARY + '/');
}

// Execute an approved command.
// Throws if working_dir is outside the RUORA boundary.
// This function must ONLY be called after OURSELF approval — never autonomously.
export async function executeCommand(action, workingDir) {
  if (!workingDir) throw new Error('Working directory is required.');

  if (!isWithinBoundary(workingDir)) {
    throw new Error(
      `Working directory must be within ${RUORA_BOUNDARY}.\nReceived: ${workingDir}`
    );
  }

  let stdout, stderr;
  try {
    ({ stdout, stderr } = await execAsync(action, {
      cwd: resolve(workingDir),
      timeout: TIMEOUT_MS,
      shell: '/bin/zsh',
    }));
  } catch (err) {
    // exec rejects on non-zero exit code — surface stderr as the error message
    throw new Error(err.stderr?.trim() || err.message);
  }

  return {
    action,
    workingDir: resolve(workingDir),
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    executedAt: new Date().toISOString(),
  };
}
