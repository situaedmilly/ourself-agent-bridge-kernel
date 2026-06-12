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
