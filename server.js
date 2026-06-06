import 'dotenv/config';
import express from 'express';
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

function printPendingAlert(cmd) {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('⚡ COMMAND PENDING — OURSELF APPROVAL REQUIRED');
  console.log(`   ID:        ${cmd.id}`);
  console.log(`   Action:    ${cmd.action}`);
  console.log(`   Dir:       ${cmd.workingDir}`);
  console.log(`   Rationale: ${cmd.rationale}`);
  console.log(`   Approve:   POST http://localhost:${PORT}/approve/${cmd.id}`);
  console.log(`   Reject:    POST http://localhost:${PORT}/reject/${cmd.id}`);
  console.log(`   Review:    http://localhost:${PORT}/pending`);
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
  printPendingAlert(nextCmd);
  console.log(`   → Command queued as ${nextCmdId} — awaiting OURSELF approval.\n`);
}

// ── Routes ─────────────────────────────────────────────────────────────────

// POST /transmit — send a message to an agent
app.post('/transmit', async (req, res) => {
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

  const rows = cmds.length === 0
    ? '<p style="color:#555;font-style:italic;">No commands pending approval.</p>'
    : cmds.map(c => `
      <div style="border:1px solid #333;border-left:3px solid #c9a84c;padding:16px;margin-bottom:16px;border-radius:4px;background:#111;">
        <div style="font-family:monospace;font-size:10px;color:#555;letter-spacing:.1em;margin-bottom:6px;">${c.id} · proposed ${c.proposedAt}</div>
        <div style="font-family:monospace;font-size:15px;color:#e8e8e8;margin:6px 0;">$ ${escapeHtml(c.action)}</div>
        <div style="font-size:12px;color:#666;margin-bottom:3px;">Dir: ${escapeHtml(c.workingDir)}</div>
        <div style="font-size:13px;color:#999;margin-bottom:14px;line-height:1.5;">Rationale: ${escapeHtml(c.rationale)}</div>
        <form method="POST" action="/approve/${c.id}" style="display:inline;">
          <button type="submit" style="padding:9px 22px;background:#4a9960;border:none;color:#fff;font-family:monospace;font-size:11px;letter-spacing:.12em;cursor:pointer;border-radius:3px;margin-right:8px;">APPROVE</button>
        </form>
        <form method="POST" action="/reject/${c.id}" style="display:inline;">
          <button type="submit" style="padding:9px 22px;background:#8b2020;border:none;color:#fff;font-family:monospace;font-size:11px;letter-spacing:.12em;cursor:pointer;border-radius:3px;">REJECT</button>
        </form>
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
  <div class="sub">OURSELF APPROVAL GATE · Auto-refreshes every 5s · ${cmds.length} pending</div>
  ${rows}
  <p style="margin-top:40px;border-top:1px solid #1a1a1a;padding-top:16px;">
    <a href="/log">View transmission log →</a>
  </p>
</body>
</html>`);
});

// POST /approve/:id
app.post('/approve/:id', async (req, res) => {
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

// POST /reject/:id
app.post('/reject/:id', async (req, res) => {
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

// POST /test — submit the first safe test command into the approval queue
app.post('/test', (req, res) => {
  const testCmd = firstTestCommand();
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
  printPendingAlert(pendingEntry);

  res.json({
    message: 'First safe test command added to approval queue.',
    command: pendingEntry,
    next: `Approve at: POST http://localhost:${PORT}/approve/${cmdId}`,
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

// ── Start ──────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('⚡ ÆTHERNET AGENT BRIDGE — ALIVE');
  console.log(`   Transmit:  POST http://localhost:${PORT}/transmit`);
  console.log(`   Pending:   http://localhost:${PORT}/pending`);
  console.log(`   Test:      POST http://localhost:${PORT}/test`);
  console.log(`   Log:       http://localhost:${PORT}/log`);
  console.log(`   Health:    http://localhost:${PORT}/health`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
});
