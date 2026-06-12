import 'dotenv/config';
import express from 'express';
import { timingSafeEqual } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { appendFile, readFile } from 'fs/promises';
import { callClaude } from './agents/claude-agent.js';
import { callOpenAI } from './agents/openai-agent.js';
import { executeCommand } from './tools/terminal.js';
import { firstTestCommand } from './tools/git-proof.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;
const LOG_PATH = join(__dirname, 'logs', 'transmissions.jsonl');
const QUEUE_LOG_PATH = join(__dirname, 'logs', 'queue.jsonl');
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

/**
 * Token middleware for state-changing routes.
 * Accepts the token ONLY via the x-ourself-token header. Uses a constant-time
 * comparison to avoid leaking length/equality timing. Fails closed with 401.
 */
function requireToken(req, res, next) {
  const presented = req.headers['x-ourself-token'];
  if (typeof presented !== 'string' || presented.length === 0) {
    return res.status(401).json({ error: 'Unauthorized — missing x-ourself-token header.' });
  }
  const a = Buffer.from(presented);
  const b = Buffer.from(BRIDGE_TOKEN);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Unauthorized — invalid token.' });
  }
  return next();
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

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

  let result;
  try {
    result = await executeCommand(cmd.action, cmd.workingDir);
    cmd.status = 'executed';
    cmd.result = result;
    console.log(`✓ EXECUTED: ${cmd.id}`);
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

// POST /test — submit a command into the approval queue  (token-gated)
//
// Default (no body): queues the canonical first safe read-only proof command.
// Optional body { action, working_dir, rationale }: queues a caller-specified
// command — used by the Pass 18 proof harness to exercise the firewall on a
// denied command without needing a live agent transmission. Queuing is NOT
// execution: every queued command still requires OURSELF approval AND must pass
// the action-level firewall in tools/terminal.js before any shell runs.
app.post('/test', requireToken, async (req, res) => {
  const body = req.body || {};
  const custom = typeof body.action === 'string' && typeof body.working_dir === 'string';
  const testCmd = custom
    ? {
        action: body.action,
        working_dir: body.working_dir,
        rationale: typeof body.rationale === 'string'
          ? body.rationale
          : 'Caller-specified test command (Pass 18 proof harness).',
      }
    : firstTestCommand();

  const cmdId = generateId('cmd');
  const pendingEntry = {
    id: cmdId,
    txId: 'test',
    from: 'ourself',
    to: 'terminal',
    action: testCmd.action,
    workingDir: testCmd.working_dir,
    rationale: testCmd.rationale,
    proposedAt: new Date().toISOString(),
    status: 'pending',
  };
  pending.set(cmdId, pendingEntry);
  logCommandProposed(pendingEntry).catch(() => {});
  printPendingAlert(pendingEntry);

  res.json({
    message: custom
      ? 'Caller-specified test command added to approval queue.'
      : 'First safe test command added to approval queue.',
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

// ── Utility ────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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

app.listen(PORT, () => {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('⚡ ÆTHERNET AGENT BRIDGE — ALIVE  (authenticated · Pass 18)');
  console.log(`   Transmit:  POST http://localhost:${PORT}/transmit   [x-ourself-token]`);
  console.log(`   Pending:   http://localhost:${PORT}/pending          (display-only)`);
  console.log(`   Test:      POST http://localhost:${PORT}/test       [x-ourself-token]`);
  console.log(`   Approve:   POST http://localhost:${PORT}/approve/:id [x-ourself-token]`);
  console.log(`   Reject:    POST http://localhost:${PORT}/reject/:id  [x-ourself-token]`);
  console.log(`   Log:       http://localhost:${PORT}/log`);
  console.log(`   Health:    http://localhost:${PORT}/health           (gate-free)`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
});
