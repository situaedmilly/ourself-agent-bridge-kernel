// Operator entry point for the existing synchronous T-027..T-033 proof path.
// The config module is trusted executable composition code selected by the
// operator. No request field may select a verifier, root, module, or adapter.
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createProofPathDriver, verifyPersistedProofChain } from './proof-path-driver.js';
import { canonicalHash } from '../persistence/canonical-json.js';

// Bind the whole reviewed request; a presentation credential is supplied later
// and is checked independently by T-031. No other decision field is excluded.
export function computeRequestDigest(request) {
  const decision = { ...request.decision };
  delete decision.presentedToken;
  return canonicalHash({ ...request, decision });
}

const MAX_REQUEST_BYTES = 1024 * 1024;
const USAGE = `Usage:
  node tools/proof-path-cli.js run --config /absolute/trusted-config.mjs < request.json
  node tools/proof-path-cli.js verify --storage-root /absolute/store --proposal-id ID

run: consumes one request from stdin; authority comes from the operator's
trusted config module, never from request-supplied configuration.
verify: reads persisted evidence without loading execution configuration.
Exit codes: 0 verified completion or lawful rejection; 1 failed/unresolved
execution or verification; 2 invalid invocation/configuration/input.
`;

function parseArgs(args) {
  if (args.length === 1 && args[0] === '--help') return { mode: 'help' };
  const [mode, ...rest] = args;
  const allowed = mode === 'run' ? ['--config']
    : mode === 'verify' ? ['--storage-root', '--proposal-id'] : [];
  if (!allowed.length || rest.length !== allowed.length * 2) throw new Error('INVALID_ARGUMENTS');
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    if (!allowed.includes(key) || options[key] !== undefined || !rest[i + 1]
        || rest[i + 1].startsWith('--')) throw new Error('INVALID_ARGUMENTS');
    options[key] = rest[i + 1];
  }
  const root = options['--config'] ?? options['--storage-root'];
  if (!isAbsolute(root)) throw new Error('ABSOLUTE_PATH_REQUIRED');
  return { mode, options };
}

async function readRequest(input) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_REQUEST_BYTES) throw new Error('REQUEST_TOO_LARGE');
    chunks.push(buffer);
  }
  const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('INVALID_REQUEST');
  const allowed = new Set(['envelope', 'reviewResult', 'decision']);
  if (Object.keys(request).some(key => !allowed.has(key))) throw new Error('UNKNOWN_REQUEST_FIELD');
  return request;
}

// Output contains only the bounded driver disposition. Stage records stay in
// the existing proof store; raw requests, tokens, stdout, and exception messages
// are deliberately excluded from the CLI summary.
function summarize(result, verification) {
  return {
    ok: result.ok === true,
    completed: result.completed === true,
    driver_version: result.driver_version,
    proposal_id: result.proposal_id ?? null,
    halted_at: result.halted_at ?? null,
    outcome: result.outcome ?? null,
    error: result.error ?? null,
    proof_chain_valid: verification ? verification.ok === true : null,
  };
}

export async function main(args, { input = process.stdin, output = process.stdout } = {}) {
  const emit = value => output.write(`${JSON.stringify(value)}\n`);
  let phase = 'arguments';
  try {
    const { mode, options } = parseArgs(args);
    if (mode === 'help') { output.write(USAGE); return 0; }
    if (mode === 'verify') {
      phase = 'verification';
      const result = await verifyPersistedProofChain({
        storageRoot: options['--storage-root'], proposalId: options['--proposal-id'],
      });
      emit({ mode, ok: result.ok, proposal_id: result.proposal_id,
        driver_version: result.driver_version,
        checks: Object.fromEntries(Object.entries(result.checks ?? {}).map(([key, check]) => [key, {
          ok: check.ok === true, valid: check.valid ?? null, error: check.error ?? null,
          ...(check.witnessed !== undefined ? { witnessed: check.witnessed } : {}),
          ...(check.reconciled !== undefined ? { reconciled: check.reconciled } : {}),
        }])), error: result.error ?? null });
      return result.ok ? 0 : 1;
    }
    phase = 'input';
    const request = await readRequest(input);
    phase = 'configuration';
    // Readability check before import yields a bounded configuration failure.
    await readFile(options['--config']);
    const { default: config } = await import(pathToFileURL(options['--config']).href);
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('INVALID_CONFIG');
    if (config.executionSpawnImpl !== undefined || config.observationSpawnImpl !== undefined
        || config.now !== undefined) throw new Error('TEST_SEAM_IN_OPERATOR_CONFIG');
    if (typeof config.requestDigest !== 'string' || !/^[a-f0-9]{64}$/.test(config.requestDigest)) {
      throw new Error('REVIEWED_REQUEST_DIGEST_REQUIRED');
    }
    phase = 'preimage';
    if (computeRequestDigest(request) !== config.requestDigest) {
      emit({ ok: false, phase, error: 'REVIEWED_REQUEST_MISMATCH', effect_state: 'NOT_ATTEMPTED' });
      return 1;
    }
    const driver = createProofPathDriver(config);
    phase = 'execution';
    const result = await driver.runProofPath(request);
    const verification = result.completed
      ? await driver.verifyProofChain({ proposalId: result.proposal_id }) : null;
    emit({ ...summarize(result, verification), request_digest: config.requestDigest });
    if (!result.ok || (verification && !verification.ok)) return 1;
    if (!result.completed) return result.outcome === 'REJECTED_BY_HUMAN_TURN' ? 0 : 1;
    return result.outcome?.outcome_class === 'SUCCESS_CONFIRMED' ? 0 : 1;
  } catch {
    // Exception strings can contain submitted tokens or provider output.
    emit({ ok: false, phase, error: 'PROOF_PATH_CLI_FAILED',
      effect_state: phase === 'execution' ? 'NOT_ESTABLISHED_RECONTACT_REQUIRED' : 'NOT_ATTEMPTED' });
    return phase === 'execution' || phase === 'verification' ? 1 : 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
