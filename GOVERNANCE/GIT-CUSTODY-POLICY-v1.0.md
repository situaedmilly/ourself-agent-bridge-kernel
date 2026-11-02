# OURSELF Git Custody and Commit Policy v1.0

**Status:** Founder-directed governance policy  
**Effective:** 2026-11-02  
**Authority:** Founder / Genesis Authority  
**Scope:** Every OURSELF-controlled repository, worktree, host, runtime instance, and ecosystem manifestation that has an identified repository custody path.

## 1. Constitutional rule

Every durable software or architecture manifestation produced, modified, or accepted as OURSELF work MUST be recorded in Git and pushed to its corresponding GitHub repository.

A manifestation includes, where applicable:
- source code, scripts, adapters, agents, and runtime components;
- contracts, schemas, specifications, doctrine, architecture, and configuration templates;
- tests, fixtures, reproducible build definitions, and CI workflows;
- registries, manifests, inventories, and state-transition definitions;
- sanitized evidence packets, verification reports, and release notes;
- deployment descriptors and infrastructure-as-code;
- corrections, reversals, superseding versions, and rollback instructions.

This rule applies across all identified OURSELF instances and their owning repositories. It does not mean copying every artifact into every repository. Each artifact is committed to its canonical owning repository; cross-repository dependencies are linked by explicit references and version/commit identifiers.

## 2. Commit cadence

1. Commit each coherent, reviewable manifestation batch as soon as its implementation and required validation are complete.
2. Push that commit to the corresponding GitHub repository without unnecessary delay.
3. Use descriptive, scoped commit messages and preserve traceability to the task, evidence, and affected instance.
4. Do not accumulate unrelated completed manifestations into a single opaque commit.
5. If a manifestation spans multiple repositories, create a corresponding commit in each owning repository and record the cross-repository commit map.
6. If a host is offline or GitHub is unreachable, preserve the local commit, record `PUSH_PENDING`, and retry when connectivity returns. Never report a push as successful until the remote ref is verified.
7. If branch protection prevents direct updates, push a dedicated branch and open or prepare a pull request. Do not bypass protection.

## 3. Pre-commit integrity gate

Before staging or committing:
- inspect the repository root, current branch, upstream, status, staged diff, and unstaged diff;
- identify the exact files belonging to the current manifestation;
- run relevant tests, validators, format checks, and build checks;
- inspect the diff for secrets, credentials, private keys, tokens, personal data, proprietary customer data, and unsafe disclosures;
- verify that evidence distinguishes DECLARED, DISCOVERED, OBSERVED, VERIFIED, ADMITTED, EXECUTED, and EFFECT_WITNESSED;
- ensure documentation does not promote unresolved states or claim unverified effects;
- record validation results and any known limitations.

Only the files belonging to the authorized manifestation may be staged. Existing user changes, unrelated work, unknown files, and unrelated staged content MUST remain untouched.

## 4. Exclusions and protected material

The commit mandate does not authorize publishing:
- private keys, seed phrases, passwords, access tokens, session cookies, or credential material;
- raw authentication exchanges or sensitive account/device data;
- personal data or customer-confidential information without an established lawful basis and explicit scope;
- transient caches, dependency trees, build output, temporary files, editor metadata, or uncontrolled runtime logs;
- unreviewed crash dumps, memory dumps, packet captures, or raw forensic collections;
- large binaries or model weights unless the owning repository explicitly defines an approved artifact-storage policy.

Where evidence is sensitive, commit a sanitized evidence record, hashes, provenance, and a controlled reference to the protected source instead of the raw material. A secret discovered in a diff blocks the commit until it is removed and, where exposure occurred, rotated.

## 5. Branch and history safety

- Commit on the current task branch or a dedicated feature/governance branch.
- Do not force-push, rewrite published history, reset away user work, or overwrite another contributor's changes.
- Do not commit directly to a protected/default branch when repository policy requires review.
- Do not stage with blanket commands such as `git add -A` or `git add .` in a dirty worktree.
- Never treat a local commit as a GitHub push, a GitHub push as a deployment, or a deployment as proof of runtime effect.
- Preserve rollback paths and record the commit that introduced each material runtime change.

## 6. Cross-instance custody

Maintain an inventory of:
- physical and virtual instances;
- repository/worktree path and canonical GitHub remote;
- active branch and upstream;
- owner and authority boundary;
- last verified commit and push state;
- offline, blocked, damaged, or unresolved Git custody state.

Each instance must commit its own source changes to the repository that owns those changes. Shared architecture must use explicit contracts and references, not untracked copies or silent divergence.

A machine with a damaged Git object database, unresolved identity, uncertain repository root, or ambiguous remote is **NOT READY TO COMMIT**. Preserve its work and repair custody before mutation.

## 7. Evidence and completion states

Use explicit states:
- `WORKING_TREE_ONLY`
- `VALIDATED_LOCAL`
- `COMMITTED_LOCAL`
- `PUSHED_TO_GITHUB`
- `REMOTE_REF_VERIFIED`
- `DEPLOYED`
- `RUNTIME_EFFECT_VERIFIED`

Never collapse these states. A commit receipt must include repository, branch, commit SHA, parent SHA, scoped file list, validation summary, push result, and remote-ref verification result when available.

## 8. Operational default for future OURSELF work

For every future OURSELF task, the execution plan MUST include Git custody:
1. identify the owning repository and instance;
2. inspect status before editing;
3. implement and validate the manifestation;
4. stage only the scoped files;
5. commit locally;
6. push to GitHub;
7. verify the remote branch/ref;
8. report commit SHA, repository, branch, validation, and any blocked/pending state.

If any step cannot be completed safely, stop at the last verified state, preserve the work, and state the exact blocker. Do not silently omit Git custody.

## 9. Non-equivalence invariants

- Manifested locally != committed.
- Committed locally != pushed.
- Pushed != remote ref verified.
- Remote ref verified != deployed.
- Deployed != runtime effect verified.
- Git custody != independent certification.
- A commit records an artifact; it does not grant authority, admission, jurisdiction, or execution permission.

This policy governs artifact custody. It does not grant permission to mutate hardware, alter credentials, bypass admission, deploy to production, or change runtime authority.
