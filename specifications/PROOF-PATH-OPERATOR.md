# Synchronous AgentBridge operator entry

The existing SL-003 proof-path driver already composes intake, persistence,
Human-TURN, bounded execution, independent observation, and reconciliation.
`tools/proof-path-cli.js` makes that driver callable by an operator-controlled
process. A second process can recontact its persisted chain without loading
an execution configuration or possessing an authorization credential.

## Run one governed request

Provision an operator-owned ES module outside message custody. Its default
export is the existing `createProofPathDriver` configuration:

```js
import { createStaticHumanTurnTokenVerifier } from
  '/absolute/kernel/persistence/human-turn-decisions.js';

export default {
  requestDigest: '64-lowercase-hex-digest-of-the-reviewed-request',
  storageRoot: '/absolute/proof-store',
  authorizedExecutionRoot: '/absolute/authorized-workspace',
  verifyHumanTurnAuthorization: createStaticHumanTurnTokenVerifier({
    proposalId: 'the-exact-approved-proposal-id',
    decision: 'AUTHORIZE',
    authorityId: 'MYSELF',
    expectedToken: process.env.OURSELF_EXPECTED_HUMAN_TURN_TOKEN,
  }),
  timeoutMs: 10000,
  maxOutputBytes: 65536,
};
```

The static verifier is the existing T-031 credential-agreement mechanism.
The operator config also requires `requestDigest`, computed with the exported
`computeRequestDigest(request)` from `tools/proof-path-cli.js` on the reviewed
request before handing it to the execution caller. This uses the existing
protocol canonical hash and excludes only `decision.presentedToken`. Envelope,
adapted proposal, target, intent, decision identity, timestamp, reason, and
constraints remain bound. Key order does not change the digest.

Freeze that value in the operator config. Do not compute it from the live inbound
request during invocation: doing so would remove the independent preimage check.
Missing digest is a configuration failure; mismatch stops before proposal
persistence, authorization, or dispatch. The invocation summary includes the
matched digest. This binds request content, not the bytes of external target
files; execution-time filesystem boundaries remain the executor's responsibility.

The credential check remains separate:
It binds proposal ID, decision, and deciding authority; it does not independently
prove physical human identity. Use the estate's trusted verifier where stronger
authority semantics are required. Never derive expected credentials or trusted
configuration from the inbound request. The config module is executable trusted
code: choose it locally, not from a webhook, locator, or message field.

Submit the existing driver request shape on stdin: exactly one `envelope` or
`reviewResult`, plus `decision`. The decision carries `decision`, `decisionId`,
`decidedBy`, `decidedAt`, `reason`, `presentedToken`, and optional `constraints`.
The envelope contract remains `ourself.ae-kernel.v1`; no new schema is introduced.
Prefer the envelope intake path for control-plane exchange. An adapted review
result retains the existing driver's trusted-caller assumptions.

```sh
npm run --silent proof:run -- --config /absolute/operator-config.mjs < /secure/request.json
```

Request input is bounded to 1 MiB. Do not commit credential-bearing input.
Unknown top-level request fields and CLI options are rejected. The operator
entry refuses the driver's fake-spawn and clock test seams. Output is one JSON
summary; detailed stage evidence remains in the existing proof store.

## Recontact from a fresh process

```sh
npm run --silent proof:verify -- --storage-root /absolute/proof-store --proposal-id the-exact-approved-proposal-id
```

Verification composes the existing proposal, witness, reconciliation, and ledger
checks. All must report valid integrity, and the witness and reconciliation must
actually exist. Pending, rejected, or partially completed proposals cannot pass
as completed chains. `verifyPersistedProofChain` exposes the same read-only check
to other callers without constructing an execution-capable driver.

Integrity verification is distinct from semantic success: a fully witnessed,
validly reconciled failure can be an intact proof chain. Inspect the recorded
reconciliation to determine its semantic outcome. The `run` command exits 0 only
for `SUCCESS_CONFIRMED` with a valid chain or an explicit lawful Human-TURN
rejection; the latter always has `completed: false`.

Exit 1 means failed, incomplete, or unresolved execution/verification. Exit 2
means invalid invocation, input, or operator configuration. An exception after
dispatch reports `NOT_ESTABLISHED_RECONTACT_REQUIRED`; it never asserts that no
effect occurred. Do not blindly retry an interrupted act: recontact its proposal
and use the existing stage-specific recovery behavior.

## Scope and reversal

This entry uses the existing bounded operation and authority rules. It does not
activate T-034, start a server/daemon, implement webhook ingress, invoke a model,
mint SELF identities, or promote institutional standing. Proposal identity is
preserved; it is not relabeled as occurrence genesis.

To withdraw the entry, remove the two `proof:*` scripts and CLI and revert the
associated source change through ordinary Git review. This does not reverse
effects already performed: their recovery belongs to their execution contracts.
Preserve their proof stores.

## Validation

`node --test test/proof-path-cli.test.js test/proof-path-driver.test.js`
exercises real Git subprocess execution and independent observation, fresh-process
verification, ledger corruption, rejected/pending chain discrimination, wrong
credentials, request configuration injection, malformed/oversized input, test-seam
refusal, missing evidence, and a real failed Git operation.

Tests use disposable workspaces and generated test credentials; these are execution
witnesses for the integration tests, not a production launch or Founder act receipt.

The operator tests additionally stage a real `effect.txt` through the existing
SL-008A operation, confirm that an unrelated file stays unstaged, cold-verify the
proof in another process, and refuse a repeated execution. Substituted target,
intent, decision identity, or constraints are refused despite retaining the same
proposal ID and presented credential. Test processes run outside the kernel cwd.
