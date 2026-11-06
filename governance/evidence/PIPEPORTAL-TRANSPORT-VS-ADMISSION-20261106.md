# PIPE|PORTAL transport / admission separation

**Observed:** 2026-11-06  
**Kernel disposition:** TRANSPORT AVAILABLE · PORTAL ADMISSION NOT ESTABLISHED

## Verified transport facts

- Mac PipePortal process is live at `127.0.0.1:49320`; `GET /healthz` returned HTTP 200.
- Pi-initiated SSH reverse forwarding makes SELFPI Ollama `127.0.0.1:11434` available at Mac loopback `127.0.0.1:11435`.
- Mac requests to the forwarded `/api/tags` and `/v1/models` endpoints returned HTTP 200.
- The tunnel is loopback-only and has a Pi-side reconnect watchdog registered for boot.

## Admission invariants

```text
TRANSPORT_REACHABLE != TRUST_CONFIGURED
TRUST_CONFIGURED != TRUST_BUNDLE_VERIFIED
TRUST_BUNDLE_VERIFIED != HOST_ADMIN_ADMITTED
SSH_AUTHENTICATED != PORTAL_ADMISSION
```

## Explicit current state

| Predicate | Value |
|---|---|
| Independent PORTAL trust root | NOT CONFIGURED |
| Trust bundle | NOT VERIFIED |
| Host-admin pipe | NOT CONFIGURED |
| Direct Mac-to-Pi TCP 22 | FILTERED |
| Firewall changes | NONE |
| New keys / root identities | NONE GENERATED |
| Raw SSH shell as PORTAL substitute | NOT EXPOSED |

No PORTAL signer, independent root custodian, trust bundle, or host-admin capability was created or inferred from the SSH tunnel. No firewall or router rules were modified.

**Admission result:** DENY / NOT ADMISSIBLE until the independently controlled root, signed bundle, identity and jurisdiction evidence, scoped authority grant, and host-admin preflight are verified. This record changes no admission decision.


## REVERSELF configuration implementation and verification (2026-11-06)

Implemented on OURSELFMAC in `runtime/aetherbridge/`:

- `config/pipeportal-reverself-config.v1.json`: explicit six-fact reconciliation contract and run-change ledger.
- `portal-reverself-preflight.mjs`: live read-only verifier. It reads PipePortal `/healthz`, probes direct OURSELFMAC → OURSELFPIMAC TCP/22 independently of the reverse Ollama tunnel, and emits a six-fact JSON report.
- Report path from this run: `/tmp/portal-rever-self-preflight.json` (ephemeral verification output, not authority evidence).

Six facts observed independently:
1. Independent PORTAL root: **NOT_CONFIGURED**.
2. INPUTSELFTRUSTSELF bundle + authority lineage: **NOT_VERIFIED**.
3. mTLS host-admin pipe: **NOT_CONFIGURED** (reason: `PORTAL_TRUST_UNVERIFIED`).
4. Direct Mac → Pi TCP/22: **FILTERED_OR_UNREACHABLE** (connect timed out). This does not contradict the working reverse Ollama API tunnel.
5. Firewall policy: **NO_CHANGE_BY_THIS_RUN**.
6. New keys/root identities: **NONE_CREATED_BY_THIS_RUN**; no raw SSH shell tunnel created.

Verification:
- PipePortal health: `LIVE`, PID `6056`.
- Preflight correctly returned `FAIL_CLOSED_TRUST_OR_HOST_ADMIN_PRECONDITIONS_UNSATISFIED` and exit code `2`; this is the expected negative result while independent trust evidence is absent.
- Existing AetherBridge + host-admin tests: **45 passed, 0 failed**.
- JavaScript syntax check: passed.

No production trust values were fabricated. No launchd trust environment, service source, firewall, SSH policy, keys, or authority records were mutated. No default-branch update, PR, or merge was performed. Transport remains distinct from trust, admission, and host administration.


### Durable local verification artifacts

- `runtime/aetherbridge/config/pipeportal-reverself-config.v1.json`
  SHA-256: `af3c4fcadcb19ae9e481d65dac27b2bee5d217be3f7b8068e0cb73dfb097b372`
- `runtime/aetherbridge/portal-reverself-preflight.mjs`
  SHA-256: `cb813855008859bccdef19b86aca69b636f016772814b321e447e00faa89ee3a`
- `runtime/aetherbridge/logs/PIPEPORTAL-REVERSELF-PREFLIGHT-20261106.json`
  SHA-256: `cb4afc779457c1e9404607c5bb07ae27cbf8671bc6eb2801a82f5cb8889a91e9`

The report was copied from the live preflight output into the repository evidence log, re-read as JSON, and checked to contain exactly six fact records. The three trust/admin facts remain negative by design; the verifier exits nonzero rather than promote incomplete trust.
