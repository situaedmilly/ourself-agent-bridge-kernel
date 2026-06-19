// test/firewall-by-class.test.js
// ── Bridge Pass 20B · Firewall-by-Class Hardening ───────────────────────────
// Proves the MUSCLE layer: enforceClassPolicy() permits only the command shapes
// allowed for each execution class, and the terminal executor refuses a
// disallowed shape BEFORE any shell is spawned — while the Pass 18 denylist
// remains the always-on final backstop.
//
// Unit cases pass strings only into the pure policy function. The few terminal
// cases that DO run use read-only commands inside the bridge repo, or assert a
// rejection that proves the command never reached the shell.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { enforceClassPolicy, CLASS_POLICY_TERMINAL_CLASSES } from '../tools/command-firewall.js';
import { executeCommand } from '../tools/terminal.js';
import { BRIDGE_DIR } from './helpers/bridge-process.js';

const allowed = (cmd, klass) => {
  const v = enforceClassPolicy(cmd, klass);
  assert.equal(v.allowed, true, `expected ${klass} to ALLOW: ${cmd} (got ${v.pattern})`);
};
const denied = (cmd, klass) => {
  const v = enforceClassPolicy(cmd, klass);
  assert.equal(v.allowed, false, `expected ${klass} to DENY: ${cmd}`);
  assert.ok(v.pattern, 'denial carries a stable rule id');
  assert.ok(v.reason, 'denial carries a reason');
};

// ── 1–2 · inspect ───────────────────────────────────────────────────────────
test('1. inspect allows safe read-only commands', () => {
  for (const c of ['ls -la', 'pwd', 'cat README.md', 'head -n 5 package.json', 'wc -l server.js']) {
    allowed(c, 'inspect');
  }
});

test('2. inspect blocks mutation / redirection / write', () => {
  for (const c of ['rm file.txt', 'mv a b', 'touch x', 'echo hi > out.txt', 'sed -i s/a/b/ f']) {
    denied(c, 'inspect');
  }
});

// ── 3–4 · git-read ──────────────────────────────────────────────────────────
test('3. git-read allows status/log/diff/show/branch/worktree list', () => {
  for (const c of ['git status --short', 'git log --oneline -3', 'git diff', 'git show HEAD', 'git branch', 'git branch -a', 'git worktree list']) {
    allowed(c, 'git-read');
  }
});

test('4. git-read blocks add/commit/checkout/reset/push/remote', () => {
  for (const c of ['git add .', 'git commit -m x', 'git checkout main', 'git reset --hard HEAD~1', 'git push origin main', 'git remote add origin REMOTE']) {
    denied(c, 'git-read');
  }
});

// ── 5–6 · git-write-local ───────────────────────────────────────────────────
test('5. git-write-local allows explicitly safe local git writes', () => {
  for (const c of ['git add .', 'git commit -m "x"', 'git merge feature', 'git reset --soft HEAD~1', 'git restore file.js', 'git stash']) {
    allowed(c, 'git-write-local');
  }
});

test('6. git-write-local blocks push / remotes / gh publication', () => {
  for (const c of ['git push origin main', 'git push --force', 'git remote add origin REMOTE', 'gh repo create my/thing --public', 'git pull']) {
    denied(c, 'git-write-local');
  }
});

// ── 7–8 · test ──────────────────────────────────────────────────────────────
test('7. test allows npm test / node --test / node --check', () => {
  for (const c of ['npm test', 'npm run test', 'node --test', 'node --check server.js']) {
    allowed(c, 'test');
  }
});

test('8. test blocks deploy / publish / curl / shell pipes', () => {
  for (const c of ['npm run deploy', 'npm publish', 'curl http://x.example', 'npm test | bash', 'vercel deploy']) {
    denied(c, 'test');
  }
});

// ── 9–10 · build ────────────────────────────────────────────────────────────
test('9. build allows local build', () => {
  for (const c of ['npm run build', 'npm ci', 'npm install', 'make', 'tsc -p .']) {
    allowed(c, 'build');
  }
});

test('10. build blocks deploy / publish / remote upload', () => {
  for (const c of ['npm run build && npm publish', 'npm run build && scp dist host:/srv', 'vercel deploy', 'npm run build && curl -T dist http://x']) {
    denied(c, 'build');
  }
});

// ── 11 · project-mutation boundary ──────────────────────────────────────────
test('11. project-mutation may write project files but not secrets/logs/outside', () => {
  for (const c of ['mkdir newdir', 'touch a.txt', 'cp a.txt b.txt', 'echo hi > out.txt']) {
    allowed(c, 'project-mutation');
  }
  for (const c of [
    'echo x > .env',
    'cp config.pem /tmp/x',
    'cat secrets.json',
    'rm logs/queue.jsonl',
    'echo tamper > logs/transmissions.jsonl',
    'mv credentials.json /tmp',
    'rm ../../etc/passwd',
  ]) {
    denied(c, 'project-mutation');
  }
});

// ── 12–13 · forbidden & reverse_engineer never reach the shell ──────────────
test('12. forbidden class never reaches the shell', () => {
  for (const c of ['ls', 'git status', 'rm -rf /', 'echo hi']) {
    const v = enforceClassPolicy(c, 'forbidden');
    assert.equal(v.allowed, false, c);
    assert.equal(v.pattern, 'class.non_terminal');
  }
});

test('13. reverse_engineer is terminal-forbidden (never reaches the shell)', () => {
  for (const c of ['ls', 'cat file.js', 'grep foo bar.js']) {
    const v = enforceClassPolicy(c, 'reverse_engineer');
    assert.equal(v.allowed, false, c);
    assert.equal(v.pattern, 'class.non_terminal');
  }
  assert.ok(!CLASS_POLICY_TERMINAL_CLASSES.includes('reverse_engineer'));
  assert.ok(!CLASS_POLICY_TERMINAL_CLASSES.includes('forbidden'));
});

// ── 14 · class mismatch / missing / unknown fail closed ─────────────────────
test('14. class mismatch / missing / unknown fail closed', () => {
  denied('git commit -m x', 'git-read');     // write shape under read class
  denied('rm -rf foo', 'inspect');           // mutation under inspect
  denied('ls', 'git-read');                  // non-git under git-read
  denied('npm publish', 'build');            // publish under build
  assert.equal(enforceClassPolicy('ls', undefined).pattern, 'class.missing');
  assert.equal(enforceClassPolicy('ls', 'banana').pattern, 'class.non_terminal');
  assert.equal(enforceClassPolicy('', 'inspect').pattern, 'class.empty');
});

// ── Terminal-level enforcement (defense in depth, real executor) ────────────
test('executor refuses a disallowed shape for its class BEFORE any shell', async () => {
  await assert.rejects(
    () => executeCommand('git commit -m x', BRIDGE_DIR, 'git-read'),
    (err) => {
      assert.equal(err.classPolicyDenied, true, 'class policy denial flagged');
      assert.equal(err.executionClass, 'git-read');
      assert.match(err.message, /class policy/i);
      return true;
    },
  );
});

test('executor refuses a network git command under git-read before any shell', async () => {
  await assert.rejects(
    () => executeCommand('git push origin main', BRIDGE_DIR, 'git-read'),
    (err) => {
      assert.equal(err.classPolicyDenied, true);
      assert.match(err.classPattern, /gitread\.network/);
      return true;
    },
  );
});

test('denylist remains the final backstop even when the class policy allows', async () => {
  // chmod 777 is shape-permitted for project-mutation, but the Pass 18 firewall
  // still blocks it as the always-on final layer.
  await assert.rejects(
    () => executeCommand('chmod 777 ./x', BRIDGE_DIR, 'project-mutation'),
    (err) => {
      assert.equal(err.firewallDenied, true, 'firewall is the final guard');
      assert.match(err.message, /perm\.world_writable/);
      return true;
    },
  );
});

test('executor runs a correctly-classed read-only command', async () => {
  const res = await executeCommand('git status --short', BRIDGE_DIR, 'git-read');
  assert.ok(res.executedAt, 'a verified git-read executes');
  const res2 = await executeCommand('pwd', BRIDGE_DIR, 'inspect');
  assert.ok(res2.stdout.includes('agent-bridge'), 'inspect pwd executes');
});

// ── Static wiring ───────────────────────────────────────────────────────────
test('static: terminal enforces class policy BEFORE the generic denylist', async () => {
  const src = await readFile(join(BRIDGE_DIR, 'tools', 'terminal.js'), 'utf8');
  const classIdx = src.indexOf('enforceClassPolicy(action, executionClass)');
  const fwIdx = src.indexOf('inspectCommand(action)');
  assert.ok(classIdx !== -1, 'terminal must call enforceClassPolicy');
  assert.ok(fwIdx !== -1, 'terminal must still call inspectCommand');
  assert.ok(classIdx < fwIdx, 'class policy must run before the generic denylist');
  // The class-policy denial log must not embed the raw command.
  const warnLine = src.split('\n').find((l) => l.includes('CLASS POLICY DENIED'));
  assert.ok(warnLine && !warnLine.includes('${action}'), 'class denial log must not embed the raw command');
});

test('static: /approve passes the execution class into the executor', async () => {
  const src = await readFile(join(BRIDGE_DIR, 'server.js'), 'utf8');
  assert.ok(
    src.includes('executeCommand(cmd.action, cmd.workingDir, cmd.executionClass)'),
    '/approve must pass cmd.executionClass to executeCommand',
  );
});
