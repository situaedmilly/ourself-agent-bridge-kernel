// test/path-boundary.test.js
// ── Bridge Pass 20 · RUORA path boundary (direct import) ─────────────────────
// Proves executeCommand confines work to the RUORA boundary using RESOLVED
// paths (not string-prefix), and rejects /tmp and ../ traversal. Only harmless
// read-only `pwd` is ever run, and only for the in-boundary case.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeCommand } from '../tools/terminal.js';

const RUORA = '/Users/millysituated/RUORA';

test('inside the RUORA boundary: harmless pwd executes', async () => {
  const res = await executeCommand('pwd', RUORA);
  assert.equal(res.stdout, RUORA);
  assert.equal(res.workingDir, RUORA);
});

test('outside the boundary (/tmp): rejected before any shell', async () => {
  await assert.rejects(
    () => executeCommand('pwd', '/tmp'),
    /Working directory must be within/,
  );
});

test('traversal up-and-out (RUORA/projects/../..) resolves outside → rejected', async () => {
  // Resolves to /Users/millysituated — a prefix-naive check would wrongly allow
  // it; resolved-path enforcement rejects it.
  await assert.rejects(
    () => executeCommand('pwd', `${RUORA}/projects/../..`),
    /Working directory must be within/,
  );
});

test('sibling-prefix traversal (RUORA/../RUORA-evil) rejected', async () => {
  // "/Users/millysituated/RUORA-evil" starts with "/Users/millysituated/RUORA"
  // as a string but is NOT within the boundary dir. Must be rejected.
  await assert.rejects(
    () => executeCommand('pwd', `${RUORA}/../RUORA-evil`),
    /Working directory must be within/,
  );
});

test('a missing working directory is rejected', async () => {
  await assert.rejects(() => executeCommand('pwd', ''), /Working directory is required/);
});
