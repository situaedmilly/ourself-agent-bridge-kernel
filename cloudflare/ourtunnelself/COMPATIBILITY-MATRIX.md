# OURTUNNELSELF → Cloudflare compatibility matrix

| Existing Node component | Cloudflare target | Status |
|---|---|---|
| Node HTTP router | Workers fetch handler | Implemented for scoped REST lifecycle |
| RS256 Seat JWT verification | Workers Web Crypto | Implemented; local crypto/contract path tested; OSOS issuer chain not validated |
| RS256 PORTAL verification | Workers Web Crypto | Implemented; local crypto/contract path tested; OSOS issuer chain not validated |
| PORTAL caller/device/capability binding | Worker policy layer | Implemented |
| Static device registry | Durable Object SQLite | Source routes and SQLite transitions implemented; Worker gate blocks until OSOS chain verification |
| In-memory job map | Durable Object SQLite | Queue, claim, caller-bound readback, result state implemented |
| Replay nonce cache | Durable Object SQLite | Atomic device nonce consumption implemented |
| Portal JTI replay prevention | Durable Object SQLite | Globally consumed across enrollment, revocation, and job requests |
| Ed25519 broker delivery envelope | Workers Web Crypto | Implemented; local crypto-vector tests pass; broker key certification pending |
| Device request authentication | Workers Web Crypto + DO nonce store | Implemented; end-to-end device test pending |
| Outbound HTTPS device agent | Mac/Pi local agent | Existing agent adapted with durable pending-result outbox retry |
| Evidence receipt record | Durable Object SQLite | Worker-signed provenance record implemented; independent witness and canonical DATASELF adapter absent |
| MCP Streamable HTTP | Worker route | Not implemented |
| Evidence archive | R2 | Not configured |
| Containerized Node broker | Cloudflare Containers | Not selected; separate compute substrate still required |

## Validation boundaries

- Node SQLite test: SQL lifecycle and close/reopen persistence passed.
- Node crypto tests: Ed25519 envelope and device request signature vectors passed.
- Wrangler dry-run: passed; Worker + Durable Object binding recognized.
- Staging Worker: deployed; trust secret and delivery signer intentionally absent.
- Cloudflare workerd/remote DO integration and real device end-to-end: not yet proven.
- Production domain, independent connector, and RAWMAC power-off test: not yet established.

## Safety invariants

- Evidence is not authority.
- Approval is not admission.
- Admission is not actuation.
- Replay is not re-execution.
- Integrity/provenance is not truth.
- Missing trust configuration fails closed.
- Existing Node broker and production tunnel routes remain untouched.
- No public production hostname is bound by this prototype.
