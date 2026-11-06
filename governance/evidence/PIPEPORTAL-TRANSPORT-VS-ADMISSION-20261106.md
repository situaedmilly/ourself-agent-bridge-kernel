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
