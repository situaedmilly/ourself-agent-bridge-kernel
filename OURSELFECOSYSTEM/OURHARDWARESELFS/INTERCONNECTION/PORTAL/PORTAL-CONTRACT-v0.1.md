# PORTAL Contract v0.1

PORTAL is the governed admission and transition boundary.

PORTAL evaluates:
- canonical source and target identities;
- explicit typed identity binding;
- current identity and boot evidence;
- source and target jurisdiction;
- authority grant and its scope;
- requested capability and purpose;
- required moat assessment;
- evidence freshness, provenance, and revocation;
- policy version and decision expiry.

PORTAL decisions:
- ADMIT: bounded passage is permitted for stated capabilities and duration.
- DENY: prerequisites or authority are insufficient.
- QUARANTINE: evidence is conflicting, stale, suspicious, or unresolved.

PORTAL MUST NOT:
- invent or repair identity evidence;
- create a hardware identity;
- promote a reality to BOUND, MOATED, or PROVEN;
- grant kernel-level execution authority;
- convert a transport connection into admission;
- override the target kernel's local policy.

Admission is a scoped decision, not a permanent property. Decisions are bound to exact source, target, direction, purpose, capabilities, policy version, and expiry.
