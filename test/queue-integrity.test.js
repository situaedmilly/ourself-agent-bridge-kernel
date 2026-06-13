// test/queue-integrity.test.js
// ── Bridge Pass 20 · Queue sovereignty against an isolated bridge ────────────
// Replay protection, rehydration-as-pending across an isolated restart (no
// auto-execution), firewall denial of an approved-but-dangerous command, and
// proof that the throwaway token never lands in the disposable logs. All
// executions are harmless read-only `pwd` inside the in-boundary bridge dir.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startBridge, tokenHeader, BRIDGE_DIR } from './helpers/bridge-process.js';

const authJson = (token, body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...tokenHeader(token) },
  body: JSON.stringify(body),
});

async function queuePwd(bridge, rationale = 'pass20 queue proof') {
  const r = await fetch(bridge.baseUrl + '/test', authJson(bridge.token, {
    action: 'pwd', working_dir: BRIDGE_DIR, rationale,
  }));
  assert.equal(r.status, 200);
  return (await r.json()).command.id;
}

test('replay protection: first approval executes once, replay → 409', async () => {
  const bridge = await startBridge();
  try {
    const id = await queuePwd(bridge);
    const first = await fetch(bridge.baseUrl + '/approve/' + id, { method: 'POST', headers: tokenHeader(bridge.token) });
    assert.equal(first.status, 200);
    assert.equal((await first.json()).status, 'executed');

    const replay = await fetch(bridge.baseUrl + '/approve/' + id, { method: 'POST', headers: tokenHeader(bridge.token) });
    assert.equal(replay.status, 409, 'replay approval must be rejected');
  } finally {
    await bridge.stop();
  }
});

test('rehydration: pending survives isolated restart as pending-only, then approves once', async () => {
  // Start, queue, stop but KEEP the temp dir + token so the restart reads the
  // same disposable queue.jsonl.
  let bridge = await startBridge();
  const { tempDir, token } = bridge;
  let id;
  try {
    id = await queuePwd(bridge, 'pass20 rehydration proof');
  } finally {
    await bridge.stop({ keepTempDir: true });
  }

  // Restart against the same disposable queue.
  bridge = await startBridge({ tempDir, token });
  try {
    const state = await (await fetch(bridge.baseUrl + '/ourself/state')).json();
    const restored = state.pending.find((c) => c.id === id);
    assert.ok(restored, 'command must rehydrate');
    assert.equal(restored.rehydrated, true, 'must be flagged rehydrated');
    assert.equal(state.counts.pending, 1);
    // It must NOT have auto-executed — still pending, awaiting fresh approval.

    const approve = await fetch(bridge.baseUrl + '/approve/' + id, { method: 'POST', headers: tokenHeader(token) });
    assert.equal(approve.status, 200);
    assert.equal((await approve.json()).status, 'executed', 'execution only after explicit approval');
  } finally {
    await bridge.stop();   // now removes the temp dir
  }
});

test('approved-but-dangerous command is firewall-denied before any shell', async () => {
  const bridge = await startBridge();
  try {
    const r = await fetch(bridge.baseUrl + '/test', authJson(bridge.token, {
      action: 'chmod 777 ./x', working_dir: BRIDGE_DIR, rationale: 'pass20 firewall-at-exec probe',
    }));
    const id = (await r.json()).command.id;
    const approve = await fetch(bridge.baseUrl + '/approve/' + id, { method: 'POST', headers: tokenHeader(bridge.token) });
    const j = await approve.json();
    assert.equal(j.status, 'failed', 'firewall must block at execution time');
    assert.match(j.error, /firewall/i, 'error names the firewall');
    assert.match(j.error, /perm\.world_writable/, 'error carries the stable rule id');
  } finally {
    await bridge.stop();
  }
});

test('throwaway token never appears in the disposable logs', async () => {
  const bridge = await startBridge();
  try {
    await queuePwd(bridge, 'pass20 log-scan');
    const id = await queuePwd(bridge, 'pass20 log-scan-2');
    await fetch(bridge.baseUrl + '/approve/' + id, { method: 'POST', headers: tokenHeader(bridge.token) });

    for (const f of ['transmissions.jsonl', 'queue.jsonl']) {
      const raw = await readFile(join(bridge.tempDir, f), 'utf8').catch(() => '');
      assert.ok(!raw.includes(bridge.token), `${f} must not contain the token`);
    }
  } finally {
    await bridge.stop();
  }
});

test('static: firewall denial log carries rule id, not the raw command', async () => {
  const src = await readFile(join(BRIDGE_DIR, 'tools', 'terminal.js'), 'utf8');
  // The denial warn line references the stable rule id + category, never the
  // raw `action` string.
  assert.match(src, /FIREWALL DENIED — rule=\$\{verdict\.pattern\} category=\$\{verdict\.category\}/);
  const warnLine = src.split('\n').find((l) => l.includes('FIREWALL DENIED'));
  assert.ok(warnLine && !warnLine.includes('${action}'), 'denial log must not embed the raw command');
});
