# Dedicated OURTUNNELSELF Gateway — Deployment Profile v0.1

## Host decision

The first gateway is a dedicated OURSELF-controlled server. This is a deployment target, not a claim that a server has already been provisioned. The software is provider-neutral and binds to loopback by default; an HTTPS ingress/reverse proxy publishes it.

Minimum initial host profile:
- Linux x86_64 or arm64 with systemd
- Node.js 22+
- 1 vCPU, 1 GB RAM, 10 GB persistent disk for the prototype
- stable public DNS name and reachable TCP/443
- outbound internet access for package/security updates
- dedicated unprivileged service account `ourtunnelself`
- persistent `/var/lib/ourtunnelself` on encrypted or otherwise protected storage

A public IP is not inherently required if OURSELF controls another ingress path, but the ingress adapter must be independently replaceable. The broker itself never binds to a public interface in this profile.

## Trust material — do not generate substitute authority

The gateway requires:
- broker RSA private key: generated on the gateway; signs broker delivery envelopes
- seat public key: supplied by OSOS seat-identity authority
- PORTAL public key: supplied by the independent PORTAL signing authority
- device Ed25519 public keys: admitted through the OURSELF device enrollment ceremony

OURTUNNELSELF does not create OSOS caller identity, PORTAL admission, or device admission. Missing issuer configuration, keys, or registry entries stops startup or denies requests.

Generate only the broker keypair:
```sh
sudo install -d -m 0750 -o root -g ourtunnelself /etc/ourtunnelself
sudo OURTUNNELSELF_KEY_DIR=/etc/ourtunnelself node tools/ourtunnelself/init-broker.mjs
sudo chown root:ourtunnelself /etc/ourtunnelself/broker-private.pem
sudo chmod 0640 /etc/ourtunnelself/broker-private.pem
```

Install the seat and PORTAL public keys from their respective authorities as:
- `/etc/ourtunnelself/seat-public.pem`
- `/etc/ourtunnelself/portal-public.pem`

Do not create these by copying the broker key or inventing a local trust root.

## Device enrollment

On the target device, generate a unique Ed25519 keypair:
```sh
node tools/ourtunnelself/enroll-device.mjs OURSELFMAC.local "OURSELFMAC"
```
The helper writes the private key locally with mode 0600 and prints a public registry record with `enabled:false`. A custodian must verify identity/jurisdiction and authorize admission before changing that record to enabled. The device private key never leaves the device.

Place the admitted record in `/etc/ourtunnelself/devices.json` on the gateway. Include the PEM public key exactly as printed. The registry is not self-enrolling.

## Device agent environment

The device agent requires:
```sh
export OURTUNNELSELF_BROKER_URL=https://YOUR-OURSELF-GATEWAY-DOMAIN
export OURTUNNELSELF_DEVICE_ID=OURSELFMAC.local
export OURTUNNELSELF_DEVICE_PRIVATE_KEY="$HOME/.ourself/keys/OURSELFMAC.local.ed25519.pem"
export OURTUNNELSELF_BROKER_PUBLIC_KEY="$HOME/.ourself/keys/broker-public.pem"
export OURTUNNELSELF_PORTAL_PUBLIC_KEY="$HOME/.ourself/keys/portal-public.pem"
export OURTUNNELSELF_PORTAL_ISSUER=REPLACE_WITH_OSOS_PORTAL_ISSUER
export OURSELFD_SOCKET=/var/tmp/ourselfd.sock
node runtime/ourtunnelself/device-agent.js
```
The broker public key and PORTAL public key are public verification material. The device private key is secret. Keep the agent running under the same least-privilege local account that can access the OURSELFd socket.

## macOS launchd agent

The template at `deploy/ourtunnelself/com.ourself.ourtunnelself.device-agent.plist.example` installs the device agent as a per-user LaunchAgent. Replace every `REPLACE_USER` and gateway/issuer placeholder, confirm the repository path and Node path, then install the rendered plist under `~/Library/LaunchAgents/com.ourself.ourtunnelself.device-agent.plist`. Load it with `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ourself.ourtunnelself.device-agent.plist`. Inspect logs before treating the agent as online. Do not load it until OURSELFd is running, the device has been admitted in the server registry, and all public verification keys are installed.

## Gateway environment and service

Copy `deploy/ourtunnelself/ourtunnelself.env.example` to `/etc/ourtunnelself/ourtunnelself.env`, replace issuer placeholders with the exact OSOS and PORTAL issuer identifiers, and protect it with mode 0600. Configure the systemd service from `deploy/ourtunnelself/ourtunnelself.service`. Install the repository at `/opt/ourself/ourself-agent-bridge-kernel` or adjust WorkingDirectory.

Create `/var/lib/ourtunnelself` owned by `ourtunnelself:ourtunnelself` with mode 0700. The `devices.json` registry must be owned by `root:ourtunnelself` and mode 0640 so only root and the broker service group can read it. The broker key is `root:ourtunnelself` mode 0640; public verification keys may be root-owned mode 0644. Keep the environment file root-owned mode 0600. The broker journal is append-only JSONL with fsync before delivery. A job marked DELIVERED but lacking a result after broker restart becomes DELIVERY_UNKNOWN and is not automatically replayed; this intentionally prefers avoiding duplicate execution over automatic retry.

## HTTPS ingress

The included Caddyfile is one replaceable ingress adapter. Set `OURTUNNELSELF_DOMAIN` to a domain controlled by OURSELF and configure Caddy's environment accordingly. Caddy terminates TLS and proxies to loopback port 8787. Another reverse proxy or private network ingress can replace it without changing device identity, PORTAL policy, or session contracts.

The gateway exposes:
- `GET /health` — non-sensitive liveness
- `POST /mcp` — authenticated stateless MCP Streamable HTTP endpoint
- internal device poll/result routes
- seat REST routes for operational diagnostics

Do not expose internal device routes as browser-facing user interfaces. The reverse proxy may publish only `/mcp` and `/health`; network policy should restrict all other routes.

## Current implementation boundary

Implemented in this branch:
- broker process with append-only event journal
- RS256 seat JWT verification and independent RS256 PORTAL JWT verification
- target-device registry with manual enablement
- Ed25519 device request authentication and replay nonce cache
- signed broker delivery envelopes; target agent independently verifies PORTAL signature
- outbound HTTPS polling agent
- local forwarding only to existing OURSELFd read-only `repo.status/git_status`
- MCP tools for device listing, scoped repo status requests, and job readback
- restart behavior that does not replay a request after uncertain delivery

Not yet implemented or proven:
- OSOS-issued seat JWT signer and operational key rotation
- PORTAL signer integration and real admission token issuance
- production server provisioning, DNS, TLS ingress and hardening
- durable external device registry authority / revocation distribution
- independent MODELSELFWITNESS integration and DATASELF receipt ingestion
- actual launchd installation/start/read-back on OURSELFMAC (a template is committed; deployment is not verified)
- end-to-end tests on a provisioned host and real Mac
- cross-seat proof using two independently authenticated caller identities

This is a deployable prototype, not a production-ready or admitted system. No request may execute without a real PORTAL-signed admission token. Desktop Commander is not a runtime dependency.
