// tools/setup-secret.js
// ── Pass 18 · Idempotent Secret Setup ───────────────────────────────────────
//
// Provisions BRIDGE_TOKEN into the gitignored .env so the authenticated bridge
// can start. Designed to be run any number of times safely:
//
//   • If BRIDGE_TOKEN already has a non-empty value in .env, it is left
//     untouched (idempotent — re-running never rotates or clobbers it).
//   • If it is absent (or an empty placeholder), a cryptographically random
//     value is generated with crypto.randomBytes and appended to .env.
//   • The token VALUE is NEVER printed — only the fact that it was written.
//   • .env is created if missing. It is gitignored, so the secret never enters
//     version control.
//
// Run with:  npm run setup
import { randomBytes } from 'crypto';
import { readFile, appendFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(__dirname, '..', '.env');

// Matches a BRIDGE_TOKEN line that already carries a non-empty value.
const HAS_NONEMPTY_TOKEN = /^BRIDGE_TOKEN=.+$/m;

async function main() {
  let env = '';
  if (existsSync(ENV_PATH)) {
    env = await readFile(ENV_PATH, 'utf8');
  }

  if (HAS_NONEMPTY_TOKEN.test(env)) {
    console.log('✓ BRIDGE_TOKEN already present in .env — leaving it untouched (idempotent).');
    return;
  }

  // Generate a 256-bit token. Its value is intentionally never logged.
  const token = randomBytes(32).toString('hex');
  const line = `BRIDGE_TOKEN=${token}\n`;

  if (!existsSync(ENV_PATH)) {
    await writeFile(ENV_PATH, line, { mode: 0o600 });
  } else {
    // Ensure we start the new entry on its own line.
    const prefix = env.length > 0 && !env.endsWith('\n') ? '\n' : '';
    await appendFile(ENV_PATH, prefix + line);
  }

  console.log('✓ BRIDGE_TOKEN generated and written to .env.');
  console.log('  (The value is intentionally NOT printed.)');
  console.log('  The bridge reads it at startup; callers send it in x-ourself-token.');
  console.log('  .env is gitignored — the secret never enters version control.');
}

main().catch((err) => {
  console.error('✗ Secret setup failed:', err.message);
  process.exit(1);
});
