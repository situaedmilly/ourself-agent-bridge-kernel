# OURSELF Ecosystem Git Custody Adoption Reconnaissance v0.1

**Date:** 2026-11-02  
**Repository:** `situaedmilly/ourself-agent-bridge-kernel`  
**Branch:** `governance/ecosystem-custody-adoption-v0.1`  
**Baseline governance commit:** `6805d5c4d5016627bc02b865508fc853b86c3001`  
**Status:** INITIAL EVIDENCE SNAPSHOT; ECOSYSTEM ADOPTION NOT ESTABLISHED

## 1. Purpose

Record the first directly observed adoption evidence for the OURSELF Git Custody and Commit Policy v1.0. This is a reconnaissance receipt, not a declaration of universal compliance. It distinguishes repository inventory, machine state, and enforcement evidence.

Governing sequence:

`MANIFEST → VALIDATE → STAGE → COMMIT → PUSH → VERIFY REMOTE`

A Git receipt establishes versioned custody only. It does not establish deployment, runtime realization, authorization, or verified effect.

## 2. Governance artifact

- Policy repository: `situaedmilly/ourself-agent-bridge-kernel`
- Policy branch: `governance/commit-custody-policy-v1`
- Policy commit supplied for verification: `6805d5c4d5016627bc02b865508fc853b86c3001`
- Remote branch ref independently observed with `git ls-remote` on OURSELFMAC: exact SHA above.
- The connected GitHub repository inventory and branch metadata identify the repository and branch.
- Adoption status: policy branch existence verified; universal enforcement not established.

## 3. GitHub repository inventory evidence

The connected GitHub repository-list operation, filtered to owner `situaedmilly`, returned **24 repository records** in this reconnaissance pass.

A prior ecosystem inventory reported **29 repositories**. The five-record difference is unresolved. Do not treat either number as the final canonical repository count until inventory scope, pagination, archived repositories, transferred repositories, and repositories outside this owner filter are reconciled.

The 24 returned records are an account-visible inventory snapshot, not proof that every repository has been audited or adopted.

## 4. Machine evidence

### 4.1 OURSELFMAC

- Host responded online to Desktop Commander.
- Read-only discovery found **50 Git metadata roots** under the scanned roots `~/Projects/ourself-core`, `~/RUORA/projects`, and `~/RUORA/systems`.
- This is a worktree/checkout count, not a canonical repository count. The scan includes repeated repository copies, nested repositories, and branch-specific worktrees.
- The checkout `~/Projects/ourself-core/ourself-agent-bridge-kernel` was on `main` at `b66e2f1`, tracking `origin/main`.
- That checkout had modified tracked files and untracked manifestations, including hardware registries, OSOS evidence, PIPE/PORTAL conformance material, SELFGRAPH artifacts, and tests.
- The policy branch was not checked out in this worktree.
- No files were staged, committed, reset, cleaned, or pushed during this reconnaissance.

**Disposition:** connected; custody adoption unverified; dirty worktree protected; classify and map each checkout before any staging.

### 4.2 OURSELFPIMAC

- Host responded online to Desktop Commander.
- Read-only discovery found multiple Git repositories and evidence workspaces under `/home/selfadmin`; the discovery includes fixtures and recovery specimens and is not a canonical repository count.
- The checkout `/home/selfadmin/ourself-agent-bridge-kernel` reports `main...origin/main [ahead 1]`.
- Its working tree contains modified tracked files and extensive untracked content.
- Git reports: `index file .git/objects/pack/._pack-bd6691dcec21ebb23417580699bebc50ff618a87.idx is too small`.
- The malformed AppleDouble sidecar is 163 bytes. A corresponding normal pack index exists separately.
- The checkout contains **142** files whose names begin with `._`.
- A read-only `git fsck --connectivity-only --no-reflogs` attempt is obstructed by the malformed AppleDouble sidecar and cannot be recorded as a clean integrity pass.

**Disposition:** connected; repository integrity not established; quarantine from staging, commit, and push. Preserve the worktree and sidecars until a backup-backed repair plan is validated. Do not delete or regenerate Git objects/indexes as part of this reconnaissance.

## 5. Enforcement-surface evidence

| Surface | Evidence in this pass | Adoption state |
|---|---|---|
| Governance policy branch | Remote branch ref points to the supplied policy commit | Verified artifact existence |
| GitHub repository inventory | 24 owner-filtered records returned; expected count discrepancy unresolved | Partial inventory |
| OURSELFMAC worktrees | 50 Git metadata roots across three selected roots; dirty state observed in Agent Bridge checkout | Not adopted / per-repo audit pending |
| OURSELFPIMAC worktrees | Multiple repositories and evidence workspaces; Agent Bridge integrity failure observed | Quarantined target |
| Repository branch protections / rulesets | Not inspected in this pass | Unknown |
| Required GitHub Actions checks | Not inspected across the repository set | Unknown |
| Local hooks / agent commit gates | Not inspected across all worktrees and machines | Unknown |
| Cross-repository adoption tests | No test evidence collected | Not established |

A policy document or workflow file alone is not proof that every agent, machine, or route to Git can bypass or obey the custody sequence. Enforcement requires positive tests of the actual commit paths and negative tests showing prohibited paths fail closed.

## 6. Non-mutation record

During this reconnaissance:
- No blanket staging was performed.
- No dirty worktree was cleaned or reset.
- No Pi AppleDouble file, pack, index, or object was deleted or rewritten.
- No commit was created from either machine checkout.
- No push was performed from either machine.
- The policy branch reference was inspected remotely.

## 7. Required next evidence

1. Reconcile the 24-versus-29 GitHub inventory difference and freeze a canonical repository register.
2. Map each canonical repository to its owning reality, canonical local path(s), machines, worktrees, default branch, and remote.
3. Classify duplicate worktrees, fixtures, archived repositories, and recovery specimens separately from canonical repositories.
4. Batch-audit each canonical repository for dirty state, branch divergence, remote parity, object integrity, and existing custody controls.
5. Repair OURSELFPIMAC only after preserving a byte-for-byte backup and validating the intended recovery procedure.
6. Inspect GitHub rulesets/branch protections, required checks, Actions workflows, local hooks, and agent/tool commit paths.
7. Install enforcement in controlled batches and test both compliant commits and blocked noncompliant paths.
8. Publish per-repository adoption receipts and verify their remote refs.

## 8. Adoption state

`POLICY_ARTIFACT = VERIFIED_REMOTE_REF`  
`GITHUB_INVENTORY = PARTIAL (24 RETURNED; 29 PREVIOUSLY REPORTED)`  
`OURSELFMAC = CONNECTED / DIRTY WORKTREES / ADOPTION UNVERIFIED`  
`OURSELFPIMAC = CONNECTED / TARGET REPOSITORY QUARANTINED`  
`REPOSITORY_ENFORCEMENT = UNKNOWN`  
`ECOSYSTEM_ADOPTION = NOT_ESTABLISHED`

This snapshot is intentionally fail-closed. Unknown is not compliant, and observed local presence is not Git custody.
