# OURSELF Canonical Ownership Resolution v0.1

**Date:** 2026-11-03  
**Registry baseline:** `OURSELF-REPOSITORY-INSTANCE-CUSTODY-001`  
**Baseline registry commit:** `162e40a17e26a422c027901fbf598a2c1fba44b6`  
**Adoption reconnaissance:** `69315404749c1acb823c6202c21aadd6ab0dbb6d`  
**Branch:** `governance/canonical-ownership-resolution-v0.1`  
**Status:** CANDIDATE OWNERSHIP MAP; FINAL CANONICAL WORKTREE AUTHORITY NOT YET ESTABLISHED

## 1. Purpose and decision rule

Resolve the owning reality and local machine binding of each of the 29 GitHub repositories without confusing repository identity, project jurisdiction, worktree location, and execution authority.

This document is a candidate-resolution layer over the prior instance registry. It does not silently promote a candidate into canonical ownership. Each row records the evidence basis and the remaining proof required.

A repository is not canonically adopted until all of the following are resolved:

- `owning_reality`: the project/system jurisdiction that owns the repository's purpose and contracts.
- `canonical_worktree`: one designated writable source worktree, or an explicit `REMOTE_ONLY` / `NO_LOCAL_CANONICAL` state.
- `machine_binding`: current machine and path, verified against live Git remote and repository identity.
- `branch_authority`: default branch plus approved working-branch and protected-branch policy.
- `custody_status`: integrity, dirty state, divergence, remote parity, and enforcement evidence.

Names, directory labels, GitHub ownership, and README claims are evidence inputs, not sufficient proof by themselves.

## 2. Counting units remain separate

| Measurement | Count | Scope |
|---|---:|---|
| GitHub repositories | 29 | Account inventory for `situaedmilly` |
| OURSELFMAC Git metadata roots | 50 | Later scan of `Projects/ourself-core`, `RUORA/projects`, and `RUORA/systems` |
| OURSELFMAC worktree records | 22 | Earlier canonical registry baseline |
| OURSELFPIMAC worktree records | 11 | Earlier canonical registry baseline |
| Pi AppleDouble sidecars | 142 | Earlier observed quarantine population |

These measurements are not interchangeable. In particular, 50 Git metadata roots are not 50 unique GitHub repositories, and 22/11 are earlier worktree records, not current live counts.

## 3. Ownership resolution matrix

Evidence labels:
- **README-VERIFIED**: repository README explicitly describes the system or purpose.
- **REGISTRY-OBSERVED**: earlier machine registry records a local path/remote association.
- **CONTEXT-CANDIDATE**: name or project context suggests an owner, but primary repository evidence is insufficient.
- **UNRESOLVED**: no defensible owner assignment yet.
- **EXTERNAL-CANDIDATE**: evidence indicates third-party/vendor ownership rather than OURSELF system ownership.

| GitHub repository | Candidate owning reality / jurisdiction | Evidence basis | Earlier local binding | Canonical disposition |
|---|---|---|---|---|
| `4allcustomz` | UNRESOLVED | README.md not found at default branch; no reliable purpose evidence | None in 22/11 registry | UNRESOLVED |
| `frekqenci-splash-portal` | FREKQENCI / public portal surface | README identifies official Frekqenci splash portal, React/Vite/Tailwind/3D surface | None in 22/11 registry | CANDIDATE OWNER; canonical path unresolved |
| `ManCav3` | UNRESOLVED; possible HBC-generated Mancave realm | README.md not found; HBC readme mentions mancave landing/picks, but does not bind this repository | None in 22/11 registry | UNRESOLVED |
| `ruora` | RUORA / RuoRa product and website reality | Project context identifies RuoRa cloud website work; repository README not found | No path in 22/11 registry | CONTEXT CANDIDATE; verify repo contents and deployment binding |
| `OTS-Rentals` | UNRESOLVED | README.md not found at default branch | None in 22/11 registry | UNRESOLVED |
| `mt5TraderJawn` | Trading integration / MT5 trading stack | README describes systematic trading operations stack and MT5 manual-assisted/semi-automated workflow | `OURSELFMAC: ~/Projects/ourself-core/mt5TraderJawn` | CANDIDATE OWNER; path observed in baseline |
| `onetripsolution` | UNRESOLVED / archived project jurisdiction | GitHub metadata: private, archived; README.md not found | None in 22/11 registry | ARCHIVED; ownership unresolved |
| `axiom-aethernet` | ÆXIOM / ÆTHERNET ecosystem | Repository name aligns with ecosystem; README contains only title/name | None in 22/11 registry | CONTEXT CANDIDATE; insufficient purpose evidence |
| `getmomentum-cloud` | UNRESOLVED; possible Momentum cloud reality | README.md not found at default branch | None in 22/11 registry | UNRESOLVED |
| `Friendshiplab` | UNRESOLVED | README.md not found at default branch | None in 22/11 registry | UNRESOLVED |
| `self-public-source` | SELF public doctrine / source publication | README identifies SELF identity-intelligence operating doctrine and canonical public prompt | None in 22/11 registry | README-VERIFIED candidate owner; canonical path unresolved |
| `ourself-core` | OURSELF Core / ecosystem registry and proof-ledger jurisdiction | README title; prior registry records two distinct Mac paths/branches | `OURSELFMAC: ~/Projects/ourself-core`; `OURSELFMAC: ~/OURSELF/ourself-core` | OWNER CANDIDATE; two competing worktrees, canonical path unresolved |
| `SELFBull` | SELFBULL / Webull broker-surface adapter | README explicitly defines standalone Webull adapter and separation from trading decision authority | `OURSELFMAC: ~/Projects/ourself-core/SELFBull` | README-VERIFIED candidate owner; path observed |
| `ourself-agent-bridge-kernel` | OURSELF Agent Bridge Kernel / execution and admission kernel | Repository architecture and custody evidence; canonical hardware/PIPE/PORTAL architecture committed | `OURSELFMAC: ~/Projects/ourself-core/ourself-agent-bridge-kernel`; `OURSELFMAC: ~/OURSELF/ourself-agent-bridge-kernel`; `OURSELFPIMAC: /home/selfadmin/ourself-agent-bridge-kernel` plus shared-object-database worktree | MULTI-INSTANCE; Mac worktrees dirty; Pi quarantined; canonical writer not selected |
| `ourself-cloud-server-network` | OURSELF Cloud Server Network / distributed continuity fabric | README identifies governed continuity fabric and names peer system responsibilities | `OURSELFMAC: ~/OURSELF/ourself-cloud-server-network` | README-VERIFIED candidate owner; path observed |
| `self-protocol-suite` | SELF Protocol Suite / system-language specification | README identifies provider-neutral protocol language and reference implementation | `OURSELFMAC: ~/Projects/ourself-core/self-protocol-suite` | README-VERIFIED candidate owner; path observed |
| `Bubbleself` | BubbleSelf / SELFJOURNEY candidate | Prior ecosystem context associates BubbleSelf with SELFJOURNEY; README.md not found at current default branch | None in 22/11 registry | CONTEXT CANDIDATE; branch authority unusual, canonical path unresolved |
| `self-communication` | SELFCOMMUNICATION / communication and handoff organ | README identifies transmission channel, immutable INSELFACTION archive, and bootstrap contract | `OURSELFMAC: ~/Projects/ourself-core/self-communication`; `OURSELFMAC: ~/OURSELF/self-communication` | README-VERIFIED; duplicate Mac worktrees, canonical writer unresolved |
| `conscious-conversation` | ConsciousConversation / SELF Journey cognition layer | README identifies SELF Journey Runtime and ConsciousConversation cognition kernel | None in 22/11 registry | README-VERIFIED candidate owner; canonical path unresolved |
| `hbc-html` | HBC HTML / Hyperbolic Build Chamber compiler | README describes compiler and sealed Realm Packet to HTML realm process | `OURSELFPIMAC: /home/selfadmin/projects/hbc-html` | README-VERIFIED candidate owner; Pi path observed dirty |
| `ALTONUMBUSELF` | ALTONUMBUSELF / bounded OURSELF memory-storage instance; REVERSELF is its memory-boundary controller, not a separate GitHub repository | README + `OURSELF_INSTANCE.md` + `runtime/reverself/REVERSELF-0001.json`; purpose, jurisdiction, algorithm, and non-mutating boundary are explicit | `OURSELFMAC: /Users/millysituated/Projects/ALTONUMBUSELF` (active REVERSELF task binding, branch `morph-xi/selfmoat-proving`, local HEAD `6d981a525e530bf0ed64615a6632838d71458c96`); `OURSELFMAC: /Users/millysituated/Projects/ourself-core/ALTONUMBUSELF` (clean `main`, `9aa80ab`); `OURSELFMAC: /Users/millysituated/OURSELF/ALTONUMBUSELF` (clean `main`, `9aa80ab`) | OWNER/PURPOSE VERIFIED; active REVERSELF binding verified; permanent canonical writer unresolved because three worktrees remain and local/remote task-branch lineage is unreconciled against live remote head `3fdde73c099f9b99814d72dc224c638965be27e9` |
| `SELFCOMM-SIMPLE-V0.1` | SELFCOMM simple webhook / integration surface | Prior ecosystem context identifies GitHub webhook SELFCOMM-SIMPLE-V0.1; README.md not found | No path in 22/11 registry | CONTEXT CANDIDATE; verify webhook contract and runtime binding |
| `ourself-agent-bridge` | OURSELF Agent Bridge control plane | Prior registry maps Pi control-plane checkout to this remote through a local mirror; README.md not found | `OURSELFPIMAC: /home/selfadmin/ourself-agent-bridge-control-plane` | CANDIDATE OWNER; remote mirror and write-through authority must be verified |
| `hermes-agent` | EXTERNAL / NousResearch upstream or derivative | README identifies Hermes Agent as built by Nous Research; local environment has a Hermes checkout but prior canonical worktree registry does not designate it OURSELF-owned | No canonical path in 22/11 registry | EXTERNAL CANDIDATE; classify fork/vendor relationship and exclude from OURSELF ownership unless proven |
| `GOLDSELFSCAN` | GOLDMICRO / Gold execution reconstruction reality | README explicitly calls repository canonical persistence surface for GOLDMICRO | `OURSELFMAC: ~/Projects/ourself-core/GOLDSELFSCAN` | README-VERIFIED candidate owner; path observed |
| `OURPROCESSORSELF` | OURPROCESSORSELF / bounded processor substrate | README explicitly describes bounded processor substrate and instruction/execution receipt flow | `OURSELFMAC: ~/Projects/ourself-core/OURPROCESSORSELF`; `OURSELFMAC: ~/OURSELF/OURPROCESSORSELF`; detached processor selgate worktree | README-VERIFIED; multiple Mac instances; canonical writer unresolved |
| `SELFVEREIGN-ADDRESSELF` | SELFVEREIGN-ADDRESSELF / sovereign network addressing | README describes sovereign network address and signaling protocol | `OURSELFMAC: ~/OURSELF/SELFVEREIGN-ADDRESSELF` | README-VERIFIED candidate owner; path observed dirty |
| `FLOWACTIONSELFWORK` | FLOWACTIONSELFWORK / governed action execution node | README identifies system integration and sovereign execution node | `OURSELFMAC: ~/OURSELF/FLOWACTIONSELFWORK` | README-VERIFIED candidate owner; branch ahead 1 / behind 18, push blocked |
| `Cognitive-Transmutation-Core` | Cognitive Transmutation Core / cognition and SELFTHOUGHT event runtime | README identifies cognitive kernel and immutable SELFTHOUGHT message/event runtime | `OURSELFMAC: ~/OURSELF/Cognitive-Transmutation-Core`; detached cognition selgate worktree | README-VERIFIED; multiple Mac instances, canonical writer unresolved |

## 4. Machine and instance interpretation

### REVERSELF / ALTONUMBUSELF — purpose, binding, and authority evidence (live recontact 2026-11-03)

**Repository identity:** `situaedmilly/ALTONUMBUSELF`; origin `https://github.com/situaedmilly/ALTONUMBUSELF.git`.

**Owning jurisdiction:** `OURSELFECOSYSTEM`; instance `ALTONUMBUSELF`; class `MEMORY_STORAGE`; substrate `GitHub`. This is supported by `OURSELF_INSTANCE.md` and the repository README.

**REVERSELF purpose:** `runtime/reverself/REVERSELF-0001.json` defines `REVERSELF-0001` as `MEMORY_BOUNDARY_CONTROLLER`, distinct from `MATTER-0001`. Its stated function is bounded, non-mutating claim scanning, comparison of externally observed bytes against receipts, and recording refusal/quarantine evidence without repairing state. Its invariants explicitly prohibit upgrading a receipt into future authority and prohibit setting `REALISELF` or the migration gate. Jurisdiction is OURSELFECOSYSTEM / ALTONUMBUSELF / GitHub.

**Active task binding, directly revalidated on OURSELFMAC:**
- Path: `/Users/millysituated/Projects/ALTONUMBUSELF`
- Origin: `https://github.com/situaedmilly/ALTONUMBUSELF.git`
- Branch: `morph-xi/selfmoat-proving`
- Local HEAD: `6d981a525e530bf0ed64615a6632838d71458c96`
- Tracked worktree changes: none observed; two untracked files are preserved: `runtime/reverself/recontact_harness.py` and `runtime/reverself/test_recontact_harness.py`.
- Live remote ref from `git ls-remote`: `3fdde73c099f9b99814d72dc224c638965be27e9`. The local `origin/morph-xi/selfmoat-proving` tracking ref remains at local HEAD `6d981a5...`; therefore the reported local `0/0` tracking status is stale and is not evidence of parity. No fetch, reset, merge, rebase, or worktree mutation was performed.

**Other observed local instances of the same repository:**
- `/Users/millysituated/Projects/ourself-core/ALTONUMBUSELF`: branch `main`, HEAD `9aa80ab53d034b36c3fae4474d1bdc9b2f0c3c9b`, clean.
- `/Users/millysituated/OURSELF/ALTONUMBUSELF`: branch `main`, same HEAD `9aa80ab53d034b36c3fae4474d1bdc9b2f0c3c9b`, clean.
- These three paths are separate worktrees/clones with the same GitHub origin. The Phase C evidence binds the REVERSELF task to the first path and branch; it does not by itself designate that path as the permanent sole canonical writer.

**Authority evidence and limits:**
- `evidence/morph-xiii/REVERSELF-PROOF-ADMISSION-001.json` records a finite admission based on explicit user instruction for MORPH-XIII Phase C, naming the repository, branch, exact artifact pack, and expected preimage `e71dde1ffc7fcacc3e8a879d25cc21f188575567`. It explicitly sets `standing_authority=false`.
- `runtime/reverself/REVERSELF-0001.json` records `SCOPED_BY_CURRENT_PHASE_C_DIRECTIVE`, `CURRENT_PREIMAGE_SCOPED`, and `NON_MUTATING_SCAN_AND_EVALUATION`; it also records the independent witness as `BLOCKED` and states that the Matter does not set REALISELF.
- Earlier `REVERSELF-001` / `REVERSELF-002` evidence is scoped to bounded memory-object continuity and isolated boundary-policy fixtures. It expressly does not establish standing repository memory authority, actual cloud drift, persistent quarantine, or cloud write-path enforcement.
- The current founder instruction authorizes completion of this ownership-map record. It does not refresh the older Phase C admission or grant blanket authority to modify ALTONUMBUSELF source, memory objects, graph, schema, or runtime state.

**Disposition:** repository purpose and owning reality VERIFIED; REVERSELF task-to-worktree binding VERIFIED; historical finite authority evidence VERIFIED as recorded; permanent canonical writer UNRESOLVED; live remote parity UNRESOLVED; independent witness BLOCKED; `REALISELF=false` and migration gate CLOSED per the cited REVERSELF evidence. Preserve the two untracked files and all three worktrees. Do not stage, commit, push, reset, or reconcile the ALTONUMBUSELF task branch until a fresh preimage-bound admission and branch-lineage reconciliation exist.

### OURSELFMAC

The earlier registry records 22 worktree entries. Several GitHub repositories have more than one observed local instance:
- `ourself-core`: two worktrees.
- `ourself-agent-bridge-kernel`: two worktrees.
- `OURPROCESSORSELF`: two primary worktrees plus a detached selgate worktree.
- `self-communication`: two worktrees.
- `ALTONUMBUSELF`: two worktrees.
- `Cognitive-Transmutation-Core`: primary plus detached selgate worktree.

These are not automatically redundant. They may represent active development, isolation, or historical work. No canonical writer is designated solely by path naming.

### OURSELFPIMAC

The earlier registry records 11 worktree/workspace entries. The primary `ourself-agent-bridge-kernel` checkout and the `ourself-control-plane` shared-object-database checkout remain quarantined because the malformed pack-index condition is shared. Do not stage, commit, repair in place, or push either until a verified protected-copy recovery exists.

The Pi `ourself-agent-bridge-control-plane` path maps to a local mirror. Treat this as a mirror-backed instance until remote write-through and canonical branch authority are independently verified.

Recovery rehearsals and forensic specimens are evidence stores, not canonical production source repositories. Third-party `llama.cpp` and `gh-webhook` checkouts are external dependencies, not OURSELF-owned repositories.

## 5. Branch authority

GitHub metadata was queried for all 29 repositories. All returned repository metadata grants the connected identity admin/maintain/push permissions. This establishes observed account capability, not project-level authority or enforcement.

Default branch observations:
- 28 repositories report `main`.
- `Bubbleself` reports `claude/new-session-47gm2u`.

Default branch is not equivalent to a protected branch. Branch protection, rulesets, required checks, bypass actors, and force-push policy remain uninspected. No repository is marked enforcement-compliant on this basis.

## 6. Resolution status

| Resolution class | Count |
|---|---:|
| README-VERIFIED candidate owner | 15 |
| ARCHITECTURE-VERIFIED candidate owner | 1 |\n| CONTEXT-CANDIDATE / partial-purpose candidate | 6 |
| UNRESOLVED | 6 |
| EXTERNAL-CANDIDATE | 1 |
| **Total** | **29** |

Counts classify evidence strength, not adoption. Even README-VERIFIED rows remain candidate owners until jurisdiction is confirmed and canonical machine/branch binding is established.

## 7. Required closure evidence

1. Founder/jurisdiction confirmation for each candidate owner and all seven unresolved rows.
2. Current live revalidation of every path in the 22 Mac / 11 Pi baseline before any path is declared canonical.
3. Per-repository remote URL, default branch, HEAD, upstream, dirty state, divergence, and object integrity.
4. Explicit canonical writer selection for every repository with multiple worktrees.
5. Explicit `REMOTE_ONLY`, `ARCHIVED`, `EXTERNAL`, or `FORENSIC_SPECIMEN` disposition where no canonical source worktree exists.
6. Branch ruleset and required-check evidence before any enforcement-compliant status.
7. A per-repository adoption receipt only after the relevant invariants pass.

## 8. Current governing state

`GITHUB_INVENTORY = 29 VERIFIED`  
`OWNERSHIP = 15 README-VERIFIED CANDIDATES / 1 ARCHITECTURE-VERIFIED CANDIDATE / 6 CONTEXT CANDIDATES / 6 UNRESOLVED / 1 EXTERNAL CANDIDATE`  
`CANONICAL_WORKTREE = UNRESOLVED WHERE MULTIPLE OR NOT OBSERVED`  
`MACHINE_BINDING = PRIOR BASELINE EVIDENCE; LIVE REVALIDATION PENDING`  
`BRANCH_AUTHORITY = DEFAULT BRANCH OBSERVED; PROTECTION UNVERIFIED`  
`CUSTODY_ENFORCEMENT = UNVERIFIED`  
`ECOSYSTEM_ADOPTION = PENDING PER-REPOSITORY CLOSURE`

This is a candidate ownership resolution, not final ownership assignment. Unknown remains unknown until evidence closes it.
