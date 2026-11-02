# Universal Hardware Moat Registry v0.1

Each moat is evaluated per reality. Applicability is platform-specific; NOT_APPLICABLE requires a reason and evidence. UNASSESSED is not PASS.

| ID | Moat | Required control question |
|---|---|---|
| 01 | IDENTITYMOAT | Is canonical identity independently grounded? |
| 02 | OSMOAT | Is OS identity distinct and bound to its host? |
| 03 | BOOTMOAT | Is boot integrity verified, not merely observed? |
| 04 | ACCESSMOAT | Are authentication and admission independently enforced? |
| 05 | JURISDICTIONMOAT | Are permitted authorities explicit and bounded? |
| 06 | EXECUTIONMOAT | Are executable operations mediated and witnessed? |
| 07 | COGNITIONMOAT | Are models prevented from acquiring authority by inference? |
| 08 | MEMORYMOAT | Are storage ownership, persistence, and access controlled? |
| 09 | NETWORKMOAT | Are ingress, egress, and peer boundaries explicit? |
| 10 | RESOURCEPROOFMOAT | Are capacity and performance measured with provenance? |
| 11 | PROVENANCEMOAT | Are origin, observer, custody, and evidence lineage recorded? |
| 12 | RECEIPTMOAT | Are execution receipts signed and independently verifiable? |
| 13 | MUTATIONMOAT | Are changes authorized, bounded, reversible, and audited? |
| 14 | RECOVERYMOAT | Is restoration tested and its result independently witnessed? |

Allowed assessment values: UNASSESSED, DECLARED, IMPLEMENTED_UNVERIFIED, VERIFIED, BLOCKED, NOT_APPLICABLE.

Only VERIFIED may satisfy a moat gate, and only when an evidence reference and verification method are present. The compiler does not infer VERIFIED from a description.
