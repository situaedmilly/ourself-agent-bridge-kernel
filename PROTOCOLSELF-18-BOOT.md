# ProtocolSELF-18 Ecosystem Boot Projection

- Registry: `OURSELFCOMM-PROTOCOLSELF-18`
- Schema: `ourself.protocolself-registry.v0.1`
- Source repository: `situaedmilly/self-communication`
- Source branch: `feat/protocolself-18-registry-v0.1`
- Source registry SHA-256: `76a2a14c9bab0d0ded7ff05c80991141df53e9f1f15ec948443e0b950017508c`
- Consumer role: Bounded actuation kernel; consumes protocol identities only through explicit admission and executor checks

## Boot semantics

This repository carries the same 18 protocol identities and conventional port
metadata as the OURSELFCOMM source registry. This is an additive boot projection,
not a second authority registry.

`REGISTRY_PRESENT` means the definitions are available to this repository.
It does not mean a daemon is installed, a socket is bound, a firewall is open,
a hostname is routed, a remote peer is reachable, or a message has been
transported.

Boot disposition:

- registry definitions: PRESENT
- listener activation: DISABLED
- external binding: PROHIBITED
- network transport authority: NOT_GRANTED
- multi-node exchange: NOT_AUTHORIZED
- credentials: NEVER_EMBEDDED
- service admission: REQUIRED_PER_PROTOCOL_AND_INSTANCE

The registry must be reconciled against the source digest before use. A changed
source registry requires a versioned successor projection, not silent drift.

## Protocol-specific safety

- Telnet (TCP 23) and TFTP (UDP 69) are prohibited-insecure.
- HTTP, FTP, POP3, IMAP, SMTP, LDAP and DNS require their applicable secure
  transport, authentication, and resolver/relay boundaries before service use.
- HTTPS, LDAPS, SSH and SFTP still require endpoint identity, certificate/key
  custody, and authorization.
- SNMP requires SNMPv3 authentication and privacy.
- MSSQL and Oracle Database require private-network isolation and TLS.
- DHCP remains link-local and is not to be routed as a public service.

## Local responsibility

Bounded actuation kernel; consumes protocol identities only through explicit admission and executor checks.

The owning runtime must preserve:

```text
PROTOCOL_IDENTITY != SERVICE_INSTANCE
SERVICE_INSTANCE != LISTENER
LISTENER != REACHABLE_ENDPOINT
REACHABILITY != AUTHORIZATION
TRANSPORT != ADMISSION
ACK != HOLLABACK
```

No protocol listener, firewall rule, DNS route, Cloudflare tunnel route,
credential, daemon, or multi-node exchange is created by this projection.
