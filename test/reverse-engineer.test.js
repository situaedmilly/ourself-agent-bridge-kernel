// test/reverse-engineer.test.js
// ── Bridge Pass 20C · reverse_engineer structured analysis route ─────────────
// Proves the route is a SAFE inspection organ, never a mutation vector:
//   • token-gated and approval-gated;
//   • in-process read-only analysis — never calls executeCommand / shell / net;
//   • refuses outside-boundary traversal and secret-bearing paths;
//   • returns the strict structured artifact; performs no disk mutation;
//   • the frozen reverse_engineer shell guarantees from 20A/20B still hold.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { startBridge, tokenHeader, BRIDGE_DIR } from './helpers/bridge-process.js';
import { analyzeTarget, resolveTargetWithinBoundary } from '../tools/reverse-engineer.js';
import { classifyCommand, evaluateApproval, NON_TERMINAL_CLASSES } from '../tools/execution-classes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULE_SRC = readFileSync(join(__dirname, '..', 'tools', 'reverse-engineer.js'), 'utf8');
// Invariants must test the CODE, not the documentation prose (which names the
// forbidden primitives to declare they are absent). Strip comments first.
const CODE_ONLY = MODULE_SRC
  .replace(/\/\*[\s\S]*?\*\//g, ' ')        // block comments
  .replace(/(^|[^:])\/\/.*$/gm, '$1');      // line comments (leaves any `://`)

// ── Source-level safety invariants (item 4 / no-mutation / no-remotes) ───────
test('the analysis primitive contains NO shell / process / exec primitive', () => {
  // child_process is the ONLY route to a shell in Node — its absence is airtight.
  // (Bare `.exec(` is excluded: that is RegExp.prototype.exec, used for parsing.)
  assert.doesNotMatch(CODE_ONLY, /child_process|executeCommand|\bspawnSync\b|\bspawn\s*\(|execSync|execFileSync|\bexecFile\s*\(/);
});

test('the analysis primitive contains NO write / mutation fs primitive', () => {
  assert.doesNotMatch(CODE_ONLY, /writeFile|appendFile|mkdir|rmdir|unlink|createWriteStream|\brmSync\b|\brm\b\s*\(/);
});

test('the analysis primitive contains NO network / remote primitive', () => {
  assert.doesNotMatch(CODE_ONLY, /\bfetch\s*\(|https?:\/\/|\bnet\.|\bdgram\b|\btls\b|\bhttp\b\s*\.|XMLHttpRequest/);
});

// ── Frozen reverse_engineer shell guarantees still hold (items 1-3) ──────────
test('classifyCommand still NEVER emits reverse_engineer for shell strings', () => {
  for (const c of ['ls', 'git status', 'cat x.js', 'grep foo bar', 'npm test', 'node x.js']) {
    assert.notEqual(classifyCommand(c).class, 'reverse_engineer', c);
  }
});

test('evaluateApproval(reverse_engineer, <shell>) still fails closed (non_terminal_class)', () => {
  const v = evaluateApproval('reverse_engineer', 'ls -la');
  assert.equal(v.ok, false);
  assert.equal(v.code, 'non_terminal_class');
});

test('reverse_engineer remains a non-terminal class', () => {
  assert.ok(NON_TERMINAL_CLASSES.includes('reverse_engineer'));
});

// ── Boundary + secret gating (items 5-6, primitive level) ────────────────────
test('resolveTargetWithinBoundary refuses an outside-boundary path', () => {
  assert.throws(() => resolveTargetWithinBoundary('/etc'), (e) => e.code === 'outside_boundary');
});

test('resolveTargetWithinBoundary refuses traversal that escapes the boundary', () => {
  assert.throws(() => resolveTargetWithinBoundary('../../../etc/passwd'), (e) =>
    e.code === 'outside_boundary' || e.code === 'unresolvable_path');
});

test('resolveTargetWithinBoundary refuses a secret-bearing path BEFORE touching the fs', () => {
  assert.throws(() => resolveTargetWithinBoundary('/Users/millysituated/RUORA/.env'),
    (e) => e.code === 'secret_path');
  assert.throws(() => resolveTargetWithinBoundary('projects/agent-bridge/secrets.json'),
    (e) => e.code === 'secret_path');
});

test('analyzeTarget also refuses a secret-bearing target (defense in depth)', () => {
  assert.throws(() => analyzeTarget('/Users/millysituated/RUORA/id_rsa'), (e) => e.code === 'secret_path');
});

// ── Structured artifact contract (item 7, primitive level) ───────────────────
test('analyzeTarget returns the strict structured artifact for an in-boundary repo', () => {
  const a = analyzeTarget(BRIDGE_DIR, 're-unit');
  assert.equal(a.class, 'reverse_engineer');
  assert.equal(a.analysis_only, true);
  assert.equal(a.mutation, false);
  assert.equal(a.terminal, false);
  assert.equal(a.target.within_boundary, true);
  assert.ok(a.target.resolved_path.startsWith('/Users/millysituated/RUORA'));
  // summary
  assert.equal(a.summary.project_type, 'node');
  assert.ok(a.summary.primary_languages.includes('JavaScript'));
  assert.ok(Array.isArray(a.summary.test_files));
  assert.ok(a.summary.config_files.includes('package.json'));
  // structure + signals
  assert.ok(a.structure.files.includes('server.js'));
  assert.ok(a.signals.dependencies.includes('express'));
  assert.ok(a.signals.routes.length > 0, 'should detect at least one express route');
  // non_actions contract — exact
  assert.deepEqual(a.non_actions, [
    'No files written',
    'No shell executed',
    'No terminal route used',
    'No remotes contacted',
  ]);
  // an analysis artifact is NOT a shell execution result
  assert.equal(a.stdout, undefined);
  assert.equal(a.stderr, undefined);
});

test('analyzeTarget never reads secret file contents — secret files surface as risks only', () => {
  const a = analyzeTarget(BRIDGE_DIR, 're-secrets');
  // .env exists in the bridge repo; it must appear only as an excluded risk,
  // never in the file listing, and its contents are never read.
  assert.ok(!a.structure.files.some(f => /(^|\/)\.env(\.|$)/.test(f)), '.env must not be listed');
});

// ── HTTP route behavior on an isolated bridge (items 7-12) ────────────────────
let bridge;
before(async () => { bridge = await startBridge({ env: { REALM_GATE_MAX_FAILURES: '100000' } }); });
after(async () => { await bridge?.stop(); });

test('POST /reverse-engineer is token-gated (missing → 401, wrong → 401)', async () => {
  const r1 = await fetch(bridge.baseUrl + '/reverse-engineer', { method: 'POST' });
  assert.equal(r1.status, 401);
  const r2 = await fetch(bridge.baseUrl + '/reverse-engineer', {
    method: 'POST', headers: { 'content-type': 'application/json', ...tokenHeader('nope') },
    body: JSON.stringify({ target_path: BRIDGE_DIR }),
  });
  assert.equal(r2.status, 401);
});

test('POST /reverse-engineer refuses an outside-boundary target → 400 outside_boundary', async () => {
  const r = await fetch(bridge.baseUrl + '/reverse-engineer', {
    method: 'POST', headers: { 'content-type': 'application/json', ...tokenHeader(bridge.token) },
    body: JSON.stringify({ target_path: '/etc' }),
  });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).code, 'outside_boundary');
});

test('POST /reverse-engineer refuses a secret-bearing target → 400 secret_path', async () => {
  const r = await fetch(bridge.baseUrl + '/reverse-engineer', {
    method: 'POST', headers: { 'content-type': 'application/json', ...tokenHeader(bridge.token) },
    body: JSON.stringify({ target_path: '/Users/millysituated/RUORA/.env' }),
  });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).code, 'secret_path');
});

test('reverse_engineer is APPROVAL-GATED: enqueue is pending with no artifact; analysis runs only on approve', async () => {
  // 1. enqueue — pending, no analysis yet
  const enq = await fetch(bridge.baseUrl + '/reverse-engineer', {
    method: 'POST', headers: { 'content-type': 'application/json', ...tokenHeader(bridge.token) },
    body: JSON.stringify({ target_path: BRIDGE_DIR }),
  });
  assert.equal(enq.status, 200);
  const enqBody = await enq.json();
  assert.equal(enqBody.request.status, 'pending');
  assert.equal(enqBody.request.executionClass, 'reverse_engineer');
  assert.equal(enqBody.request.kind, 'analysis');
  assert.equal(enqBody.request.result, undefined, 'no artifact before approval');
  const id = enqBody.request.id;

  // 2. approve — analysis runs, strict artifact returned, NON-terminal
  const appr = await fetch(bridge.baseUrl + '/approve/' + id, {
    method: 'POST', headers: tokenHeader(bridge.token),
  });
  assert.equal(appr.status, 200);
  const apprBody = await appr.json();
  assert.equal(apprBody.status, 'analyzed');
  assert.ok(apprBody.artifact, 'artifact present after approval');
  assert.equal(apprBody.artifact.class, 'reverse_engineer');
  assert.equal(apprBody.artifact.mutation, false);
  assert.equal(apprBody.artifact.terminal, false);
  assert.equal(apprBody.artifact.target.within_boundary, true);
  assert.ok(apprBody.artifact.non_actions.includes('No shell executed'));
  // an analysis result is never a shell execution result
  assert.equal(apprBody.result, undefined);
  assert.equal(apprBody.artifact.stdout, undefined);
});
