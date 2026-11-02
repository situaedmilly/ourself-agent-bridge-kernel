# PIPE Contract v0.1

PIPE is the governed transport mechanism.

PIPE responsibilities:
- message framing and correlation;
- authenticated endpoint transport;
- evidence delivery with source metadata preserved;
- bounded queueing, retry, timeout, and replay protection;
- capability-envelope carriage;
- connection lifecycle receipts.

PIPE MUST NOT:
- create or modify canonical hardware identity;
- make identity-binding decisions;
- grant jurisdiction or authority;
- issue PORTAL admission decisions;
- widen admitted capability scope;
- authorize kernel operations;
- report an operation as executed merely because a message was delivered.

PIPE accepts a PORTAL decision reference and a bounded capability envelope. It validates the envelope's integrity and expiry as a transport precondition, but does not interpret that as a grant of execution authority.

Transport status vocabulary:
DECLARED, RESOLVING, AUTHENTICATING, CONNECTED, DEGRADED, CLOSED, REJECTED.

Connection state is not admission state. Delivery acknowledgement is not execution acknowledgement. Transport integrity is not source truth.
