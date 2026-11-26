# HOSTSELF independence status — 2026-11-26

## Verified

- Cloudflare account authentication is active for the authorized Wrangler identity.
- The staging Worker is deployed at https://ourhostself-ourtunnelself-staging.situatedsolutions.workers.dev.
- GET /health returns HTTP 200 independently of RAWMAC.
- The Worker has a Durable Object SQLite binding.
- The canonical TRUST_CONFIGURATION_OURSELFECOSYSTEM secret name was accepted by Wrangler. A staging-only temporary document changed health to PRESENT_UNVERIFIED; the protected route returned HTTP 503 OSOS_TRUST_CHAIN_UNVERIFIED. The secret was deleted and the inventory returned empty.
- Source audit found the OURSYSTEMSELFOPERATIN repository contains only README.md and no root/subordinate certificate-chain schema. The existing PIPE|PORTAL audit explicitly records missing OSOS key certification and issuer-policy binding.
- Local verification covers Worker contracts, trust configuration, Ed25519 envelope/request signatures, broker regressions, SQLite state lifecycle, and local SQLite close/reopen persistence.
- The current staging deployment intentionally has no trust secret and no delivery-signing private key. Device routes therefore remain fail-closed.

## Not established

- No production hostname or route is bound to the staging Worker.
- Cloudflare Worker + Durable Object provides independent serverless ingress, request execution, and durable state; it is not a general-purpose always-running Node.js host for the full OURSELF runtime.
- Existing Cloudflare Tunnel connectors and their configured origins still include RAWMAC localhost services. They are not independent of RAWMAC power.
- OURHOSTSELF-INGRESS still has no active connector.
- No separate VM/container compute host or independent tunnel connector has been provisioned.
- Wrangler `containers list` returned Cloudflare entitlement error: deploying Cloudflare Containers requires the Workers Paid plan. No plan upgrade or charge was authorized. The Mac Colima runtime is stopped, and no provider-specific credentials for Hetzner, DigitalOcean, AWS, Azure, GCP, Fly, Render, Vultr, or Linode were present in the checked environment (variable names only).
- Cloudflare Containers capability check returned Unauthorized: this account does not have access; deployment requires the Workers Paid plan. Official base plan is USD $5/month plus metered container memory/CPU/disk/egress. No plan upgrade or paid deployment was authorized.
- Docker CLI is installed on RAWMAC, but the configured Colima daemon is stopped; Docker cannot currently build a container image.
- Cloudflare Containers are not a guaranteed never-stop process: Cloudflare documents that host events can stop active containers without a fixed runtime guarantee, and container disk is ephemeral by default. Durable Object alarms/state would be required for recovery; this still remains inside the Cloudflare provider.
- Independent-provider candidate identified: Hetzner Cloud US-East / Ashburn, VA. The location supports Cloud Shared AMD and Dedicated AMD instances; Hetzner states a 99.9% monthly availability target for Cloud Servers. No Hetzner account, project, server, or billing authorization is present.
- The OURSELFCLOUDSERVERNETWORK repository's runtime specification is marked INITIAL_DRAFT / NOT_IMPLEMENTED / NOT_DEPLOYED. Its OURSELF-INSTANCE-0001 endpoint is GitHub Raw Content; runtime_status is LAUNCH_DECLARED_NOT_LIVE, with MCP and Ollama runtime endpoints null. This is source serving, not independent compute.
- No end-to-end signed Seat/PORTAL/device execution has been admitted.
- No RAWMAC power-off test has been performed.

## HOSTSELF gate

The remaining infrastructure dependency is a separate compute substrate/account and an authorized connector deployment target. GitHub remains source custody, not compute. Cloudflare Workers/DO remains the independently hosted control plane, not proof that every existing tunnel or local runtime survives a Mac shutdown.

Do not shut down RAWMAC to test independence until:
1. an independent compute host is provisioned,
2. the OURHOSTSELF connector is installed and online there,
3. the required origins have moved off localhost on RAWMAC,
4. all existing routes have been verified against the new origins, and
5. rollback and recovery have been tested.

The power-off test is intentionally blocked until those conditions hold.

Cloudflare Containers documentation: https://developers.cloudflare.com/containers/faq/ and https://developers.cloudflare.com/containers/platform/pricing/
Hetzner US-East location: https://docs.hetzner.com/cloud/general/locations/
Hetzner Cloud SLA: https://docs.hetzner.com/general/company-and-policy/slas-cloud/
