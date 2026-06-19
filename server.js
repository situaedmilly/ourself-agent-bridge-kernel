import 'dotenv/config';
import express from 'express';
import { timingSafeEqual, randomBytes } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { appendFile, readFile } from 'fs/promises';
import { callClaude } from './agents/claude-agent.js';
import { callOpenAI } from './agents/openai-agent.js';
import { executeCommand } from './tools/terminal.js';
import { classifyCommand, evaluateApproval } from './tools/execution-classes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;
// ── Pass 15: localhost-only binding ─────────────────────────────────────────
// The operator chamber is never exposed to the public network. Bind to the
// loopback interface unless an operator explicitly overrides BIND_HOST.
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';
// ── Pass 20: test-isolation seam ────────────────────────────────────────────
// Log paths are env-overridable ONLY so the security regression harness can
// redirect a disposable bridge to a temp directory. When these env vars are
// unset (production), the defaults are byte-identical to before.
const LOG_PATH = process.env.BRIDGE_LOG_PATH || join(__dirname, 'logs', 'transmissions.jsonl');
const QUEUE_LOG_PATH = process.env.BRIDGE_QUEUE_PATH || join(__dirname, 'logs', 'queue.jsonl');
const QUEUE_EXPIRY_HOURS = Number(process.env.QUEUE_EXPIRY_HOURS ?? 24);

// ── Pass 13 constants ───────────────────────────────────────────────────────
// Maximum continuation rounds before the loop is hard-stopped.
const MAX_CONTINUATION_DEPTH = 8;
// Maximum characters of stdout or stderr sent back to an agent.
// Payload beyond this limit is truncated and explicitly marked.
const MAX_PROOF_PAYLOAD_CHARS = 4000;

// Startup environment check — warn on missing keys, don't crash
const missingEnv = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'].filter(k => !process.env[k]);
if (missingEnv.length > 0) {
  console.warn(`⚠  Missing environment variables: ${missingEnv.join(', ')}`);
  console.warn('   Copy .env.example to .env and fill in your API keys.');
  console.warn('   Calls to those agents will fail until keys are present.\n');
}

// ── Pass 18: Authenticated Realm Gate — fail closed on startup ───────────────
// The bridge refuses to start without an authentication token. This is a hard
// security boundary: an unauthenticated bridge exposes state-changing routes
// (/transmit, /approve, /reject, /test) to anyone who can reach the port.
// The token is read from the gitignored .env and is NEVER printed or embedded
// in any HTTP response or HTML page.
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN;
if (!BRIDGE_TOKEN || BRIDGE_TOKEN.trim().length === 0) {
  console.error('\n✗ FATAL — BRIDGE_TOKEN is not set (fail-closed).');
  console.error('  The ÆTHERNET Agent Bridge will not start without an auth token.');
  console.error('  Generate one (its value is never printed) with:');
  console.error('      npm run setup');
  console.error('  The token is read from the gitignored .env file and sent by');
  console.error('  callers in the  x-ourself-token  request header.\n');
  process.exit(1);
}

// ── Pass 19C: Realm Gate failure rate limiting ──────────────────────────────
// Defense-in-depth against brute-force guessing of the token. FAILED attempts
// from a client are counted; once they reach the threshold within a window the
// client is locked out (HTTP 429 + Retry-After) for a cooldown period. A VALID
// token is NEVER rate-limited — it always passes and clears the client's
// failure record, so the rightful operator can never be locked out by an
// attacker spamming wrong tokens. Thresholds are env-overridable for tests;
// production defaults are conservative. The presented (wrong) token value is
// NEVER logged — only the client key and counts.
const RL_MAX_FAILURES = Number(process.env.REALM_GATE_MAX_FAILURES ?? 10);
const RL_WINDOW_MS = Number(process.env.REALM_GATE_WINDOW_MS ?? 60_000);
const RL_LOCKOUT_MS = Number(process.env.REALM_GATE_LOCKOUT_MS ?? 300_000);
const realmFailures = new Map(); // clientKey -> { count, windowStart, lockedUntil }

function clientKey(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/**
 * Token middleware for state-changing routes.
 * Accepts the token ONLY via the x-ourself-token header. Uses a constant-time
 * comparison to avoid leaking length/equality timing. Fails closed with 401,
 * and rate-limits repeated failures with 429 (Pass 19C). A valid token always
 * passes and resets the client's failure record.
 */
function requireToken(req, res, next) {
  const key = clientKey(req);
  const now = Date.now();

  // Constant-time validity check (unchanged behavior for a valid token).
  const presented = req.headers['x-ourself-token'];
  const hasHeader = typeof presented === 'string' && presented.length > 0;
  let valid = false;
  if (hasHeader) {
    const a = Buffer.from(presented);
    const b = Buffer.from(BRIDGE_TOKEN);
    valid = a.length === b.length && timingSafeEqual(a, b);
  }

  if (valid) {
    realmFailures.delete(key);   // success clears any accumulated failures
    return next();
  }

  // ── Failure path ──────────────────────────────────────────────────────────
  let rec = realmFailures.get(key);

  // Already locked out → 429 without further token work.
  if (rec && rec.lockedUntil > now) {
    res.set('Retry-After', String(Math.ceil((rec.lockedUntil - now) / 1000)));
    return res.status(429).json({ error: 'Too many failed authentication attempts. Locked out.' });
  }

  // Start a fresh window if none or the previous one has elapsed.
  if (!rec || now - rec.windowStart > RL_WINDOW_MS) {
    rec = { count: 0, windowStart: now, lockedUntil: 0 };
  }
  rec.count += 1;

  if (rec.count >= RL_MAX_FAILURES) {
    rec.lockedUntil = now + RL_LOCKOUT_MS;
    realmFailures.set(key, rec);
    // Audit the lockout WITHOUT the presented token value.
    console.warn(`⛔ REALM GATE LOCKOUT — key=${key} after ${rec.count} failed attempts; locked ${RL_LOCKOUT_MS}ms.`);
    res.set('Retry-After', String(Math.ceil(RL_LOCKOUT_MS / 1000)));
    return res.status(429).json({ error: 'Too many failed authentication attempts. Locked out.' });
  }

  realmFailures.set(key, rec);
  return res.status(401).json({
    error: hasHeader ? 'Unauthorized — invalid token.' : 'Unauthorized — missing x-ourself-token header.',
  });
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ── Pass 15: hardened local response headers ────────────────────────────────
// Applied to every response. These do not weaken any Pass 18 authority gate;
// they only reduce caching/embedding/leakage surface for the local chamber.
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  next();
});

// In-memory pending command queue — keyed by command ID
const pending = new Map();

function generateId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function log(entry) {
  const line = JSON.stringify({ ...entry, logged_at: new Date().toISOString() }) + '\n';
  await appendFile(LOG_PATH, line).catch(() => {});
}

async function logQueue(entry) {
  const line = JSON.stringify({ ...entry, logged_at: new Date().toISOString() }) + '\n';
  await appendFile(QUEUE_LOG_PATH, line).catch(() => {});
}

function logCommandProposed(cmd) {
  return logQueue({
    type: 'command_proposed',
    id: cmd.id,
    txId: cmd.txId,
    from: cmd.from,
    to: cmd.to,
    action: cmd.action,
    workingDir: cmd.workingDir,
    rationale: cmd.rationale,
    proposedAt: cmd.proposedAt,
    continuationDepth: cmd.continuationDepth ?? 0,
    parentCmdId: cmd.parentCmdId ?? null,
    // Pass 20A — typed execution class + risk (shape only, never secrets).
    executionClass: cmd.executionClass ?? null,
    execution_class: cmd.executionClass ?? null,
    risk: cmd.risk ?? null,
  });
}

function printPendingAlert(cmd) {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('⚡ COMMAND PENDING — OURSELF APPROVAL REQUIRED');
  console.log(`   ID:        ${cmd.id}`);
  console.log(`   Action:    ${cmd.action}`);
  console.log(`   Dir:       ${cmd.workingDir}`);
  console.log(`   Rationale: ${cmd.rationale}`);
  // Pass 18 — approval is now authenticated and terminal-only. Browser form
  // POSTs cannot carry the x-ourself-token header, so the curl form below is
  // the canonical approval path. $OURSELF_TOKEN is read from the operator's
  // shell env; the real token value is never printed by the bridge.
  console.log(`   Approve:   curl -X POST -H "x-ourself-token: $OURSELF_TOKEN" http://localhost:${PORT}/approve/${cmd.id}`);
  console.log(`   Reject:    curl -X POST -H "x-ourself-token: $OURSELF_TOKEN" http://localhost:${PORT}/reject/${cmd.id}`);
  console.log(`   Review:    http://localhost:${PORT}/pending  (display-only)`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

// ── Pass 13: Bounded proof-return continuation ──────────────────────────────

/**
 * Safely truncate a proof payload string.
 * Marks the truncation point explicitly so the agent knows it received partial output.
 */
function truncateProof(text, label) {
  if (!text || text.length === 0) return '(empty)';
  if (text.length <= MAX_PROOF_PAYLOAD_CHARS) return text;
  return (
    text.slice(0, MAX_PROOF_PAYLOAD_CHARS) +
    `\n[TRUNCATED — ${label} exceeded ${MAX_PROOF_PAYLOAD_CHARS} chars]`
  );
}

/**
 * After an approved command executes (or fails), return a bounded proof message
 * to the originating agent, log its continuation response, and — if it proposes
 * a next command — queue that command for OURSELF approval without executing it.
 *
 * Invariants upheld:
 *   • Never auto-approves or auto-executes any command.
 *   • Stops at MAX_CONTINUATION_DEPTH.
 *   • Every proposed next command enters the pending queue exactly as a fresh proposal.
 *   • All continuation activity is persisted to the append-only log.
 *
 * @param {object} cmd - The completed (executed or failed) command entry from `pending`.
 */
async function continueAgentWithExecutionProof(cmd) {
  const depth = cmd.continuationDepth ?? 0;

  // Hard depth guard — stop before calling the agent
  if (depth >= MAX_CONTINUATION_DEPTH) {
    await log({
      type: 'continuation_depth_limit',
      cmdId: cmd.id,
      txId: cmd.txId,
      agent: cmd.to,
      depth,
      maxDepth: MAX_CONTINUATION_DEPTH,
    });
    console.log(
      `\n⚠  CONTINUATION DEPTH LIMIT (${MAX_CONTINUATION_DEPTH}) reached for ${cmd.id} — no further relay.`
    );
    return;
  }

  const status = cmd.status;           // 'executed' | 'failed'
  const result = cmd.result ?? {};
  const errorMsg = cmd.error ?? null;

  const stdout = truncateProof(result.stdout ?? '', 'stdout');
  const stderr = truncateProof(result.stderr ?? errorMsg ?? '', 'stderr/error');
  const executedAt = result.executedAt ?? cmd.approvedAt ?? new Date().toISOString();

  const proofMessage = [
    'EXECUTION PROOF — PASS 13 BOUNDED CONTINUATION',
    '',
    `Transmission ID  : ${cmd.txId}`,
    `Command ID       : ${cmd.id}`,
    `Originating agent: ${cmd.to}`,
    `Action executed  : ${cmd.action}`,
    `Working directory: ${cmd.workingDir}`,
    `Execution status : ${status}`,
    `Executed at      : ${executedAt}`,
    '',
    'STDOUT:',
    stdout,
    '',
    'STDERR / ERROR:',
    stderr,
    '',
    'CONTINUATION INSTRUCTIONS:',
    'You may analyze this proof and propose at most ONE next command via propose_terminal_command.',
    'No command may execute without OURSELF (Philosopher Milly) explicit approval.',
    'If no further action is required, respond with your analysis only — no command proposal.',
    `Continuation depth: ${depth + 1} of ${MAX_CONTINUATION_DEPTH} (hard limit).`,
  ].join('\n');

  // Call the originating agent with the proof
  let agentResult;
  try {
    agentResult =
      cmd.to === 'claude'
        ? await callClaude(proofMessage, { continuationDepth: depth + 1 })
        : await callOpenAI(proofMessage, { continuationDepth: depth + 1 });
  } catch (err) {
    await log({
      type: 'continuation_error',
      cmdId: cmd.id,
      txId: cmd.txId,
      agent: cmd.to,
      error: err.message,
    });
    console.log(`\n✗ PROOF-RETURN ERROR for ${cmd.id}: ${err.message}`);
    return;
  }

  const { response, commandProposal } = agentResult;

  // Persist the continuation response as a distinct audit entry
  const contLogId = generateId('cont');
  await log({
    id: contLogId,
    type: 'agent_continuation',
    cmdId: cmd.id,
    txId: cmd.txId,
    agent: cmd.to,
    continuationDepth: depth + 1,
    response,
    command_proposed: commandProposal != null,
    tokens: {
      input: agentResult.inputTokens ?? agentResult.promptTokens,
      output: agentResult.outputTokens ?? agentResult.completionTokens,
    },
  });

  console.log(`\n📨 CONTINUATION RESPONSE received from ${cmd.to} (depth ${depth + 1}):`);
  if (response && response !== '(no text response)') {
    console.log(`   ${response.slice(0, 200)}${response.length > 200 ? '…' : ''}`);
  }

  if (!commandProposal) {
    console.log(`   → No command proposed. Continuation complete.\n`);
    return;
  }

  // Validate the proposed command structure before queuing
  if (!commandProposal.action || !commandProposal.working_dir) {
    await log({
      type: 'continuation_invalid_proposal',
      cmdId: cmd.id,
      txId: cmd.txId,
      agent: cmd.to,
      proposal: commandProposal,
      reason: 'Missing required field: action or working_dir',
    });
    console.log(`\n⚠  INVALID CONTINUATION PROPOSAL from ${cmd.to} — missing action or working_dir. Discarded.\n`);
    return;
  }

  // Add the next proposed command to the pending queue — do NOT execute it.
  // OURSELF must approve before any execution occurs.
  const nextCmdId = generateId('cmd');
  const nextClass = classifyCommand(commandProposal.action);
  const nextCmd = {
    id: nextCmdId,
    txId: cmd.txId,
    from: cmd.to,
    to: cmd.to,
    action: commandProposal.action,
    workingDir: commandProposal.working_dir,
    rationale: commandProposal.rationale || '(no rationale provided)',
    proposedAt: new Date().toISOString(),
    status: 'pending',
    continuationDepth: depth + 1,
    parentCmdId: cmd.id,
    // Pass 20A — classify at enqueue; enforced (re-classified) at /approve.
    executionClass: nextClass.class,
    risk: nextClass.risk,
    classRationale: nextClass.reason,
  };
  pending.set(nextCmdId, nextCmd);
  logCommandProposed(nextCmd).catch(() => {});
  printPendingAlert(nextCmd);
  console.log(`   → Command queued as ${nextCmdId} — awaiting OURSELF approval.\n`);
}

// ── Routes ─────────────────────────────────────────────────────────────────

// POST /transmit — send a message to an agent  (token-gated)
app.post('/transmit', requireToken, async (req, res) => {
  const { from = 'user', to, message, context = {} } = req.body;

  if (!to || !message) {
    return res.status(400).json({ error: '"to" and "message" are required.' });
  }
  if (!['claude', 'openai'].includes(to)) {
    return res.status(400).json({ error: '"to" must be "claude" or "openai".' });
  }

  const txId = generateId('tx');

  let agentResult;
  try {
    agentResult = to === 'claude'
      ? await callClaude(message, context)
      : await callOpenAI(message, context);
  } catch (err) {
    await log({ id: txId, type: 'transmission_error', from, to, message, error: err.message });
    return res.status(500).json({ error: `Agent error: ${err.message}` });
  }

  const { response, commandProposal } = agentResult;

  let pendingEntry = null;
  if (commandProposal) {
    const cmdId = generateId('cmd');
    const propClass = classifyCommand(commandProposal.action);
    pendingEntry = {
      id: cmdId,
      txId,
      from,
      to,
      action: commandProposal.action,
      workingDir: commandProposal.working_dir,
      rationale: commandProposal.rationale || '(no rationale provided)',
      proposedAt: new Date().toISOString(),
      status: 'pending',
      continuationDepth: 0,   // Pass 13: depth counter starts at 0 for every new transmission
      // Pass 20A — classify at enqueue; enforced (re-classified) at /approve.
      executionClass: propClass.class,
      risk: propClass.risk,
      classRationale: propClass.reason,
    };
    pending.set(cmdId, pendingEntry);
    logCommandProposed(pendingEntry).catch(() => {});
    printPendingAlert(pendingEntry);
  }

  await log({
    id: txId,
    type: 'transmission',
    from,
    to,
    message,
    response,
    command_proposed: pendingEntry?.id ?? null,
    status: pendingEntry ? 'pending_approval' : 'completed',
    tokens: { input: agentResult.inputTokens ?? agentResult.promptTokens, output: agentResult.outputTokens ?? agentResult.completionTokens },
  });

  res.json({
    transmission_id: txId,
    from,
    to,
    response,
    command_proposed: pendingEntry,
    status: pendingEntry ? 'pending_approval' : 'completed',
  });
});

// GET /pending — OURSELF approval interface (auto-refreshes every 5s)
app.get('/pending', (req, res) => {
  const cmds = [...pending.values()].filter(c => c.status === 'pending');

  // ── Pass 18: display-only approval gate ─────────────────────────────────────
  // Browser <form> POSTs cannot attach the required x-ourself-token header, so
  // the interactive APPROVE/REJECT buttons were removed. This page now DISPLAYS
  // pending commands and the exact authenticated terminal command to act on each
  // one. The real token is NEVER embedded here — callers substitute their own
  // $OURSELF_TOKEN shell variable.
  const rows = cmds.length === 0
    ? '<p style="color:#555;font-style:italic;">No commands pending approval.</p>'
    : cmds.map(c => `
      <div style="border:1px solid #333;border-left:3px solid #c9a84c;padding:16px;margin-bottom:16px;border-radius:4px;background:#111;">
        <div style="font-family:monospace;font-size:10px;color:#555;letter-spacing:.1em;margin-bottom:6px;">${escapeHtml(c.id)} · proposed ${escapeHtml(c.proposedAt)}</div>
        <div style="font-family:monospace;font-size:15px;color:#e8e8e8;margin:6px 0;">$ ${escapeHtml(c.action)}</div>
        <div style="font-size:12px;color:#666;margin-bottom:3px;">Dir: ${escapeHtml(c.workingDir)}</div>
        <div style="font-size:13px;color:#999;margin-bottom:14px;line-height:1.5;">Rationale: ${escapeHtml(c.rationale)}</div>
        <div style="font-size:11px;color:#4a9960;font-family:monospace;background:#0c140f;border:1px solid #1d3326;padding:8px 10px;border-radius:3px;margin-bottom:6px;white-space:pre-wrap;word-break:break-all;">curl -X POST -H "x-ourself-token: $OURSELF_TOKEN" http://localhost:${PORT}/approve/${escapeHtml(c.id)}</div>
        <div style="font-size:11px;color:#b06060;font-family:monospace;background:#140c0c;border:1px solid #331d1d;padding:8px 10px;border-radius:3px;white-space:pre-wrap;word-break:break-all;">curl -X POST -H "x-ourself-token: $OURSELF_TOKEN" http://localhost:${PORT}/reject/${escapeHtml(c.id)}</div>
      </div>
    `).join('');

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>ÆTHERNET Agent Bridge — Approval Gate</title>
  <meta http-equiv="refresh" content="5">
  <style>
    body{background:#0a0a0a;color:#e8e8e8;font-family:Georgia,serif;max-width:720px;margin:48px auto;padding:0 24px;}
    h1{font-family:monospace;color:#c9a84c;letter-spacing:.2em;font-size:16px;margin-bottom:4px;}
    .sub{font-family:monospace;font-size:10px;color:#444;letter-spacing:.12em;margin-bottom:32px;}
    a{color:#8a6f2e;font-family:monospace;font-size:11px;text-decoration:none;}
  </style>
</head>
<body>
  <h1>ÆTHERNET AGENT BRIDGE</h1>
  <div class="sub">OURSELF APPROVAL GATE · DISPLAY-ONLY · Auto-refreshes every 5s · ${cmds.length} pending</div>
  <p style="font-size:12px;color:#777;line-height:1.6;border:1px solid #1a1a1a;background:#0c0c0c;padding:12px 14px;border-radius:4px;">
    Approval is authenticated and terminal-only. Set your token once per shell with
    <span style="font-family:monospace;color:#c9a84c;">export OURSELF_TOKEN=…</span>
    (read from your gitignored <span style="font-family:monospace;">.env</span>), then run the
    <span style="color:#4a9960;">approve</span> or <span style="color:#b06060;">reject</span>
    command shown beneath each pending action. The token is never displayed on this page.
  </p>
  ${rows}
  <p style="margin-top:40px;border-top:1px solid #1a1a1a;padding-top:16px;">
    <a href="/log">View transmission log →</a>
  </p>
</body>
</html>`);
});

// POST /approve/:id  (token-gated)
app.post('/approve/:id', requireToken, async (req, res) => {
  const cmd = pending.get(req.params.id);
  if (!cmd) return res.status(404).json({ error: 'Command not found.' });
  if (cmd.status !== 'pending') return res.status(409).json({ error: `Command is already ${cmd.status}.` });

  cmd.status = 'approved';
  cmd.approvedAt = new Date().toISOString();

  console.log(`\n✓ APPROVED: ${cmd.id}`);
  console.log(`  $ ${cmd.action}`);

  // ── Pass 20A: execution-class gate — re-classify BEFORE execution ──────────
  // Even an OURSELF-approved command is refused if its stored class is missing,
  // unknown, forbidden, non-terminal (e.g. reverse_engineer), or no longer
  // matches a fresh live classification of the action. Fail closed: the command
  // is recorded as `failed` and the executor (and its firewall) is never reached.
  // The verdict logs the class/risk/code — never the secret-bearing internals.
  const gate = evaluateApproval(cmd.executionClass, cmd.action);
  if (!gate.ok) {
    cmd.status = 'failed';
    cmd.error = `Execution-class gate refused: ${gate.reason}`;
    cmd.executionClassDenied = gate.code;
    pending.set(cmd.id, cmd);

    console.warn(
      `⛔ EXECUTION-CLASS DENIED — code=${gate.code} stored=${cmd.executionClass ?? '(none)'} live=${gate.live.class}; not executed.`
    );

    await log({
      id: cmd.id,
      type: 'command_result',
      txId: cmd.txId,
      action: cmd.action,
      workingDir: cmd.workingDir,
      approved_by: 'ourself',
      status: 'failed',
      result: null,
      error: cmd.error,
      continuationDepth: cmd.continuationDepth ?? 0,
      executionClass: cmd.executionClass ?? null,
      execution_class: cmd.executionClass ?? null,
      liveExecutionClass: gate.live.class,
      risk: gate.live.risk,
      executionClassDenied: gate.code,
    });

    const wantHtmlDenied = (req.headers.accept || '').includes('text/html');
    if (wantHtmlDenied) return res.redirect('/pending');
    return res.status(403).json({
      id: cmd.id,
      status: 'failed',
      error: cmd.error,
      executionClassDenied: gate.code,
    });
  }

  let result;
  try {
    // Pass 20B — pass the validated execution class into the executor so the
    // terminal enforces the per-class command-shape policy before any shell runs.
    result = await executeCommand(cmd.action, cmd.workingDir, cmd.executionClass);
    cmd.status = 'executed';
    cmd.result = result;
    console.log(`✓ EXECUTED: ${cmd.id}  [class=${cmd.executionClass} risk=${cmd.risk ?? gate.live.risk}]`);
    if (result.stdout) console.log(`  stdout:\n${result.stdout}`);
    if (result.stderr) console.log(`  stderr:\n${result.stderr}`);
  } catch (err) {
    cmd.status = 'failed';
    cmd.error = err.message;
    console.log(`✗ FAILED: ${cmd.id} — ${err.message}`);
  }

  pending.set(cmd.id, cmd);

  await log({
    id: cmd.id,
    type: 'command_result',
    txId: cmd.txId,
    action: cmd.action,
    workingDir: cmd.workingDir,
    approved_by: 'ourself',
    status: cmd.status,
    result: cmd.result ?? null,
    error: cmd.error ?? null,
    continuationDepth: cmd.continuationDepth ?? 0,
    executionClass: cmd.executionClass ?? null,
    execution_class: cmd.executionClass ?? null,
    risk: cmd.risk ?? gate.live.risk,
  });

  // Pass 13 — return proof to the originating agent asynchronously.
  // The HTTP response is sent immediately; proof relay and any new pending
  // command appear in the background without blocking OURSELF's browser.
  // Only commands originating from a named agent (not 'ourself' / test) are relayed.
  if (cmd.to === 'claude' || cmd.to === 'openai') {
    continueAgentWithExecutionProof(cmd).catch(err => {
      console.error(`\n✗ continueAgentWithExecutionProof unhandled error: ${err.message}`);
    });
  }

  const wantHtml = (req.headers.accept || '').includes('text/html');
  if (wantHtml) return res.redirect('/pending');

  res.json({
    id: cmd.id,
    status: cmd.status,
    result: cmd.result ?? null,
    error: cmd.error ?? null,
  });
});

// POST /reject/:id  (token-gated)
app.post('/reject/:id', requireToken, async (req, res) => {
  const cmd = pending.get(req.params.id);
  if (!cmd) return res.status(404).json({ error: 'Command not found.' });
  if (cmd.status !== 'pending') return res.status(409).json({ error: `Command is already ${cmd.status}.` });

  cmd.status = 'rejected';
  cmd.rejectedAt = new Date().toISOString();
  pending.set(cmd.id, cmd);

  console.log(`\n✗ REJECTED: ${cmd.id}`);

  await log({
    id: cmd.id,
    type: 'command_rejected',
    txId: cmd.txId,
    action: cmd.action,
    workingDir: cmd.workingDir,
    rationale: cmd.rationale,
    rejected_at: cmd.rejectedAt,
  });

  const wantHtml = (req.headers.accept || '').includes('text/html');
  if (wantHtml) return res.redirect('/pending');

  res.json({ id: cmd.id, status: 'rejected' });
});

// GET /log — last 50 transmissions
app.get('/log', async (req, res) => {
  try {
    const raw = await readFile(LOG_PATH, 'utf8').catch(() => '');
    const entries = raw.trim().split('\n').filter(Boolean).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean).slice(-50).reverse();
    res.json({ count: entries.length, entries });
  } catch {
    res.json({ count: 0, entries: [] });
  }
});

// ── Pass 19B: deterministic diagnostic — a ritual of WITNESS, not command ────
// The server owns exactly ONE fixed, read-only diagnostic. /test cannot be used
// to inject a command: caller-provided action / working_dir / rationale are
// IGNORED and never interpolated into the command, working directory, rationale,
// source, or shell environment. /transmit remains the deliberate proposal gate.
const TEST_DIAGNOSTIC = Object.freeze({
  action: 'git status --short',
  // Server-pinned to the bridge's own repository boundary (inside RUORA).
  workingDir: __dirname,
  rationale:
    'Pass 19B fixed read-only bridge diagnostic — proves the ' +
    'approve → firewall → execute → proof chain without mutation. Caller input is ignored.',
});

// POST /test — deterministic diagnostic endpoint  (token-gated)
//
// Queues the single server-owned read-only diagnostic above. Queuing is NOT
// execution: the queued command still requires explicit OURSELF approval AND
// must pass the action-level firewall in tools/terminal.js before any shell
// runs. No request-body value influences what is queued.
app.post('/test', requireToken, async (req, res) => {
  // Caller input is intentionally ignored — /test is a witness, not a portal.
  const cmdId = generateId('cmd');
  // Pass 20A — classify the server-owned fixed diagnostic. `git status --short`
  // resolves to git-read; classified the same way as any other command so the
  // /approve gate enforces it identically.
  const testClass = classifyCommand(TEST_DIAGNOSTIC.action);
  const pendingEntry = {
    id: cmdId,
    txId: 'test',
    from: 'ourself',
    to: 'terminal',
    action: TEST_DIAGNOSTIC.action,
    workingDir: TEST_DIAGNOSTIC.workingDir,
    rationale: TEST_DIAGNOSTIC.rationale,
    proposedAt: new Date().toISOString(),
    status: 'pending',
    executionClass: testClass.class,
    risk: testClass.risk,
    classRationale: testClass.reason,
  };
  pending.set(cmdId, pendingEntry);
  logCommandProposed(pendingEntry).catch(() => {});
  printPendingAlert(pendingEntry);

  res.json({
    message: 'Fixed read-only diagnostic added to approval queue (caller input ignored).',
    command: pendingEntry,
    next: `Approve at: curl -X POST -H "x-ourself-token: $OURSELF_TOKEN" http://localhost:${PORT}/approve/${cmdId}`,
  });
});

// GET /health
app.get('/health', (req, res) => {
  res.json({
    status: 'alive',
    name: 'ÆTHERNET Agent Bridge',
    pending_count: [...pending.values()].filter(c => c.status === 'pending').length,
    timestamp: new Date().toISOString(),
  });
});

// ── Pass 15: OURSELF command chamber (read-only data + rendered shell) ───────
// These routes are GATE-FREE because they are strictly read-only — identical in
// kind to the existing gate-free /health, /log, and /pending routes. Every
// state-changing action the chamber performs (/transmit, /approve, /reject)
// still flows through the unchanged Pass 18 token gate; the operator's browser
// supplies the x-ourself-token header from a session-only value it never
// persists to disk and the server never embeds or reveals.

const AXIOM_DIR = '/Users/millysituated/RUORA/projects/axiom-trial-engine-v1';
const AXIOM_DEV_URL = 'http://localhost:5174/';

function parseJsonl(raw) {
  return raw.trim().split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

// Probe the AXIOM dev server without claiming a state we cannot prove.
async function probeAxiom() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 1200);
  try {
    await fetch(AXIOM_DEV_URL, { signal: ctrl.signal });
    return 'available';
  } catch {
    return 'unavailable';
  } finally {
    clearTimeout(t);
  }
}

// GET /ourself/state — health snapshot for the chamber. Read-only. No secrets.
app.get('/ourself/state', async (req, res) => {
  const now = Date.now();
  const expiryMs = QUEUE_EXPIRY_HOURS * 60 * 60 * 1000;

  const pendingCmds = [...pending.values()]
    .filter(c => c.status === 'pending')
    .map(c => {
      const proposedMs = new Date(c.proposedAt).getTime();
      const ageMs = Number.isFinite(proposedMs) ? now - proposedMs : null;
      return {
        id: c.id,
        txId: c.txId,
        from: c.from,
        to: c.to,
        action: c.action,
        workingDir: c.workingDir,
        rationale: c.rationale,
        proposedAt: c.proposedAt,
        continuationDepth: c.continuationDepth ?? 0,
        parentCmdId: c.parentCmdId ?? null,
        rehydrated: Boolean(c.rehydratedAt),
        rehydratedAt: c.rehydratedAt ?? null,
        executionClass: c.executionClass ?? null,
        risk: c.risk ?? null,
        ageMs,
        expiresInMs: ageMs == null ? null : expiryMs - ageMs,
      };
    });

  // Derive last transmission / last execution time from the append-only log.
  let lastTransmissionAt = null;
  let lastExecutionAt = null;
  const txRaw = await readFile(LOG_PATH, 'utf8').catch(() => '');
  for (const e of parseJsonl(txRaw)) {
    if (e.type === 'transmission') lastTransmissionAt = e.logged_at ?? lastTransmissionAt;
    if (e.type === 'command_result') lastExecutionAt = e.logged_at ?? lastExecutionAt;
  }

  const axiom = await probeAxiom();

  res.json({
    bridge: 'alive',
    name: 'ÆTHERNET Agent Bridge',
    port: PORT,
    bindHost: BIND_HOST,
    pending: pendingCmds,
    counts: {
      pending: pendingCmds.length,
      rehydrated: pendingCmds.filter(c => c.rehydrated).length,
    },
    lastTransmissionAt,
    lastExecutionAt,
    limits: {
      continuationDepthLimit: MAX_CONTINUATION_DEPTH,
      proofTruncationChars: MAX_PROOF_PAYLOAD_CHARS,
      queueExpiryHours: QUEUE_EXPIRY_HOURS,
    },
    nodes: {
      ourself: 'present',
      bridge: 'available',
      // Booleans only — raw key VALUES are never read or returned.
      claude: process.env.ANTHROPIC_API_KEY ? 'available' : 'unavailable',
      openai: process.env.OPENAI_API_KEY ? 'available' : 'unavailable',
      terminal: 'available',
      axiom,
      proofMemory: txRaw.length > 0 ? 'available' : 'unknown',
    },
    timestamp: new Date().toISOString(),
  });
});

// GET /ourself/ledger — merged, parsed append-only audit events. Read-only.
// Returns structured JSON; the client renders every value via textContent.
app.get('/ourself/ledger', async (req, res) => {
  const [txRaw, queueRaw] = await Promise.all([
    readFile(LOG_PATH, 'utf8').catch(() => ''),
    readFile(QUEUE_LOG_PATH, 'utf8').catch(() => ''),
  ]);
  const events = [...parseJsonl(txRaw), ...parseJsonl(queueRaw)]
    .sort((a, b) => (b.logged_at ?? '').localeCompare(a.logged_at ?? ''))
    .slice(0, 200);
  res.json({ count: events.length, events });
});

// GET /ourself/verify — authenticated liveness check (Pass 19). Token-gated,
// read-only, returns NO secret. The chamber calls this to transition from
// LOCKED to AUTHORIZED: a 200 proves the entered token matches the server gate;
// a 401 tells the chamber to clear the token locally and stay locked.
app.get('/ourself/verify', requireToken, (req, res) => {
  res.json({ authorized: true, name: 'ÆTHERNET Agent Bridge', timestamp: new Date().toISOString() });
});

// GET /ourself — the SELF-governed command chamber (server-rendered shell).
// A per-response nonce drives a strict CSP: only this page's own inline style
// and script may run; no third-party JavaScript, no inline-without-nonce, no
// remote connections beyond same-origin fetch.
app.get('/ourself', (req, res) => {
  const nonce = randomBytes(16).toString('base64');
  res.set('Content-Security-Policy', [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '));
  res.type('html').send(renderChamber(nonce));
});

// ── Utility ────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Pass 19: OURSELF local operator chamber shell ───────────────────────────
// Server-rendered shell only. NO secret is ever interpolated. The page renders
// in two states — LOCKED and AUTHORIZED. The operator token lives only in a JS
// module variable for the lifetime of the open tab (tab-memory); refreshing or
// closing the tab discards it. sessionStorage is used ONLY when the operator
// explicitly opts in via an unchecked-by-default checkbox. The token is never
// embedded in HTML/JS/URLs/cookies/localStorage/logs, never sent to any agent
// or third party, and is cleared immediately on any 401/403. All dynamic data
// is rendered via textContent (never innerHTML); a nonce-based CSP forbids any
// inline-without-nonce or third-party script.
function renderChamber(nonce) {
  const cfg = JSON.stringify({ port: PORT, axiomUrl: AXIOM_DEV_URL, axiomDir: AXIOM_DIR });
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OURSELF COMMAND CHAMBER</title>
<style nonce="${nonce}">
  :root{
    --bg:#0a0a0a; --panel:#0e0e0e; --panel2:#111; --line:#262626; --line2:#333;
    --txt:#d8d8d8; --muted:#6a6a6a; --silver:#c9c9c9;
    --cyan:#3fd0d8; --violet:#9a7fe0; --gold:#c9a84c; --red:#c05a5a; --green:#4a9960;
  }
  *{box-sizing:border-box;}
  body{background:var(--bg);color:var(--txt);font-family:Georgia,'Times New Roman',serif;margin:0;padding:0 18px 80px;line-height:1.5;}
  .wrap{max-width:860px;margin:0 auto;}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}
  h1{font-family:ui-monospace,monospace;color:var(--gold);letter-spacing:.22em;font-size:18px;margin:34px 0 2px;}
  .present{font-family:ui-monospace,monospace;letter-spacing:.18em;font-size:11px;}
  body.locked .present{color:var(--gold);}
  body.authorized .present{color:var(--cyan);}
  .sub{font-family:ui-monospace,monospace;color:var(--muted);letter-spacing:.14em;font-size:10px;margin-bottom:18px;}
  section{border:1px solid var(--line);background:var(--panel);border-radius:5px;padding:16px 18px;margin:14px 0;}
  .label{font-family:ui-monospace,monospace;font-size:10px;letter-spacing:.16em;color:var(--silver);text-transform:uppercase;margin-bottom:12px;}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;}
  .metric{border:1px solid var(--line);background:var(--panel2);border-radius:4px;padding:9px 11px;}
  .metric .k{font-family:ui-monospace,monospace;font-size:9px;letter-spacing:.12em;color:var(--muted);text-transform:uppercase;}
  .metric .v{font-family:ui-monospace,monospace;font-size:13px;color:var(--txt);margin-top:3px;word-break:break-word;}
  label.f{display:block;font-family:ui-monospace,monospace;font-size:10px;letter-spacing:.1em;color:var(--muted);margin:10px 0 4px;text-transform:uppercase;}
  input,select,textarea{width:100%;background:#060606;border:1px solid var(--line2);color:var(--txt);
    font-family:ui-monospace,monospace;font-size:13px;padding:9px 10px;border-radius:4px;}
  textarea{min-height:84px;resize:vertical;line-height:1.45;}
  button{font-family:ui-monospace,monospace;font-size:12px;letter-spacing:.08em;cursor:pointer;border-radius:4px;
    border:1px solid var(--line2);background:#161616;color:var(--txt);padding:8px 16px;}
  button:hover{border-color:#555;}
  button:disabled{opacity:.4;cursor:not-allowed;}
  .btn-go{border-color:#2f5a52;color:var(--cyan);background:#0a1413;}
  .btn-auth{border-color:#5a4f2f;color:var(--gold);background:#14110a;}
  .btn-approve{border-color:#2f5a3a;color:var(--green);background:#0a140d;}
  .btn-reject{border-color:#5a2f2f;color:var(--red);background:#140a0a;}
  .btn-ghost{background:transparent;color:var(--muted);}
  .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;}
  .note{font-size:12px;color:var(--muted);border-left:2px solid var(--gold);padding:6px 0 6px 12px;margin:10px 0;line-height:1.55;}
  .card{border:1px solid var(--line2);border-left:3px solid var(--gold);background:var(--panel2);border-radius:4px;padding:13px 15px;margin-bottom:12px;}
  .card.rehy{border-left-color:var(--violet);}
  .cid{font-family:ui-monospace,monospace;font-size:9px;letter-spacing:.1em;color:var(--muted);margin-bottom:5px;word-break:break-all;}
  .act{font-family:ui-monospace,monospace;font-size:14px;color:#eee;margin:5px 0;word-break:break-all;}
  .meta{font-size:11px;color:var(--muted);margin:2px 0;word-break:break-word;}
  .badge{display:inline-block;font-family:ui-monospace,monospace;font-size:9px;letter-spacing:.1em;
    padding:2px 7px;border-radius:3px;border:1px solid var(--line2);color:var(--muted);margin-left:6px;}
  .badge.rehy{color:var(--violet);border-color:#3a2f5a;}
  .badge.cont{color:var(--gold);border-color:#5a4f2f;}
  .nodes{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px;}
  .node{border:1px solid var(--line);background:var(--panel2);border-radius:4px;padding:8px 10px;font-family:ui-monospace,monospace;font-size:11px;}
  .node .s{font-size:9px;letter-spacing:.1em;text-transform:uppercase;margin-top:3px;}
  .ok{color:var(--cyan);} .no{color:var(--red);} .unk{color:var(--muted);} .self{color:var(--violet);}
  .ev{border-bottom:1px solid var(--line);padding:8px 0;}
  .ev summary{cursor:pointer;font-family:ui-monospace,monospace;font-size:11px;color:var(--txt);list-style:none;}
  .ev summary::-webkit-details-marker{display:none;}
  .ev .t{color:var(--muted);} .ev .ty{color:var(--cyan);}
  .ev pre{background:#060606;border:1px solid var(--line);border-radius:4px;padding:8px;overflow:auto;
    font-size:11px;color:#bdbdbd;margin:6px 0 0;max-height:280px;white-space:pre-wrap;word-break:break-word;}
  #notice{position:sticky;top:0;z-index:5;}
  .banner{font-family:ui-monospace,monospace;font-size:12px;padding:10px 14px;border-radius:4px;margin:10px 0;}
  .banner.good{background:#0a140d;border:1px solid #2f5a3a;color:var(--green);}
  .banner.warn{background:#140a0a;border:1px solid #5a2f2f;color:var(--red);}
  .banner.info{background:#0a1413;border:1px solid #2f5a52;color:var(--cyan);}
  a{color:var(--gold);}
  .statebar{font-family:ui-monospace,monospace;font-size:11px;letter-spacing:.12em;padding:7px 12px;border-radius:4px;display:inline-block;}
  body.locked .statebar{color:var(--gold);border:1px solid #5a4f2f;background:#14110a;}
  body.authorized .statebar{color:var(--cyan);border:1px solid #2f5a52;background:#0a1413;}
  .tok-set{color:var(--cyan);} .tok-unset{color:var(--red);}
  .ckrow{display:flex;align-items:center;gap:8px;margin-top:10px;font-family:ui-monospace,monospace;font-size:11px;color:var(--muted);}
  .ckrow input{width:auto;}
  .resfield{font-size:12px;margin:4px 0;}
  .resfield b{font-family:ui-monospace,monospace;color:var(--muted);font-weight:normal;}
  pre.resp{background:#060606;border:1px solid var(--line);border-radius:4px;padding:9px;white-space:pre-wrap;word-break:break-word;font-size:12px;color:#cfcfcf;}
  /* state-gated visibility */
  body.locked .auth-only{display:none;}
  body.authorized .locked-only{display:none;}
  /* confirmation modal */
  .overlay{position:fixed;inset:0;background:rgba(0,0,0,.80);display:none;align-items:center;justify-content:center;z-index:50;padding:20px;}
  .overlay.show{display:flex;}
  .modal{max-width:540px;width:100%;background:#0e0e0e;border:1px solid #3a3a3a;border-left:3px solid var(--gold);border-radius:6px;padding:20px;}
  .modal h2{font-family:ui-monospace,monospace;font-size:13px;letter-spacing:.1em;margin:0 0 12px;}
  .modal.approve h2{color:var(--green);} .modal.reject h2{color:var(--red);}
  .modal .decl{font-size:13px;color:var(--txt);line-height:1.55;border-left:2px solid var(--gold);padding-left:12px;margin:12px 0;}
  .modal .det{font-family:ui-monospace,monospace;font-size:11px;color:var(--muted);margin:3px 0;word-break:break-all;}
  .modal .acts{display:flex;gap:8px;justify-content:flex-end;margin-top:16px;}
</style>
</head>
<body class="locked">
<div class="wrap">
  <div id="notice"></div>

  <h1>OURSELF COMMAND CHAMBER</h1>
  <div class="present" id="presence">LOCAL AUTHORITY LOCKED</div>
  <div class="sub">ÆTHERNET AGENT BRIDGE · LOCAL · SOVEREIGN</div>

  <section>
    <div class="label">Local Authority</div>
    <div class="statebar" id="statebar">LOCAL AUTHORITY LOCKED</div>
    <div class="auth-only" style="margin-top:10px;">
      <div class="row">
        <span class="meta tok-set">● Chamber authorized for local operations.</span>
        <button id="clearTok" class="btn-ghost">CLEAR TOKEN · LOCK</button>
      </div>
    </div>
    <div class="locked-only">
      <label class="f" for="tok">Enter OURSELF token (read from your gitignored .env)</label>
      <div class="row">
        <input id="tok" type="password" placeholder="OURSELF token — held in tab memory only" autocomplete="off" style="flex:1;min-width:200px;">
        <button id="authBtn" class="btn-auth">AUTHORIZE CHAMBER</button>
      </div>
      <div class="ckrow">
        <input type="checkbox" id="remember">
        <label for="remember" style="margin:0;cursor:pointer;">Remember token until this browser tab closes</label>
      </div>
      <div id="tokStatus" class="meta tok-unset" style="margin-top:8px;"></div>
      <div class="note">Default is tab-memory only: refreshing or closing the tab discards the token and re-locks the chamber. The token is never written to disk, never embedded in this page, and never sent to any agent. The bridge verifies it server-side and never reveals it.</div>
    </div>
  </section>

  <section>
    <div class="label">Presence &amp; Vitals</div>
    <div id="metrics" class="grid"><div class="metric"><div class="v">loading…</div></div></div>
  </section>

  <section class="auth-only">
    <div class="label">Transmission Chamber</div>
    <label class="f" for="dest">Destination</label>
    <select id="dest"><option value="claude">claude</option><option value="openai">openai</option></select>
    <label class="f" for="mode">Mode</label>
    <select id="mode">
      <option value="inspection_only">inspection_only</option>
      <option value="propose_only">propose_only</option>
      <option value="standard_bounded">standard_bounded</option>
    </select>
    <label class="f" for="msg">Message</label>
    <textarea id="msg" placeholder="Transmit intent to the cognition node…"></textarea>
    <div class="note">The cognition node may respond or propose one command. No command executes without OURSELF approval.</div>
    <div class="row"><button id="send" class="btn-go">TRANSMIT</button></div>
    <div id="txResult"></div>
  </section>

  <section>
    <div class="label">Pending Authority Gate · <span id="pendCount">0</span> awaiting OURSELF</div>
    <div class="note locked-only">Chamber is locked — proposals are display-only. Authorize to approve or reject.</div>
    <div id="pending"><div class="meta">loading…</div></div>
  </section>

  <section>
    <div class="label">Node Status</div>
    <div id="nodes" class="nodes"></div>
  </section>

  <section>
    <div class="label">AXIOM Trial Vessel</div>
    <div id="axiomBox" class="meta">checking…</div>
  </section>

  <section>
    <div class="label">Proof Ledger · append-only · read-only</div>
    <div class="row" style="margin-bottom:8px;"><button id="reloadLedger" class="btn-ghost">REFRESH LEDGER</button></div>
    <div id="ledger"><div class="meta">loading…</div></div>
  </section>
</div>

<div class="overlay" id="overlay">
  <div class="modal" id="modal">
    <h2 id="modalTitle"></h2>
    <div id="modalDetails"></div>
    <div class="decl" id="modalDecl"></div>
    <div class="acts">
      <button id="modalCancel" class="btn-ghost">CANCEL</button>
      <button id="modalConfirm" class="btn-go">CONFIRM</button>
    </div>
  </div>
</div>

<script nonce="${nonce}">
"use strict";
(function(){
var CFG = ${cfg};

// ── Token state: tab-memory ONLY by default ────────────────────────────────
// chamberToken lives solely in this closure variable for the life of the tab.
// sessionStorage is touched ONLY when the operator opts in via the checkbox.
var chamberToken = null;
var authorized = false;
var SSKEY = "ourself_tabmem_token";   // used ONLY when "remember" is checked

function $(id){return document.getElementById(id);}
function el(tag,cls,txt){var e=document.createElement(tag);if(cls)e.className=cls;if(txt!=null)e.textContent=txt;return e;}
function clear(node){while(node.firstChild)node.removeChild(node.firstChild);}

function notice(msg,kind){
  var n=$("notice"); clear(n);
  var b=el("div","banner "+(kind||"info"),msg); n.appendChild(b);
  if(kind!=="warn"){setTimeout(function(){if(b.parentNode)b.parentNode.removeChild(b);},6000);}
}

function setStateLocked(){
  authorized=false;
  document.body.className="locked";
  $("presence").textContent="LOCAL AUTHORITY LOCKED";
  $("statebar").textContent="LOCAL AUTHORITY LOCKED";
  var s=$("tokStatus"); s.className="meta tok-unset";
  s.textContent="○ No token set — transmit / approve / reject are disabled until you authorize.";
  loadState();
}
function setStateAuthorized(){
  authorized=true;
  document.body.className="authorized";
  $("presence").textContent="SELF IS PRESENT · AUTHORIZED FOR LOCAL OPERATIONS";
  $("statebar").textContent="AUTHORIZED FOR LOCAL OPERATIONS";
  loadState();
}

// Wipe the token from memory AND any opt-in sessionStorage, then lock.
function clearToken(reason){
  chamberToken=null;
  try{sessionStorage.removeItem(SSKEY);}catch(e){}
  var ck=$("remember"); if(ck)ck.checked=false;
  setStateLocked();
  if(reason)notice(reason,"warn");
}

// Authenticated fetch for state-changing routes. Attaches the token header,
// performs NO automatic retry, and clears the token immediately on 401/403.
function authed(url,method,body){
  if(!chamberToken){notice("Authorize the chamber first.","warn");return Promise.reject(new Error("locked"));}
  var h={"x-ourself-token":chamberToken};
  var opts={method:method,headers:h};
  if(body){h["Content-Type"]="application/json";opts.body=JSON.stringify(body);}
  return fetch(url,opts).then(function(r){
    if(r.status===401||r.status===403){clearToken("Authority revoked by server ("+r.status+"). Token cleared; chamber re-locked.");throw new Error("unauthorized");}
    return r;
  });
}

function authorize(){
  var v=$("tok").value.trim();
  if(!v){notice("Enter a token to authorize.","warn");return;}
  var remember=$("remember").checked;
  var btn=$("authBtn"); btn.disabled=true; btn.textContent="VERIFYING…";
  // Verify the token against the server gate BEFORE declaring authority.
  fetch("/ourself/verify",{method:"GET",headers:{"x-ourself-token":v}}).then(function(r){
    btn.disabled=false; btn.textContent="AUTHORIZE CHAMBER";
    if(r.ok){
      chamberToken=v;
      $("tok").value="";
      if(remember){try{sessionStorage.setItem(SSKEY,v);}catch(e){}}
      else{try{sessionStorage.removeItem(SSKEY);}catch(e){}}
      setStateAuthorized();
      notice("Chamber authorized for local operations.","good");
    }else{
      // Invalid/denied — never retain the token.
      chamberToken=null;
      try{sessionStorage.removeItem(SSKEY);}catch(e){}
      notice("Authorization denied ("+r.status+"). Token discarded.","warn");
    }
  }).catch(function(e){
    btn.disabled=false; btn.textContent="AUTHORIZE CHAMBER";
    chamberToken=null;
    notice("Verification failed: "+e.message,"warn");
  });
}

function fmtTime(iso){if(!iso)return "—";var d=new Date(iso);return isNaN(d)?String(iso):d.toLocaleString();}
function fmtAge(ms){if(ms==null)return "—";var s=Math.floor(ms/1000);if(s<60)return s+"s";var m=Math.floor(s/60);if(m<60)return m+"m";var h=Math.floor(m/60);return h+"h "+(m%60)+"m";}
function metric(k,v){var m=el("div","metric");m.appendChild(el("div","k",k));m.appendChild(el("div","v",v==null?"—":String(v)));return m;}

function renderMetrics(st){
  var g=$("metrics"); clear(g);
  var nodesUp=Object.keys(st.nodes).filter(function(k){return st.nodes[k]==="available"||st.nodes[k]==="present";}).length;
  g.appendChild(metric("Bridge",st.bridge));
  g.appendChild(metric("Bound",st.bindHost+":"+st.port));
  g.appendChild(metric("Pending",st.counts.pending));
  g.appendChild(metric("Rehydrated",st.counts.rehydrated));
  g.appendChild(metric("Last Transmit",fmtTime(st.lastTransmissionAt)));
  g.appendChild(metric("Last Execution",fmtTime(st.lastExecutionAt)));
  g.appendChild(metric("Active Nodes",nodesUp));
  g.appendChild(metric("Continuation Limit",st.limits.continuationDepthLimit));
  g.appendChild(metric("Proof Truncation",st.limits.proofTruncationChars+" ch"));
  g.appendChild(metric("Queue Expiry",st.limits.queueExpiryHours+" h"));
  g.appendChild(metric("AXIOM Vessel",st.nodes.axiom));
  $("pendCount").textContent=st.counts.pending;
}

function renderNodes(st){
  var box=$("nodes"); clear(box);
  var order=["ourself","bridge","claude","openai","terminal","axiom","proofMemory"];
  var nameMap={ourself:"OURSELF",bridge:"ÆTHERNET",claude:"CLAUDE",openai:"OPENAI",terminal:"TERMINAL",axiom:"AXIOM VESSEL",proofMemory:"PROOF MEMORY"};
  order.forEach(function(key){
    var status=st.nodes[key]; var n=el("div","node");
    n.appendChild(el("div",null,nameMap[key]));
    var cls=status==="available"?"ok":status==="present"?"self":status==="unavailable"?"no":"unk";
    n.appendChild(el("div","s "+cls,status)); box.appendChild(n);
  });
}

function renderAxiom(st){
  var box=$("axiomBox"); clear(box);
  if(st.nodes.axiom==="available"){
    var a=el("a",null,"OPEN AXIOM TRIAL ENGINE →"); a.href=CFG.axiomUrl; a.target="_blank"; a.rel="noopener noreferrer"; box.appendChild(a);
  }else{
    box.appendChild(el("div","meta","AXIOM vessel is not currently running."));
    box.appendChild(el("pre","resp","cd ~/RUORA/projects/axiom-trial-engine-v1 && npm run dev"));
  }
}

function renderPending(st){
  var box=$("pending"); clear(box);
  if(!st.pending.length){box.appendChild(el("div","meta","No commands pending approval."));return;}
  st.pending.forEach(function(c){
    var card=el("div","card"+(c.rehydrated?" rehy":""));
    var cid=el("div","cid",c.id+" · tx "+c.txId);
    if(c.rehydrated)cid.appendChild(el("span","badge rehy","REHYDRATED"));
    if(c.continuationDepth>0)cid.appendChild(el("span","badge cont","CONT depth "+c.continuationDepth));
    card.appendChild(cid);
    card.appendChild(el("div","act","$ "+c.action));
    card.appendChild(el("div","meta","origin: "+c.from+"  →  node: "+c.to));
    card.appendChild(el("div","meta","dir: "+c.workingDir));
    card.appendChild(el("div","meta","rationale: "+c.rationale));
    card.appendChild(el("div","meta","proposed: "+fmtTime(c.proposedAt)+"  ·  age: "+fmtAge(c.ageMs)+"  ·  expires in: "+fmtAge(c.expiresInMs)));
    if(c.parentCmdId)card.appendChild(el("div","meta","parent: "+c.parentCmdId));
    if(authorized){
      var row=el("div","row"); row.style.marginTop="10px";
      var ap=el("button","btn-approve","APPROVE");
      var rj=el("button","btn-reject","REJECT");
      ap.onclick=function(){confirmAction("approve",c);};
      rj.onclick=function(){confirmAction("reject",c);};
      row.appendChild(ap); row.appendChild(rj); card.appendChild(row);
    }else{
      card.appendChild(el("div","meta","↳ display-only — authorize the chamber to act on this proposal."));
    }
    box.appendChild(card);
  });
}

// ── Confirmation modal ──────────────────────────────────────────────────────
var pendingConfirm=null;
function confirmAction(kind,c){
  var modal=$("modal"); modal.className="modal "+kind;
  $("modalTitle").textContent=(kind==="approve"?"AUTHORIZE EXECUTION":"REJECT COMMAND");
  var det=$("modalDetails"); clear(det);
  det.appendChild(el("div","det","command: "+c.id));
  det.appendChild(el("div","det","$ "+c.action));
  det.appendChild(el("div","det","dir: "+c.workingDir));
  $("modalDecl").textContent = kind==="approve"
    ? "OURSELF authorizes this exact command to execute once inside the displayed working directory."
    : "OURSELF rejects this command. It will not execute.";
  $("modalConfirm").className = kind==="approve" ? "btn-approve" : "btn-reject";
  $("modalConfirm").textContent = kind==="approve" ? "AUTHORIZE" : "REJECT";
  pendingConfirm={kind:kind,c:c};
  $("overlay").classList.add("show");
}
function closeModal(){$("overlay").classList.remove("show");pendingConfirm=null;}
function runConfirm(){
  if(!pendingConfirm)return;
  var kind=pendingConfirm.kind, c=pendingConfirm.c; closeModal();
  var url=(kind==="approve"?"/approve/":"/reject/")+encodeURIComponent(c.id);
  authed(url,"POST",null)
    .then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});})
    .then(function(res){
      if(!res.ok){notice((kind==="approve"?"Approval":"Rejection")+" refused: "+(res.j.error||"unknown"),"warn");}
      else if(kind==="approve"){notice("OURSELF authorized "+c.id+" — status: "+res.j.status,"good");}
      else{notice("OURSELF rejected "+c.id+" — it will not execute.","good");}
      loadState(); loadLedger();
    })
    .catch(function(e){if(e&&e.message!=="locked"&&e.message!=="unauthorized")notice("Action failed: "+e.message,"warn");});
}

function buildModeMessage(mode,msg){
  var pre;
  if(mode==="inspection_only")pre="[MODE: inspection_only] Respond with analysis only. Do NOT propose any terminal command.";
  else if(mode==="propose_only")pre="[MODE: propose_only] You may propose at most ONE terminal command for OURSELF approval. Nothing executes this turn.";
  else pre="[MODE: standard_bounded] Standard bounded protocol: propose at most one command; nothing executes without OURSELF approval.";
  return pre+"\\n\\n"+msg;
}

function transmit(){
  var msg=$("msg").value.trim();
  if(!msg){notice("Message is empty.","warn");return;}
  var dest=$("dest").value, mode=$("mode").value;
  var btn=$("send"); btn.disabled=true; btn.textContent="TRANSMITTING…";
  authed("/transmit","POST",{from:"ourself",to:dest,message:buildModeMessage(mode,msg)})
    .then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});})
    .then(function(res){
      btn.disabled=false; btn.textContent="TRANSMIT";
      var out=$("txResult"); clear(out);
      if(!res.ok){notice("Transmission error: "+(res.j.error||"unknown"),"warn");return;}
      var j=res.j; var cp=j.command_proposed;
      function field(k,v){var d=el("div","resfield");d.appendChild(el("b",null,k+": "));d.appendChild(document.createTextNode(v==null?"—":String(v)));return d;}
      var wrap=el("div","card");
      wrap.appendChild(field("transmission id",j.transmission_id));
      wrap.appendChild(field("destination",j.to));
      wrap.appendChild(field("mode",mode));
      wrap.appendChild(el("pre","resp",j.response||"(no text response)"));
      wrap.appendChild(field("command proposed",cp?"YES":"no"));
      if(cp){
        wrap.appendChild(field("pending command id",cp.id));
        wrap.appendChild(field("continuation depth",cp.continuationDepth!=null?cp.continuationDepth:0));
      }
      wrap.appendChild(field("timestamp",fmtTime(new Date().toISOString())));
      out.appendChild(wrap);
      notice("Transmission "+j.transmission_id+" complete"+(cp?" — a command is now PENDING in the gate.":"."),cp?"info":"good");
      loadState(); loadLedger();
    })
    .catch(function(e){btn.disabled=false;btn.textContent="TRANSMIT";if(e&&e.message!=="locked"&&e.message!=="unauthorized")notice("Transmit failed: "+e.message,"warn");});
}

var LEDGER_FIELDS=["id","cmdId","txId","type","from","to","action","workingDir","status","continuationDepth","parentCmdId"];
function renderLedger(data){
  var box=$("ledger"); clear(box);
  if(!data.events.length){box.appendChild(el("div","meta","No audit events yet."));return;}
  data.events.forEach(function(e){
    var d=el("details","ev");
    var sum=el("summary");
    sum.appendChild(el("span","t",fmtTime(e.logged_at)+"  "));
    sum.appendChild(el("span","ty",e.type||"event"));
    var idtxt=e.id||e.cmdId; if(idtxt)sum.appendChild(document.createTextNode("  "+idtxt));
    if(e.action)sum.appendChild(document.createTextNode("  $ "+e.action));
    d.appendChild(sum);
    var pre=el("pre",null);
    var lines=[];
    LEDGER_FIELDS.forEach(function(f){if(e[f]!=null)lines.push(f+": "+e[f]);});
    if(e.result){
      if(e.result.stdout!=null)lines.push("stdout: "+String(e.result.stdout).slice(0,2000));
      if(e.result.stderr!=null)lines.push("stderr: "+String(e.result.stderr).slice(0,2000));
    }
    if(e.error)lines.push("error: "+e.error);
    if(e.response)lines.push("response: "+String(e.response).slice(0,2000));
    pre.textContent=lines.join("\\n");
    d.appendChild(pre);
    box.appendChild(d);
  });
}

function loadState(){
  fetch("/ourself/state").then(function(r){return r.json();}).then(function(st){
    renderMetrics(st); renderNodes(st); renderAxiom(st); renderPending(st);
  }).catch(function(e){notice("State load failed: "+e.message,"warn");});
}
function loadLedger(){
  fetch("/ourself/ledger").then(function(r){return r.json();}).then(renderLedger).catch(function(){});
}

// ── Wire up ─────────────────────────────────────────────────────────────────
$("authBtn").onclick=authorize;
$("tok").addEventListener("keydown",function(e){if(e.key==="Enter")authorize();});
$("clearTok").onclick=function(){clearToken("Token cleared. Chamber re-locked.");};
$("send").onclick=transmit;
$("reloadLedger").onclick=loadLedger;
$("modalCancel").onclick=closeModal;
$("modalConfirm").onclick=runConfirm;
$("overlay").addEventListener("click",function(e){if(e.target===$("overlay"))closeModal();});

// On load: only auto-authorize if the operator previously opted into tab-memory.
(function init(){
  var saved=null; try{saved=sessionStorage.getItem(SSKEY);}catch(e){}
  if(saved){
    chamberToken=saved; $("remember").checked=true;
    fetch("/ourself/verify",{method:"GET",headers:{"x-ourself-token":saved}}).then(function(r){
      if(r.ok){setStateAuthorized();notice("Chamber re-authorized from tab memory.","good");}
      else{clearToken("Stored token no longer valid. Re-enter to authorize.");}
    }).catch(function(){setStateLocked();});
  }else{
    setStateLocked();
  }
  loadLedger();
})();

setInterval(loadState,5000);
setInterval(loadLedger,9000);
})();
</script>
</body>
</html>`;
}

// ── Startup rehydration ────────────────────────────────────────────────────

async function rehydratePendingQueue() {
  const EXPIRY_MS = QUEUE_EXPIRY_HOURS * 60 * 60 * 1000;
  const now = Date.now();

  const parseLines = (raw) =>
    raw.trim().split('\n').filter(Boolean).flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });

  const [queueRaw, txRaw] = await Promise.all([
    readFile(QUEUE_LOG_PATH, 'utf8').catch(() => ''),
    readFile(LOG_PATH, 'utf8').catch(() => ''),
  ]);

  const queueEvents = parseLines(queueRaw);
  const txEvents = parseLines(txRaw);

  // Build cmdId → latest event type.
  // Sort chronologically so terminal states (command_result, command_rejected)
  // always overwrite earlier proposal entries for the same ID.
  const allEvents = [...txEvents, ...queueEvents].sort((a, b) =>
    (a.logged_at ?? '').localeCompare(b.logged_at ?? '')
  );
  const commandStates = new Map();
  for (const event of allEvents) {
    if (event.id && event.id.startsWith('cmd-') && event.type) {
      commandStates.set(event.id, event.type);
    }
  }

  // Build cmdId → full proposal entry (most recent command_proposed per id)
  const proposals = new Map();
  for (const event of queueEvents) {
    if (event.type === 'command_proposed' && event.id) {
      proposals.set(event.id, event);
    }
  }

  // Terminal states — never rehydrate a command with one of these as its latest event
  const TERMINAL_STATES = new Set(['command_result', 'command_rejected', 'command_expired']);
  let restored = 0;
  let expired = 0;

  for (const [cmdId, latestType] of commandStates) {
    if (TERMINAL_STATES.has(latestType)) continue;
    // latestType is 'command_proposed' or 'command_rehydrated' — eligible

    const proposal = proposals.get(cmdId);
    if (!proposal) continue;

    const proposedAt = new Date(proposal.proposedAt ?? proposal.logged_at).getTime();
    const age = now - proposedAt;

    if (age > EXPIRY_MS) {
      await logQueue({
        type: 'command_expired',
        id: cmdId,
        txId: proposal.txId,
        proposedAt: proposal.proposedAt,
        expiredAt: new Date().toISOString(),
        reason: 'stale_rehydration',
        expiryHours: QUEUE_EXPIRY_HOURS,
      });
      expired++;
      continue;
    }

    // Pass 20A — carry the persisted execution class; reclassify if a pre-20A
    // proposal lacks one (fail-closed: the /approve gate re-classifies anyway).
    const storedClass = proposal.executionClass ?? proposal.execution_class ?? null;
    const rehydratedClass = storedClass
      ? { class: storedClass, risk: proposal.risk ?? null, reason: 'carried from queue log' }
      : classifyCommand(proposal.action);

    const cmd = {
      id: cmdId,
      txId: proposal.txId,
      from: proposal.from,
      to: proposal.to,
      action: proposal.action,
      workingDir: proposal.workingDir,
      rationale: proposal.rationale,
      proposedAt: proposal.proposedAt,
      status: 'pending',
      continuationDepth: proposal.continuationDepth ?? 0,
      parentCmdId: proposal.parentCmdId ?? null,
      rehydratedAt: new Date().toISOString(),
      executionClass: rehydratedClass.class,
      risk: rehydratedClass.risk,
      classRationale: rehydratedClass.reason,
    };
    pending.set(cmdId, cmd);

    await logQueue({
      type: 'command_rehydrated',
      id: cmdId,
      txId: proposal.txId,
      rehydratedAt: cmd.rehydratedAt,
      originalProposedAt: proposal.proposedAt,
    });

    printPendingAlert(cmd);
    restored++;
  }

  if (restored > 0 || expired > 0) {
    console.log(`\n⟳ REHYDRATION — ${restored} restored, ${expired} expired.\n`);
  }
}

// ── Start ──────────────────────────────────────────────────────────────────

await rehydratePendingQueue();

app.listen(PORT, BIND_HOST, () => {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('⚡ ÆTHERNET AGENT BRIDGE — ALIVE  (authenticated · Pass 18 · chamber Pass 19)');
  console.log(`   Bound:     ${BIND_HOST}:${PORT}  (localhost-only unless BIND_HOST overridden)`);
  console.log(`   OURSELF:   http://localhost:${PORT}/ourself          (command chamber)`);
  console.log(`   Transmit:  POST http://localhost:${PORT}/transmit   [x-ourself-token]`);
  console.log(`   Pending:   http://localhost:${PORT}/pending          (display-only)`);
  console.log(`   Test:      POST http://localhost:${PORT}/test       [x-ourself-token]`);
  console.log(`   Approve:   POST http://localhost:${PORT}/approve/:id [x-ourself-token]`);
  console.log(`   Reject:    POST http://localhost:${PORT}/reject/:id  [x-ourself-token]`);
  console.log(`   Log:       http://localhost:${PORT}/log`);
  console.log(`   Health:    http://localhost:${PORT}/health           (gate-free)`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
});
