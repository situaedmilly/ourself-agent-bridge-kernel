# TRUST_CONFIGURATION_OURSELFECOSYSTEM v1

## Purpose

A single, versioned trust root for the OURHOSTSELF Cloudflare Worker. It supplies public verification keys and issuer/audience constraints. It contains no private signing keys, grants no authority by itself, and does not enroll or admit a device.

## Canonical secret

Store this JSON document as the Wrangler secret named TRUST_CONFIGURATION_OURSELFECOSYSTEM on each Worker environment independently.

    {
      "schema": "TRUST_CONFIGURATION_OURSELFECOSYSTEM/v1",
      "seat": {
        "public_key_pem": "-----BEGIN PUBLIC KEY-----\nREPLACE_WITH_OSOS_SEAT_PUBLIC_KEY\n-----END PUBLIC KEY-----",
        "issuer": "REPLACE_WITH_OSOS_SEAT_ISSUER",
        "audience": "ourtunnelself"
      },
      "portal": {
        "public_key_pem": "-----BEGIN PUBLIC KEY-----\nREPLACE_WITH_OSOS_PORTAL_PUBLIC_KEY\n-----END PUBLIC KEY-----",
        "issuer": "REPLACE_WITH_OSOS_PORTAL_ISSUER",
        "audience": "ourtunnelself"
      }
    }

Use actual public key PEMs issued by the OSOS trust authority. Never generate replacement production trust roots merely to make the endpoint green.

## Staging procedure

1. Generate dedicated, short-lived staging Seat and Portal keypairs in an isolated secure workspace.
2. Obtain issuer identifiers from the staging OSOS/PORTAL issuer authorities. Do not invent issuer identities.
3. Construct and locally validate the JSON document. Do not commit populated trust material.
4. Upload it only to ourhostself-ourtunnelself-staging with Wrangler secret management.
5. Verify GET /health reports trust_configuration READY. Health reports binding state only, never key material.
6. Exercise signed Seat and Portal requests with staging-only identities.
7. Delete the staging secret and verify health returns to missing/invalid. Never deploy staging identities to production.

## Separate delivery signer

Device delivery and DATASELF evidence receipts use a separate Wrangler secret named OURHOSTSELF_DELIVERY_PRIVATE_KEY_PEM. It must contain an Ed25519 PKCS#8 private key. The matching public key is provisioned to authorized device agents as their broker verification key. Do not place private delivery material inside the trust configuration document.

## Transitional compatibility

The Worker temporarily accepts OSOS_SEAT_PUBLIC_KEY_PEM, OURHOSTSELF_SEAT_ISSUER, OSOS_PORTAL_PUBLIC_KEY_PEM, and OURHOSTSELF_PORTAL_ISSUER. Optional audience bindings default to ourtunnelself. The canonical versioned secret takes precedence.

## Security invariants

- Missing or malformed trust configuration fails closed with HTTP 503.
- Public health reveals readiness and missing/invalid field names only.
- A configured key is not proof that its issuer is authoritative.
- A valid Seat token is not a Portal admission.
- Approval is not device admission; admission is not actuation.
- Staging trust must never be reused as production trust.
