Process started with PID 72882 (shell: /bin/zsh)
Initial output:
import { exec } from 'child_process';
import { promisify } from 'util';
import { resolve } from 'path';
import { inspectCommand, enforceClassPolicy } from './command-firewall.js';

const execAsync = promisify(exec);

const RUORA_BOUNDARY = process.env.RUORA_BOUNDARY || '/Users/millysituated/RUORA';
const TIMEOUT_MS = 30_000;

function isWithinBoundary(workingDir) {
  const resolved = resolve(workingDir);
  return resolved === RUORA_BOUNDARY || resolved.startsWith(RUORA_BOUNDARY + '/');
}

// Execute an approved command.
// Throws if working_dir is outside the RUORA boundary.
// This function must ONLY be called after OURSELF approval — never autonomously.
export async function executeCommand(action, workingDir, executionClass = null) {
  if (!workingDir) throw new Error('Working directory is required.');

  if (!isWithinBoundary(workingDir)) {
    throw new Error(
      `Working directory must be within ${RUORA_BOUNDARY}.\nReceived: ${workingDir}`
    );
  }

  // ── Pass 20B: class-aware enforcement, before the generic denylist ─────────
  // When an execution class is supplied (the /approve path always supplies one),
  // the command SHAPE must be permitted for that class or it is refused before
  // any shell is spawned. forbidden / reverse_engineer / unknown / missing
  // classes never pass here. When no class is supplied (legacy direct callers,
  // e.g. the boundary/firewall unit tests and git-proof helper), behavior is
  // unchanged — the generic firewall below remains the sole guard. The denial is
  // logged WITHOUT the raw command: only the class and the stable rule id.
  if (executionClass != null) {
    const classVerdict = enforceClassPolicy(action, executionClass);
    if (!classVerdict.allowed) {
      console.warn(
        `⛔ CLASS POLICY DENIED — class=${executionClass} rule=${classVerdict.pattern} category=${classVerdict.category}; command blocked before execution.`
      );
      const err = new Error(
        `Command blocked by class policy: ${classVerdict.reason} [class: ${executionClass}, rule: ${classVerdict.pattern}, category: ${classVerdict.category}]`
      );
      err.classPolicyDenied = true;
      err.executionClass = executionClass;
      err.classPattern = classVerdict.pattern;
      err.classCategory = classVerdict.category;
      throw err;
    }
  }

  // ── Pass 18: action-level firewall, immediately before shell execution ─────
  // Even an OURSELF-approved command is refused if it matches the conservative
  // denylist. Fail closed: a denial throws a structured Error so the approval
  // route records the command as `failed` and never spawns a shell.
  // The denial is logged WITHOUT the raw command (which could echo a secret
  // path or value) — only the stable rule id and category are emitted.
  const verdict = inspectCommand(action);
  if (!verdict.allowed) {
    console.warn(
      `⛔ FIREWALL DENIED — rule=${verdict.pattern} category=${verdict.category}; command blocked before execution.`
    );
    const err = new Error(
      `Command blocked by firewall: ${verdict.reason} [rule: ${verdict.pattern}, category: ${verdict.category}]`
    );
    err.firewallDenied = true;
    err.firewallPattern = verdict.pattern;
    err.firewallCategory = verdict.category;
    throw err;
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

