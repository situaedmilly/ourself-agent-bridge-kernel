// tools/execution-classes.js
// ── Pass 20A · Constrained Execution Classes ────────────────────────────────
//
// PURPOSE
//   Give every queued command a TYPED execution class before it can reach the
//   terminal executor, and enforce that class — fail-closed — at the approval
//   gate. This is the permission ARCHITECTURE layer:
//     • every command gets a class
//     • every class has fixed permissions (risk / mutation / terminal)
//     • unknown / missing / forbidden / non-terminal / mismatched ⇒ refused
//
// RELATION TO THE FIREWALL (tools/command-firewall.js)
//   classifyCommand() calls inspectCommand() FIRST. Anything the Pass 18
//   firewall denies is, by construction, classified `forbidden`. The classifier
//   is therefore never weaker than the firewall — it only adds class structure
//   and closes a few gaps the firewall does not cover (plain `git push`,
//   `git remote`, `gh`, raw network egress, secret-path access of any kind,
//   audit-log mutation, traversal outside the RUORA boundary).
//
// SCOPE — PASS 20A ONLY
//   • Schema + classifier + approval evaluation.
//   • `reverse_engineer` exists as a FIRST-CLASS schema member but is
//     non-mutating, terminal-forbidden, analysis-only. No shell command ever
//     classifies AS reverse_engineer; its structured analysis route is DEFERRED
//     to Pass 20C. If anything ever tries to enqueue a reverse_engineer (or any
//     non-terminal class) for execution, evaluateApproval() fails closed.
//
// CONTRACT
//   classifyCommand(action) -> { class, risk, mutation, terminal, analysisOnly, reason }
//   evaluateApproval(storedClass, action) -> { ok, code, reason, live }
//   Returned `reason` / class metadata are safe to log: they describe the SHAPE
//   of the command, never a secret value or a presented token.

import { inspectCommand } from './command-firewall.js';

export const RUORA_BOUNDARY = '/Users/millysituated/RUORA';

// ── Class schema ─────────────────────────────────────────────────────────────
// terminal:false  ⇒ may NEVER reach the shell executor (fail-closed at approval)
// mutation:true   ⇒ may change on-disk / repo state inside the boundary
// requiresApproval is true for every executable class: 20A never auto-executes.
export const EXECUTION_CLASSES = Object.freeze({
  inspect: Object.freeze({
    class: 'inspect', risk: 'low', mutation: false, terminal: true,
    analysisOnly: false, requiresApproval: true,
  }),
  test: Object.freeze({
    class: 'test', risk: 'low', mutation: false, terminal: true,
    analysisOnly: false, requiresApproval: true,
  }),
  build: Object.freeze({
    class: 'build', risk: 'medium', mutation: true, terminal: true,
    analysisOnly: false, requiresApproval: true,
  }),
  'git-read': Object.freeze({
    class: 'git-read', risk: 'low', mutation: false, terminal: true,
    analysisOnly: false, requiresApproval: true,
  }),
  'git-write-local': Object.freeze({
    class: 'git-write-local', risk: 'medium', mutation: true, terminal: true,
    analysisOnly: false, requiresApproval: true,
  }),
  'project-mutation': Object.freeze({
    class: 'project-mutation', risk: 'high', mutation: true, terminal: true,
    analysisOnly: false, requiresApproval: true,
  }),
  // First-class schema member — analysis-only, NEVER terminal. (Pass 20C route.)
  reverse_engineer: Object.freeze({
    class: 'reverse_engineer', risk: 'medium', mutation: false, terminal: false,
    analysisOnly: true, requiresApproval: true,
  }),
  forbidden: Object.freeze({
    class: 'forbidden', risk: 'critical', mutation: false, terminal: false,
    analysisOnly: false, requiresApproval: false,
  }),
});

export const EXECUTION_CLASS_NAMES = Object.freeze(Object.keys(EXECUTION_CLASSES));

/** Classes that may never reach the terminal executor. */
export const NON_TERMINAL_CLASSES = Object.freeze(
  EXECUTION_CLASS_NAMES.filter((name) => !EXECUTION_CLASSES[name].terminal)
);

// ── Normalization ────────────────────────────────────────────────────────────
function normalize(action) {
  const collapsed = String(action ?? '').replace(/\s+/g, ' ').trim();
  return { collapsed, lc: collapsed.toLowerCase() };
}

function verdict(klass, reason) {
  const meta = EXECUTION_CLASSES[klass];
  return {
    class: meta.class,
    risk: meta.risk,
    mutation: meta.mutation,
    terminal: meta.terminal,
    analysisOnly: meta.analysisOnly,
    reason,
  };
}

// ── Pattern fragments (shapes, never secret values) ──────────────────────────
// A secret-bearing file/path fragment — mirrors the firewall's SECRET_FILE.
// Exported (Pass 20C) so the read-only reverse_engineer analysis route refuses
// secret-bearing target paths from the SAME source of truth, never its own copy.
export const SECRET_PATH =
  /(^|[\s/="'`@:,])(\.env(\.[a-z0-9_-]+)?|id_rsa|id_dsa|id_ecdsa|id_ed25519|[\w.-]+\.pem|[\w.-]+\.key|[\w.-]+\.p12|[\w.-]+\.pfx|\.ssh\/|\.aws\/credentials|\.netrc|\.npmrc|credentials(\.json)?|secrets?\.(json|ya?ml|env|txt))(\b|$)/i;

// Append-only audit logs — mutation/deletion of these is forbidden.
const LOG_PATH_TARGET = /(transmissions\.jsonl|queue\.jsonl|logs[/][\w.-]*\.jsonl)/i;

// Network egress / remote transport tools — no remote I/O in the kernel.
const NET_EGRESS = /\b(curl|wget|nc|ncat|netcat|telnet|ftp|tftp|socat|scp|sftp|ssh|rsync)\b/;

// Filesystem-mutating verbs (used for log-mutation detection and the catch-all).
const MUTATE_VERB =
  /\b(rm|rmdir|mv|cp|tee|truncate|dd|shred|unlink|ln|chmod|chown)\b|\bsed\b[^|&;]*\s-i\b/;

// Test / verification runners.
const TEST_RE =
  /\b(npm|pnpm|yarn)\b\s+(run\s+)?(test|t)\b|\bnode\b[^|&;]*--(test|check)\b|\b(pytest|jest|vitest|mocha|ava|tap)\b/;

// Build / dependency / compile steps.
const BUILD_RE =
  /\b(npm|pnpm|yarn)\b\s+(ci|install|i|build|start|run\b[^|&;]*)\b|\bmake\b|\btsc\b|\b(vite|webpack|rollup|esbuild|parcel|babel)\b/;

// Read-only inspection commands (first token).
const INSPECT_CMDS = new Set([
  'ls', 'pwd', 'cat', 'bat', 'head', 'tail', 'wc', 'find', 'tree', 'stat',
  'file', 'du', 'df', 'echo', 'which', 'type', 'whoami', 'date', 'realpath',
  'dirname', 'basename', 'readlink', 'hostname', 'uname', 'less', 'more', 'nl',
  'column', 'sort', 'uniq', 'cut', 'grep', 'egrep', 'fgrep', 'rg', 'jq', 'sleep',
  'true', 'printf', 'diff', 'cmp', 'md5', 'shasum', 'sha256sum',
]);

// Known mutating / arbitrary-code first tokens (in-boundary project mutation).
const MUTATE_CMDS = new Set([
  'mkdir', 'touch', 'mv', 'cp', 'rm', 'rmdir', 'ln', 'sed', 'tee', 'dd',
  'chmod', 'chown', 'truncate', 'install', 'unzip', 'tar', 'zip', 'rename',
  'node', 'python', 'python3', 'ruby', 'perl', 'npx',
]);

// Git subcommand sets.
const GIT_NETWORK = new Set(['push', 'pull', 'fetch', 'clone', 'remote', 'submodule']);
const GIT_READ = new Set([
  'status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'blame',
  'describe', 'cat-file', 'shortlog', 'reflog', 'rev-list', 'for-each-ref',
  'show-ref', 'whatchanged', 'name-rev', 'count-objects', 'verify-commit',
  'version',
]);
const GIT_WRITE = new Set([
  'commit', 'add', 'merge', 'reset', 'restore', 'checkout', 'switch', 'branch',
  'tag', 'stash', 'rm', 'mv', 'cherry-pick', 'rebase', 'revert', 'clean',
  'init', 'apply', 'am', 'gc', 'prune', 'update-ref', 'symbolic-ref', 'config',
  'worktree',
]);

// ── Helpers ──────────────────────────────────────────────────────────────────
function firstToken(lc) {
  // Strip leading `FOO=bar` env assignments, then take the first word.
  const m = lc.match(/^(?:[a-z_][a-z0-9_]*=[^\s]*\s+)*([^\s]+)/);
  let tok = m ? m[1] : lc.split(' ')[0] || '';
  if (tok.includes('/')) tok = tok.slice(tok.lastIndexOf('/') + 1); // /usr/bin/ls → ls
  return tok;
}

/** Extract the git subcommand, skipping global flags (`-C path`, `-c kv`, …). */
function gitSubcommand(lc) {
  const after = lc.replace(/^.*?\bgit\b\s*/, '');
  const tokens = after.split(' ').filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '-c' || t === '-C') { i++; continue; } // consumes the next token
    if (t.startsWith('-')) continue;                 // other global flag
    return t.replace(/[^a-z-]/g, '');
  }
  return null;
}

/** True when the command writes a file via shell redirection (`>` / `>>`). */
function hasWriteRedirection(s) {
  return /(?:^|\s)\d?>{1,2}\s*[^&\s]/.test(s); // excludes `2>&1`
}

/** True for parent-dir traversal or any absolute path outside the boundary. */
function hasTraversalOrOutsideBoundary(s) {
  if (/(^|[\s/="'`(])\.\.(\/|\s|$)/.test(s)) return true;        // ".." traversal
  if (/(^|\s)~(\/|\s|$)/.test(s)) return true;                   // "~" (home, > boundary)
  const matches = s.match(/(^|[\s="'`(:])(\/[^\s"'`):]*)/g) || [];
  for (const raw of matches) {
    const p = raw.replace(/^[\s="'`(:]+/, '');
    if (!p.startsWith('/')) continue;
    if (p === '/') return true;
    if (!(p === RUORA_BOUNDARY || p.startsWith(RUORA_BOUNDARY + '/'))) return true;
  }
  return false;
}

// ── Classifier ───────────────────────────────────────────────────────────────
/**
 * Classify a shell command into exactly one execution class.
 * Ordered, fail-closed: anything unrecognized ⇒ `forbidden`.
 * @param {string} action
 * @returns {{class:string, risk:string, mutation:boolean, terminal:boolean, analysisOnly:boolean, reason:string}}
 */
export function classifyCommand(action) {
  const { collapsed, lc } = normalize(action);

  // 0 ── Empty / missing ⇒ forbidden (fail closed)
  if (collapsed.length === 0) return verdict('forbidden', 'empty or missing command');

  // 1 ── Firewall denial ⇒ forbidden (classifier is never weaker than firewall)
  const fw = inspectCommand(collapsed);
  if (!fw.allowed) return verdict('forbidden', `firewall denial [${fw.pattern}]: ${fw.reason}`);

  // 2 ── Privilege escalation ⇒ forbidden
  if (/\bsudo\b|\bdoas\b|\bsu\b\s/.test(lc)) return verdict('forbidden', 'privilege escalation');

  // 3 ── Secret-bearing path (read OR write) ⇒ forbidden
  if (SECRET_PATH.test(collapsed)) {
    return verdict('forbidden', 'touches a secret-bearing path (.env / *.pem / credentials / …)');
  }

  // 4 ── Traversal / outside the RUORA boundary ⇒ forbidden
  if (hasTraversalOrOutsideBoundary(collapsed)) {
    return verdict('forbidden', 'path traversal or target outside the RUORA boundary');
  }

  // 5 ── Network egress / GitHub publication ⇒ forbidden (no remote I/O)
  if (NET_EGRESS.test(lc)) return verdict('forbidden', 'network egress / remote transport tool');
  if (/\bgh\b/.test(lc)) return verdict('forbidden', 'GitHub CLI (gh) — no remote publication');

  // 6 ── Audit-log mutation/deletion ⇒ forbidden
  if (LOG_PATH_TARGET.test(lc) && (hasWriteRedirection(collapsed) || MUTATE_VERB.test(lc))) {
    return verdict('forbidden', 'mutates or deletes an append-only audit log');
  }

  // 7 ── Git
  if (/(^|[\s;&|(])git\b/.test(lc)) {
    const sub = gitSubcommand(lc);
    if (!sub || GIT_NETWORK.has(sub)) {
      return verdict('forbidden', `remote/network git is forbidden (git ${sub ?? '(none)'})`);
    }
    if (GIT_READ.has(sub)) return verdict('git-read', `read-only git (${sub})`);
    if (GIT_WRITE.has(sub)) return verdict('git-write-local', `local git mutation (${sub}) — no push/remote`);
    return verdict('forbidden', `unrecognized git subcommand (${sub}) — fail closed`);
  }

  // 8 ── Test runners (checked before build so `npm run test` → test)
  if (TEST_RE.test(lc)) return verdict('test', 'test / verification runner');

  // 9 ── Build / dependency / compile
  if (BUILD_RE.test(lc)) return verdict('build', 'build / dependency / compile step');

  // 10 ── Write redirection ⇒ project mutation (creates/overwrites a file)
  if (hasWriteRedirection(collapsed)) {
    return verdict('project-mutation', 'writes a file via shell redirection inside the boundary');
  }

  const first = firstToken(lc);

  // 11 ── Read-only inspection
  if (INSPECT_CMDS.has(first)) return verdict('inspect', `read-only inspection (${first})`);

  // 12 ── Known in-boundary mutation
  if (MUTATE_CMDS.has(first) || MUTATE_VERB.test(lc)) {
    return verdict('project-mutation', `in-boundary filesystem / project mutation (${first})`);
  }

  // 13 ── Unrecognized ⇒ forbidden (FAIL CLOSED)
  return verdict('forbidden', 'unrecognized command — fail closed');
}

// ── Approval evaluation ──────────────────────────────────────────────────────
/**
 * Decide whether an approved command may reach the executor.
 * Fails closed for: missing class, unknown class, forbidden class (stored OR
 * live), non-terminal class (e.g. reverse_engineer), and any mismatch between
 * the stored class and a fresh live classification of the action.
 *
 * @param {string|null|undefined} storedClass - class attached at enqueue time.
 * @param {string} action - the raw command about to run.
 * @returns {{ok:boolean, code:string, reason:string, live:object}}
 */
export function evaluateApproval(storedClass, action) {
  const live = classifyCommand(action);

  if (!storedClass) {
    return { ok: false, code: 'missing_class', reason: 'missing execution class', live };
  }
  if (!Object.prototype.hasOwnProperty.call(EXECUTION_CLASSES, storedClass)) {
    return { ok: false, code: 'unknown_class', reason: `unknown execution class: ${storedClass}`, live };
  }
  if (storedClass === 'forbidden' || live.class === 'forbidden') {
    return {
      ok: false,
      code: 'forbidden_class',
      reason: `forbidden class (stored=${storedClass}, live=${live.class}): ${live.reason}`,
      live,
    };
  }
  if (!EXECUTION_CLASSES[storedClass].terminal || !live.terminal) {
    return {
      ok: false,
      code: 'non_terminal_class',
      reason: `non-terminal class may not execute (stored=${storedClass}, live=${live.class})`,
      live,
    };
  }
  if (storedClass !== live.class) {
    return {
      ok: false,
      code: 'class_mismatch',
      reason: `execution class mismatch: stored=${storedClass}, live=${live.class}`,
      live,
    };
  }
  return { ok: true, code: 'ok', reason: `class verified (${live.class})`, live };
}
