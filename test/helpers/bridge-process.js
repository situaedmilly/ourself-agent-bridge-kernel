// test/helpers/bridge-process.js
// ── Bridge Pass 20 · Isolated bridge launcher ───────────────────────────────
//
// Launches the sealed bridge as a disposable child process for security
// regression tests. Every isolated bridge:
//   • reads a throwaway BRIDGE_TOKEN supplied ONLY via spawned env;
//   • is pointed at a disposable empty .env via DOTENV_CONFIG_PATH, so the
//     production .env is NEVER read, parsed, copied, or relied upon;
//   • binds to an ephemeral 127.0.0.1 loopback port (never 3001);
//   • writes its JSONL logs into a temp directory (BRIDGE_LOG_PATH /
//     BRIDGE_QUEUE_PATH), so production logs are never touched.
//
// The throwaway token is generated per launch and never written to disk or
// printed. No live cognition provider is contacted — tests use intentionally
// incomplete payloads that cross the auth boundary then hit route validation.

import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { randomBytes } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const BRIDGE_DIR = join(__dirname, '..', '..');     // …/agent-bridge
const SERVER = join(BRIDGE_DIR, 'server.js');
const PRODUCTION_PORT = 3001;

/** Allocate a free ephemeral loopback port, then release it for the child. */
export function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Create a disposable test directory containing an empty .env. */
export async function makeTempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-pass20-'));
  await writeFile(join(dir, '.env'), '# disposable test env — intentionally empty\n', { mode: 0o600 });
  return dir;
}

/** Build the isolated child environment. Throwaway token only; no live keys. */
function childEnv({ tempDir, token, port, withToken = true, extra = {} }) {
  const env = {
    ...process.env,
    DOTENV_CONFIG_PATH: join(tempDir, '.env'),   // never the production .env
    BIND_HOST: '127.0.0.1',
    PORT: String(port),
    BRIDGE_LOG_PATH: join(tempDir, 'transmissions.jsonl'),
    BRIDGE_QUEUE_PATH: join(tempDir, 'queue.jsonl'),
    // Ensure no live provider keys leak in from the parent shell.
    ANTHROPIC_API_KEY: '',
    OPENAI_API_KEY: '',
    ...extra,
  };
  if (withToken) env.BRIDGE_TOKEN = token;
  else delete env.BRIDGE_TOKEN;
  return env;
}

/**
 * Spawn the bridge WITHOUT a token and resolve its exit code.
 * Used to prove fail-closed startup. Never binds (exits before listen).
 */
export async function startWithoutToken() {
  const tempDir = await makeTempDir();
  const port = await getFreePort();
  if (port === PRODUCTION_PORT) throw new Error('refusing production port');
  const proc = spawn(process.execPath, [SERVER], {
    cwd: BRIDGE_DIR,
    env: childEnv({ tempDir, port, withToken: false }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d.toString(); });
  const code = await new Promise((resolve) => proc.on('exit', (c) => resolve(c)));
  await rm(tempDir, { recursive: true, force: true });
  return { code, stderr };
}

/**
 * Start an isolated bridge and wait until /health is alive.
 * @param {object} opts
 * @param {string} [opts.tempDir]  reuse an existing temp dir (for restart tests)
 * @param {string} [opts.token]    reuse a token (for restart tests)
 * @returns {Promise<{baseUrl,port,token,tempDir,proc,stop}>}
 */
export async function startBridge(opts = {}) {
  const tempDir = opts.tempDir || (await makeTempDir());
  const token = opts.token || randomBytes(24).toString('hex');
  const port = await getFreePort();
  if (port === PRODUCTION_PORT) throw new Error('refusing production port');

  const proc = spawn(process.execPath, [SERVER], {
    cwd: BRIDGE_DIR,
    env: childEnv({ tempDir, token, port }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d.toString(); });

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 8000;
  let ready = false;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`bridge exited early (code ${proc.exitCode}). stderr:\n${stderr}`);
    }
    try {
      const r = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(500) });
      if (r.ok) { ready = true; break; }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!ready) {
    proc.kill('SIGKILL');
    throw new Error(`bridge did not become healthy. stderr:\n${stderr}`);
  }

  async function stop({ keepTempDir = false } = {}) {
    if (proc.exitCode === null) {
      proc.kill('SIGTERM');
      await new Promise((resolve) => {
        const t = setTimeout(() => { proc.kill('SIGKILL'); resolve(); }, 2000);
        proc.on('exit', () => { clearTimeout(t); resolve(); });
      });
    }
    if (!keepTempDir) await rm(tempDir, { recursive: true, force: true });
  }

  return { baseUrl, port, token, tempDir, proc, stop };
}

/** Auth header helper. */
export function tokenHeader(token) {
  return { 'x-ourself-token': token };
}
