// tools/command-firewall.js
// ── Pass 18 · Action-Level Command Firewall ─────────────────────────────────
//
// PURPOSE
//   A conservative, content-aware denylist that inspects a shell command string
//   *immediately before execution* and refuses obviously dangerous actions even
//   after OURSELF has approved the proposal. It closes the second highest-risk
//   gap in the bridge: an approved command could previously contain ANY shell
//   content and run unrestricted inside the RUORA boundary.
//
// IMPORTANT — SCOPE & LIMITS
//   This is a GUARDRAIL, not a sandbox. It is a best-effort denylist of obvious
//   destructive / secret-reading / exfiltration / force-push / dangerous-perm /
//   shell-obfuscation patterns. A determined operator can craft a command that
//   evades any regex denylist. The real safety boundary remains:
//     1. OURSELF human approval (no command executes without it), and
//     2. the RUORA path boundary enforced in tools/terminal.js.
//   The firewall is an additional fail-closed layer on top of those, NOT a
//   replacement for them. Treat every "allowed" verdict as "not obviously
//   dangerous", never as "proven safe".
//
// CONTRACT
//   inspectCommand(action) -> {
//     allowed:  boolean,
//     pattern:  string|null,   // stable rule id, safe to log
//     category: string|null,   // rule category, safe to log
//     reason:   string|null,   // human-readable, safe to log (no secret values)
//   }
//   The matched rule id / category / reason never contain secret VALUES — only
//   the shape of the offending command — so they are safe to log.

/**
 * Normalize a command for matching:
 *   • collapse all runs of whitespace to single spaces
 *   • trim
 * The lower-cased form is used for case-insensitive matching; the original
 * (collapsed) form is preserved for rules that care about literal characters.
 */
function normalize(action) {
  const collapsed = String(action ?? '').replace(/\s+/g, ' ').trim();
  return { collapsed, lc: collapsed.toLowerCase() };
}

// A secret-bearing file/path fragment. Matches the PATH, never a secret value.
// The leading class also accepts curl/scp upload sigils (@, :, ,) so that forms
// like `curl -F file=@.env` and `scp host:.env` are caught.
const SECRET_FILE =
  /(^|[\s/="'`@:,])(\.env(\.[a-z0-9_-]+)?|id_rsa|id_dsa|id_ecdsa|id_ed25519|[\w.-]+\.pem|[\w.-]+\.key|[\w.-]+\.p12|[\w.-]+\.pfx|\.ssh\/[\w.-]*|\.aws\/credentials|\.netrc|\.npmrc|credentials(\.json)?|secrets?\.(json|ya?ml|env|txt))(\b|$)/i;

// Reader / copier / transport commands that could exfiltrate a secret file.
const FILE_READER =
  /\b(cat|bat|less|more|head|tail|nl|strings|xxd|od|hexdump|base64|cp|scp|rsync|sftp|grep|egrep|fgrep|awk|sed|vi|vim|nano|emacs|tee|pbcopy)\b/;

// Network egress tools.
const NET_TOOL = /\b(curl|wget|nc|ncat|netcat|telnet|ftp|tftp|socat)\b/;

/** True when an `rm` invocation carries both recursive and force semantics. */
function rmIsRecursiveForce(lc) {
  if (!/\brm\b/.test(lc)) return false;
  // Grab the contiguous run of flag tokens after `rm`.
  const m = lc.match(/\brm\b((?:\s+-{1,2}[a-z-]+)+)/);
  if (m) {
    const flags = m[1];
    const hasR = /r|recursive/.test(flags);
    const hasF = /f|force/.test(flags);
    if (hasR && hasF) return true;
  }
  // Common collapsed clusters that the token scan above may miss.
  return /\brm\b[^|&;]*\s-[a-z]*(rf|fr)\b/.test(lc);
}

/** True when the command targets root, home, or a bare wildcard. */
function hasCatastrophicTarget(lc) {
  return (
    /--no-preserve-root/.test(lc) ||
    /(^|\s|=)\/(\s|$)/.test(lc) ||        // a bare "/"
    /(^|\s|=)\/\*/.test(lc) ||            // "/*"
    /(^|\s)~(\/|\s|$)/.test(lc) ||        // "~" or "~/"
    /(^|\s)\$home\b/.test(lc) ||          // "$HOME"
    /(^|\s)\*(\s|$)/.test(lc) ||          // a bare "*"
    /(^|\s)\.\.(\/|\s|$)/.test(lc)        // parent-dir traversal target
  );
}

// ── Rule table ──────────────────────────────────────────────────────────────
// Each rule: { id, category, reason, test(lc, collapsed) -> boolean }.
// Order matters only for which id is reported first; all are fail-closed.
const RULES = [
  // 1 ── Destructive filesystem ──────────────────────────────────────────────
  {
    id: 'fs.rm_recursive_force_root',
    category: 'destructive_filesystem',
    reason: 'recursive force-delete targeting root, home, or a bare wildcard',
    test: (lc) => rmIsRecursiveForce(lc) && hasCatastrophicTarget(lc),
  },
  {
    id: 'fs.no_preserve_root',
    category: 'destructive_filesystem',
    reason: 'use of --no-preserve-root disables the kernel root-delete guard',
    test: (lc) => /--no-preserve-root/.test(lc),
  },
  {
    id: 'fs.disk_overwrite',
    category: 'destructive_filesystem',
    reason: 'raw disk / device overwrite (dd, mkfs, shred, or > /dev/<disk>)',
    test: (lc) =>
      /\bdd\b[^|&;]*\bof=\/dev\//.test(lc) ||
      /\bmkfs(\.\w+)?\b/.test(lc) ||
      /\bshred\b/.test(lc) ||
      />\s*\/dev\/(sd|disk|nvme|hd|rdisk)/.test(lc),
  },
  {
    id: 'fs.fork_bomb',
    category: 'destructive_filesystem',
    reason: 'shell fork bomb',
    test: (_lc, c) => /:\(\)\s*\{\s*:\s*\|\s*:?\s*&\s*\}\s*;\s*:/.test(c),
  },

  // 2 ── Secret reading ───────────────────────────────────────────────────────
  {
    id: 'secret.read_file',
    category: 'secret_read',
    reason: 'reads or copies a secret-bearing file (.env, *.pem, id_rsa, credentials, …)',
    test: (lc) => FILE_READER.test(lc) && SECRET_FILE.test(lc),
  },
  {
    id: 'secret.dump_env',
    category: 'secret_read',
    reason: 'dumps the full process environment (env / printenv) to a sink',
    test: (lc) =>
      /\b(env|printenv|set)\b[^|&;]*\|/.test(lc) && NET_TOOL.test(lc),
  },

  // 3 ── Secret exfiltration ──────────────────────────────────────────────────
  {
    id: 'secret.exfil_pipe',
    category: 'secret_exfiltration',
    reason: 'pipes secret material or environment into a network egress tool',
    test: (lc) => {
      const pipesToNet = /\|[^|]*$/.test(lc) && NET_TOOL.test(lc);
      const fromSecret =
        SECRET_FILE.test(lc) || /\b(env|printenv)\b/.test(lc) || /\bbase64\b/.test(lc);
      return pipesToNet && fromSecret && /\|/.test(lc);
    },
  },
  {
    id: 'secret.exfil_upload',
    category: 'secret_exfiltration',
    reason: 'uploads a secret-bearing file via curl/wget/scp/nc',
    test: (lc) =>
      (NET_TOOL.test(lc) || /\bscp\b/.test(lc)) &&
      /(-d\s*@|--data\S*\s*@|--data-binary\s*@|-t\s|--upload-file|-f\s|<\s*)/.test(lc) &&
      SECRET_FILE.test(lc),
  },

  // 4 ── Force push ───────────────────────────────────────────────────────────
  {
    id: 'git.force_push',
    category: 'force_push',
    reason: 'git push with --force / -f / --force-with-lease / +refspec (history overwrite)',
    test: (lc) =>
      /\bgit\b[^|&;]*\bpush\b/.test(lc) &&
      /(--force-with-lease|--force\b|\s-f\b|\s-[a-z]*f[a-z]*\b|\s\+[^\s:]+:[^\s]+)/.test(lc),
  },

  // 5 ── Dangerous permissions ────────────────────────────────────────────────
  {
    id: 'perm.world_writable',
    category: 'dangerous_permissions',
    reason: 'grants world-writable / all-permissions (chmod 777/666/+rwx or recursive)',
    test: (lc) =>
      /\bchmod\b[^|&;]*(\b777\b|\b666\b|\ba\+rwx\b|\bo\+rwx?\b|\+rwx\b)/.test(lc),
  },
  {
    id: 'perm.chown_root_recursive',
    category: 'dangerous_permissions',
    reason: 'recursive chown to root',
    test: (lc) => /\bchown\b[^|&;]*\s-{1,2}r[a-z]*\b[^|&;]*\broot\b/.test(lc),
  },

  // 6 ── Shell obfuscation / remote-code execution ────────────────────────────
  {
    id: 'obf.download_pipe_shell',
    category: 'shell_obfuscation',
    reason: 'pipes a download directly into a shell interpreter (curl|wget … | sh/bash)',
    test: (lc) =>
      /\b(curl|wget|fetch)\b[^|]*\|[^|]*\b(sh|bash|zsh|ksh|dash|python\d?|perl|ruby|node)\b/.test(lc),
  },
  {
    id: 'obf.process_substitution_exec',
    category: 'shell_obfuscation',
    reason: 'executes/sources a remote download via process substitution (bash <(curl …))',
    test: (lc) => /(<\(\s*(curl|wget|fetch)\b)/.test(lc),
  },
  {
    id: 'obf.command_substitution_net',
    category: 'shell_obfuscation',
    reason: 'command-substitution wrapping a network download ($(curl …) or `curl …`)',
    test: (_lc, c) =>
      /\$\(\s*(curl|wget|fetch)\b/i.test(c) || /`\s*(curl|wget|fetch)\b/i.test(c),
  },
  {
    id: 'obf.base64_decode_exec',
    category: 'shell_obfuscation',
    reason: 'decodes base64 and pipes the result into a shell interpreter',
    test: (lc) =>
      /\bbase64\b[^|]*(-d|--decode)[^|]*\|[^|]*\b(sh|bash|zsh|python\d?|perl|ruby|node)\b/.test(lc),
  },
  {
    id: 'obf.eval',
    category: 'shell_obfuscation',
    reason: 'use of eval (dynamic shell construction) — disallowed in approved actions',
    test: (lc) => /(^|[\s;&|(])eval\s+/.test(lc),
  },
  {
    id: 'obf.hex_escape',
    category: 'shell_obfuscation',
    reason: 'hex-escaped byte sequence (common command-obfuscation technique)',
    test: (_lc, c) => /(\\x[0-9a-f]{2}){3,}/i.test(c),
  },
];

/**
 * Inspect a command string against the conservative denylist.
 * @param {string} action - the raw shell command that is about to run.
 * @returns {{allowed:boolean, pattern:string|null, category:string|null, reason:string|null}}
 */
export function inspectCommand(action) {
  const { collapsed, lc } = normalize(action);

  if (collapsed.length === 0) {
    return {
      allowed: false,
      pattern: 'meta.empty_command',
      category: 'malformed',
      reason: 'empty command string',
    };
  }

  for (const rule of RULES) {
    let hit = false;
    try {
      hit = rule.test(lc, collapsed);
    } catch {
      // A rule that throws is treated as non-matching; never crash the firewall.
      hit = false;
    }
    if (hit) {
      return {
        allowed: false,
        pattern: rule.id,
        category: rule.category,
        reason: rule.reason,
      };
    }
  }

  return { allowed: true, pattern: null, category: null, reason: null };
}

// Exposed for tests / introspection. The ids are stable and safe to log.
export const FIREWALL_RULE_IDS = RULES.map((r) => r.id);

// ── Pass 20B · Firewall-by-Class enforcement ────────────────────────────────
//
// PURPOSE
//   Turn execution-class metadata into ACTIVE per-class enforcement at the point
//   of execution. classifyCommand() (tools/execution-classes.js) ASSIGNS a class
//   at enqueue/approve; enforceClassPolicy() independently re-verifies, at the
//   terminal, that the command SHAPE is permitted for the class it claims. Both
//   layers must agree or the command never reaches the shell.
//
// RELATION TO THE EXISTING DENYLIST
//   This is enforced BEFORE inspectCommand() in tools/terminal.js, but the
//   generic denylist still runs afterward as the always-on final fail-closed
//   backstop. A class policy is never weaker than the denylist: anything the
//   denylist forbids stays forbidden regardless of class.
//
// INDEPENDENCE (deliberate)
//   The class-shape rules below are a SECOND, independent implementation of the
//   command shapes — they do NOT import execution-classes.js. That keeps the
//   module dependency a clean DAG (execution-classes → command-firewall) and
//   gives defense-in-depth: a drift between classifier and policy surfaces as a
//   refusal, never as a silent allow.
//
// CONTRACT
//   enforceClassPolicy(action, executionClass) -> {allowed, pattern, category, reason}
//   Returned fields describe the SHAPE only — safe to log, never a secret value.

const RUORA_BOUNDARY = '/Users/millysituated/RUORA';

// Classes that may reach the shell. forbidden + reverse_engineer (and any
// unknown class string) are intentionally absent — they never execute.
const CLASS_TERMINAL = new Set([
  'inspect', 'test', 'build', 'git-read', 'git-write-local', 'project-mutation',
]);

// Network egress / remote transport (broader than NET_TOOL: adds scp/ssh/rsync).
const CLASS_NET = /\b(curl|wget|nc|ncat|netcat|telnet|ftp|tftp|socat|scp|sftp|ssh|rsync)\b/;

// Filesystem-mutating verbs.
const MUTATE_VERB = /\b(rm|rmdir|mv|cp|tee|truncate|dd|shred|unlink|ln|chmod|chown|mkdir|touch)\b|\bsed\b[^|&;]*\s-i\b/;

// Deploy / publish / remote-upload shapes (forbidden for test/build/inspect/projmut).
const PUBLISH_RE =
  /\b(deploy|publish|release)\b|\bnpm\b[^|&;]*\bpublish\b|\bgit\b[^|&;]*\bpush\b|\bgh\b|\b(vercel|netlify|surge|firebase|gh-pages)\b/;

// Append-only audit logs.
const LOG_TARGET = /(transmissions\.jsonl|queue\.jsonl|logs[/][\w.-]*\.jsonl)/i;

// Test / verification runners.
const TEST_RE =
  /\b(npm|pnpm|yarn)\b\s+(run\s+)?(test|t)\b|\bnode\b[^|&;]*--(test|check)\b|\b(pytest|jest|vitest|mocha|ava|tap)\b/;

// Build / dependency / compile.
const BUILD_RE =
  /\b(npm|pnpm|yarn)\b\s+(ci|install|i|build|start|run\b[^|&;]*)\b|\bmake\b|\btsc\b|\b(vite|webpack|rollup|esbuild|parcel|babel)\b/;

// Read-only inspection (first token).
const INSPECT_CMDS = new Set([
  'ls', 'pwd', 'cat', 'bat', 'head', 'tail', 'wc', 'find', 'tree', 'stat',
  'file', 'du', 'df', 'echo', 'which', 'type', 'whoami', 'date', 'realpath',
  'dirname', 'basename', 'readlink', 'hostname', 'uname', 'less', 'more', 'nl',
  'column', 'sort', 'uniq', 'cut', 'grep', 'egrep', 'fgrep', 'rg', 'jq', 'sleep',
  'true', 'printf', 'diff', 'cmp', 'md5', 'shasum', 'sha256sum',
]);

// Git subcommand sets.
const GIT_NETWORK = new Set(['push', 'pull', 'fetch', 'clone', 'remote', 'submodule']);
const GIT_READ_SUBS = new Set([
  'status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'blame',
  'describe', 'cat-file', 'shortlog', 'reflog', 'rev-list', 'for-each-ref',
  'show-ref', 'whatchanged', 'name-rev', 'count-objects', 'verify-commit',
  'version', 'grep',
]);
const GIT_WRITE_LOCAL_SUBS = new Set([
  'add', 'commit', 'merge', 'reset', 'restore', 'checkout', 'switch', 'branch',
  'tag', 'stash', 'rm', 'mv', 'cherry-pick', 'rebase', 'revert', 'clean',
  'init', 'apply', 'am', 'gc', 'config', 'worktree',
]);

function deny(pattern, category, reason) {
  return { allowed: false, pattern, category, reason };
}
const ALLOW = Object.freeze({ allowed: true, pattern: null, category: null, reason: null });

function firstToken(lc) {
  const m = lc.match(/^(?:[a-z_][a-z0-9_]*=[^\s]*\s+)*([^\s]+)/);
  let tok = m ? m[1] : lc.split(' ')[0] || '';
  if (tok.includes('/')) tok = tok.slice(tok.lastIndexOf('/') + 1);
  return tok;
}

function gitSubcommand(lc) {
  const after = lc.replace(/^.*?\bgit\b\s*/, '');
  const tokens = after.split(' ').filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '-c' || t === '-C') { i++; continue; }
    if (t.startsWith('-')) continue;
    return t.replace(/[^a-z-]/g, '');
  }
  return null;
}

function hasWriteRedirection(s) {
  return /(?:^|\s)\d?>{1,2}\s*[^&\s]/.test(s); // excludes 2>&1
}

function hasTraversalOrOutsideBoundary(s) {
  if (/(^|[\s/="'`(])\.\.(\/|\s|$)/.test(s)) return true;
  if (/(^|\s)~(\/|\s|$)/.test(s)) return true;
  const matches = s.match(/(^|[\s="'`(:])(\/[^\s"'`):]*)/g) || [];
  for (const raw of matches) {
    const p = raw.replace(/^[\s="'`(:]+/, '');
    if (!p.startsWith('/')) continue;
    if (p === '/') return true;
    if (!(p === RUORA_BOUNDARY || p.startsWith(RUORA_BOUNDARY + '/'))) return true;
  }
  return false;
}

const isGit = (lc) => /(^|[\s;&|(])git\b/.test(lc);

/** True when a `git branch` invocation carries a non-flag arg (create/rename) or a mutating flag. */
function branchHasMutation(lc) {
  if (/-(d|D|m|M|c|C)\b|--(delete|move|copy|edit-description|set-upstream-to|unset-upstream|force)\b/.test(lc)) return true;
  const after = lc.replace(/^.*\bbranch\b/, '').trim();
  return after.split(' ').filter(Boolean).some((t) => !t.startsWith('-'));
}

/** Read-only git: explicit read family, plus listing forms of branch / worktree. */
function gitReadAllowed(sub, lc) {
  if (!sub) return false;
  if (GIT_READ_SUBS.has(sub)) return true;
  if (sub === 'branch') return !branchHasMutation(lc);
  if (sub === 'worktree') return /\bworktree\b\s+list\b/.test(lc);
  return false;
}

// ── Per-class shape policies ─────────────────────────────────────────────────
function policyInspect(lc, c) {
  if (hasWriteRedirection(c)) return deny('inspect.redirection', 'class_policy', 'inspect may not write output to a file');
  if (MUTATE_VERB.test(lc)) return deny('inspect.mutation', 'class_policy', 'inspect may not run a mutating command');
  if (CLASS_NET.test(lc)) return deny('inspect.network', 'class_policy', 'inspect may not use network tools');
  if (isGit(lc)) return deny('inspect.git', 'class_policy', 'inspect may not run git (use git-read)');
  if (PUBLISH_RE.test(lc)) return deny('inspect.publish', 'class_policy', 'inspect may not deploy/publish');
  const first = firstToken(lc);
  if (!INSPECT_CMDS.has(first)) return deny('inspect.not_readonly', 'class_policy', `'${first}' is not a recognized read-only command`);
  return ALLOW;
}

function policyTest(lc, _c) {
  if (CLASS_NET.test(lc)) return deny('test.network', 'class_policy', 'test may not use network tools');
  if (/\|\s*(sh|bash|zsh|ksh|dash|node|python\d?|perl|ruby)\b/.test(lc)) return deny('test.shell_pipe', 'class_policy', 'test may not pipe into a shell interpreter');
  if (PUBLISH_RE.test(lc)) return deny('test.publish', 'class_policy', 'test may not deploy/publish');
  if (!TEST_RE.test(lc)) return deny('test.not_test', 'class_policy', 'test may run only test/check runners');
  return ALLOW;
}

function policyBuild(lc, _c) {
  if (CLASS_NET.test(lc)) return deny('build.network', 'class_policy', 'build may not use network egress tools');
  if (PUBLISH_RE.test(lc)) return deny('build.publish', 'class_policy', 'build may not deploy/publish/upload');
  if (!BUILD_RE.test(lc)) return deny('build.not_build', 'class_policy', 'build may run only local build/dependency commands');
  return ALLOW;
}

function policyGitRead(lc, c) {
  if (!isGit(lc)) return deny('gitread.not_git', 'class_policy', 'git-read requires a git command');
  if (hasWriteRedirection(c)) return deny('gitread.redirection', 'class_policy', 'git-read may not redirect output to a file');
  const sub = gitSubcommand(lc);
  if (sub && GIT_NETWORK.has(sub)) return deny('gitread.network', 'class_policy', `git-read may not run network/remote git (${sub})`);
  if (!gitReadAllowed(sub, lc)) return deny('gitread.not_read', 'class_policy', `git-read permits only read-only git (got '${sub ?? 'none'}')`);
  return ALLOW;
}

function policyGitWriteLocal(lc, _c) {
  if (!isGit(lc)) return deny('gitwrite.not_git', 'class_policy', 'git-write-local requires a local git command');
  if (PUBLISH_RE.test(lc)) return deny('gitwrite.publish', 'class_policy', 'git-write-local may not push/publish/deploy');
  const sub = gitSubcommand(lc);
  if (!sub || GIT_NETWORK.has(sub)) return deny('gitwrite.network', 'class_policy', `git-write-local may not run remote/network git (${sub ?? 'none'})`);
  if (!GIT_WRITE_LOCAL_SUBS.has(sub)) return deny('gitwrite.not_allowed', 'class_policy', `git subcommand '${sub}' is not a permitted local mutation`);
  return ALLOW;
}

function policyProjectMutation(lc, c) {
  if (SECRET_FILE.test(c)) return deny('projmut.secret', 'class_policy', 'project-mutation may not touch secret-bearing files (.env/*.pem/credentials/…)');
  if (LOG_TARGET.test(lc)) return deny('projmut.logs', 'class_policy', 'project-mutation may not touch audit logs');
  if (hasTraversalOrOutsideBoundary(c)) return deny('projmut.outside', 'class_policy', 'project-mutation may not target paths outside the RUORA boundary');
  if (CLASS_NET.test(lc)) return deny('projmut.network', 'class_policy', 'project-mutation may not use network egress tools');
  if (PUBLISH_RE.test(lc)) return deny('projmut.publish', 'class_policy', 'project-mutation may not publish/deploy');
  if (isGit(lc)) return deny('projmut.git', 'class_policy', 'project-mutation may not run git (use git-read/git-write-local)');
  return ALLOW;
}

/**
 * Enforce the per-class command-shape policy. Fail-closed for missing, unknown,
 * non-terminal (forbidden / reverse_engineer), and any command whose shape is
 * not permitted for the claimed class.
 * @param {string} action
 * @param {string} executionClass
 * @returns {{allowed:boolean, pattern:string|null, category:string|null, reason:string|null}}
 */
export function enforceClassPolicy(action, executionClass) {
  const { collapsed, lc } = normalize(action);

  if (!executionClass) return deny('class.missing', 'execution_class', 'no execution class supplied to the executor');
  if (!CLASS_TERMINAL.has(executionClass)) {
    return deny('class.non_terminal', 'execution_class', `class '${executionClass}' may never reach the shell`);
  }
  if (collapsed.length === 0) return deny('class.empty', 'malformed', 'empty command');

  switch (executionClass) {
    case 'inspect':          return policyInspect(lc, collapsed);
    case 'test':             return policyTest(lc, collapsed);
    case 'build':            return policyBuild(lc, collapsed);
    case 'git-read':         return policyGitRead(lc, collapsed);
    case 'git-write-local':  return policyGitWriteLocal(lc, collapsed);
    case 'project-mutation': return policyProjectMutation(lc, collapsed);
    default:                 return deny('class.unhandled', 'execution_class', `unhandled class '${executionClass}'`);
  }
}

// Exposed for tests / introspection. Safe to log.
export const CLASS_POLICY_TERMINAL_CLASSES = Object.freeze([...CLASS_TERMINAL]);
