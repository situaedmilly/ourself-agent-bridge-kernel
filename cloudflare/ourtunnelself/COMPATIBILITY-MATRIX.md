# OURTUNNELSELF → Cloudflare compatibility matrix

| Existing Node component | Cloudflare target | Status |
|---|---|---|
| Node HTTP router | Workers fetch handler | Initial REST slice implemented |
| RS256 seat JWT verification | Workers Web Crypto | Implemented; crypto-vector tests pending |
| RS256 PORTAL verification | Workers Web Crypto | Implemented; crypto-vector tests pending |
| PORTAL caller/device/capability binding | Worker policy layer | Implemented |
| Local JSONL fsync journal | Durable Object SQLite | Initial event table implemented; replay/recovery pending |
| Static devices.json | Durable Object SQLite | Read path implemented; registry starts empty; enrollment/revocation pending |
| In-memory job map | Durable Object SQLite | Admission and caller-bound readback implemented |
| Replay nonce cache | Durable Object SQLite | Table provisioned; device authentication route pending |
| Ed25519 broker envelope | Workers Web Crypto | Not implemented |
| Outbound HTTPS device agent | Mac/Pi local agent | Remains device-side; protocol adapter pending |
| MCP Streamable HTTP | Worker route | Not implemented |
| Evidence archive | R2 | Not configured |
| Containerized Node broker | Cloudflare Containers | Fallback only; not selected as authority |

## Safety invariants

- Evidence is not authority.
- Approval is not admission.
- Admission is not actuation.
- Replay is not re-execution.
- Integrity/provenance is not truth.
- Missing trust configuration fails closed.
- Existing Node broker and production tunnel routes remain untouched.
- No public production hostname is bound by this prototype.
