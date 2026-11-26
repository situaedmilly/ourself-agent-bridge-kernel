# TRUST_CONFIGURATION_OURSELFECOSYSTEM v1

## Purpose

A single, versioned configuration envelope for OURHOSTSELF trust-verifier inputs. It supplies candidate public verification keys and issuer/audience constraints. It is not itself an OSOS trust root, does not prove issuer authority, contains no private signing keys, and grants no authority.

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

Use only actual public key PEMs issued by the OSOS trust authority. Never generate replacement production trust roots merely to make the endpoint green.

**Current validator boundary:** the Worker validates JSON schema, required fields, PEM framing, and field lengths only. A complete OSOS root/subordinate certificate-chain validator is not yet implemented. Therefore a syntactically complete secret reports PRESENT_UNVERIFIED, not READY, and every authority-bearing route continues to return HTTP 503 OSOS_TRUST_CHAIN_UNVERIFIED. Legacy bindings are equally unverified. Do not treat this secret as production trust or use it to admit devices.

## Staging procedure

1. Generate dedicated, short-lived staging Seat and Portal keypairs in an isolated secure workspace.
2. Obtain issuer identifiers from the staging OSOS/PORTAL issuer authorities. Do not invent issuer identities.
3. Construct and locally validate the JSON document. Do not commit populated trust material.
4. Upload it only to ourhostself-ourtunnelself-staging with Wrangler secret management.
5. Verify GET /health reports trust_configuration PRESENT_UNVERIFIED and trust_chain_validation NOT_IMPLEMENTED. This confirms only that the secret is readable and structurally valid.
6. Authority-bearing routes must remain blocked with OSOS_TRUST_CHAIN_UNVERIFIED until the OSOS certificate-chain validator is implemented.
7. Delete the staging secret and verify health returns to MISSING. Never deploy staging identities to production.

## Separate delivery signer

Device delivery and DATASELF evidence receipts use a separate Wrangler secret named OURHOSTSELF_DELIVERY_PRIVATE_KEY_PEM. It must contain an Ed25519 PKCS#8 private key. The matching public key is provisioned to authorized device agents as their broker verification key. Do not place private delivery material inside the trust configuration document.

The matching delivery public key must itself be certified/pinned through the approved OSOS trust chain before any device is admitted. Current health reports delivery-key presence as PRESENT_UNVERIFIED and delivery_key_certification as NOT_IMPLEMENTED.

## Transitional compatibility

The Worker temporarily accepts OSOS_SEAT_PUBLIC_KEY_PEM, OURHOSTSELF_SEAT_ISSUER, OSOS_PORTAL_PUBLIC_KEY_PEM, and OURHOSTSELF_PORTAL_ISSUER. Optional audience bindings default to ourtunnelself. The canonical versioned secret takes precedence.

## Security invariants

- Missing or malformed trust configuration fails closed with HTTP 503.
- Public health reveals readiness and missing/invalid field names only.
- A configured key is not proof that its issuer is authoritative.
- OSOS root/subordinate key certification and issuer-policy binding remain an explicit implementation gate.
- A valid Seat token is not a Portal admission.
- Approval is not device admission; admission is not actuation.
- Staging trust must never be reused as production trust.
