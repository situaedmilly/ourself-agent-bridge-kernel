# Canonical Observation Boundary v0

## Identity

Canonical Observation Boundary v0 is the deterministic repository-declared observation gate for the reverse_engineer Pass 20C analysis primitive.

## Purpose

Ensure that the structural analysis artifact is invariant under ephemeral environmental additions (ignored scratch files, unrelated cache directories, arbitrary noise). The observation must depend only on repository-declared state, not on environmental enumeration accidents.

## Constitutional Law

Observation must be invariant under non-canonical environmental additions:

```
canonical repository state
        +
arbitrary ignored scratch artifacts
        =
identical analysis result
```

The proof surface must not depend on:
- directory enumeration order
- unrelated scratch-file count
- harness worktrees
- incidental cache directories
- arbitrary traversal order
- whether an ephemeral directory sorts before root manifests

## Design

### 1. Identity-First Root Pass

Before any recursive analysis, establish project identity independently:

**Root Identity Manifests** (detected in parallel, sorted lexicographically):
- `package.json`
- `go.mod`
- `Cargo.toml`
- `pyproject.toml`
- `requirements.txt`
- `setup.py`
- `pom.xml`
- `build.gradle`
- `Gemfile`
- `composer.json`
- `.git`
- `README.md`, `README`
- `src`, `test`, `tests`

This pass occurs BEFORE recursive traversal and independent of `MAX_ENTRIES`.

### 2. Canonical Inventory for Git Repositories

For Git repositories, canonical state is derived from a single deterministic query:

**Command**: `git ls-files -z --cached --others --exclude-standard`

**Semantics**:
- `--cached`: tracked files
- `--others`: untracked files not in .gitignore
- `--exclude-standard`: exclude via .gitignore, .git/info/exclude

**Invariants**:
- Single invocation per analysis
- Arguments fixed by implementation (no user injection)
- Output parsed as NUL-delimited paths
- Paths sorted lexicographically
- Ignored files never listed, never consume MAX_ENTRIES budget
- No shell interpolation

**Execution**: `execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root })`

Fallback on failure: use bounded filesystem traversal.

### 3. Non-Git Fallback

For non-Git repositories, bounded filesystem traversal with deterministic ordering:

**Ephemeral Exclusions** (never traversed):
- `.git`
- `node_modules`
- `dist`, `build`, `coverage`
- `.next`, `.cache`, `.turbo`
- `vendor`
- `.venv`, `__pycache__`

**Constraints**:
- Directory entries sorted before traversal
- Depth limited to `MAX_DEPTH` (12)
- Total entries capped at `MAX_ENTRIES` (4000)
- Secret paths refused (no contents read)
- Symlinks validated against boundary

### 4. Root Identity Outranks Traversal Limits

The MAX_ENTRIES limit applies to deep evidence collection (routes, schemas, workflows, language counts) but does not erase root identity.

**Guaranteed**:
- Root manifests remain discoverable even with truncation
- Project type detection independent of traversal depth
- `package.json` presence is observable regardless of entry budget

### 5. Result Normalization

All observable result fields are deterministically ordered:

- `dependencies`: sorted lexicographically
- `routes`: sorted lexicographically
- `schemas`: sorted lexicographically
- `workflows`: sorted lexicographically
- `entrypoints`: sorted lexicographically
- `primary_languages`: by count descending, then name
- `directories`: sorted lexicographically
- `files`: sorted lexicographically

## Canonical State Definition

```javascript
canonical_observation_boundary: {
  canonical_state: {
    git_repository: 'repository-declared inventory (git ls-files)',
    non_git_repository: 'sorted bounded filesystem inventory'
  },
  ephemeral_state: {
    ignored_files: 'excluded, never observed',
    effect_on_analysis: 'NONE'
  },
  root_identity: {
    detection_priority: 'BEFORE_RECURSIVE_TRAVERSAL',
    manifests: ['package.json', 'go.mod', 'Cargo.toml', ...],
    determinism: 'lexicographically sorted'
  },
  limits: {
    may_reduce_deep_evidence: true,
    may_erase_root_identity: false,
    max_entries: 4000,
    max_depth: 12
  }
}
```

## Invariance Property

**Theorem**: If the canonical repository state is unchanged, the analysis result projection remains identical.

**Comparison Fields** (must be equal before and after):
- `project_type`
- `dependencies` (sorted)
- `routes` (sorted)
- `schemas` (sorted)
- `workflows` (sorted)
- `entrypoints` (sorted)
- `primary_languages`

**Proof Strategy**:
1. Establish baseline analysis on clean repository
2. Inject thousands of ignored files (in .claude/, .cache/, or non-tracked paths)
3. Re-analyze with identical parameters
4. Verify canonical projection unchanged
5. Verify ignored files never appear in `structure.files` or `structure.directories`
6. Verify analysis budget not consumed by ignored paths

## Testing

### Regression Tests

All existing behavior is pinned:
- Project type detection (node, go, rust, python, java, ruby, php, unknown)
- Dependency discovery (package.json fields)
- Route detection (Express patterns)
- Config file detection
- Test file pattern matching
- Secret path refusal
- Boundary enforcement

### Invariance Tests

1. **Determinism**: Same input → Same output (git-based, sorted)
2. **Scratch Resistance**: Ignored files don't affect analysis
3. **Root Identity**: Detection before truncation
4. **Budget Independence**: Ignored files don't consume MAX_ENTRIES
5. **Semantic Equivalence**: Canonical vs filesystem modes produce identical canonical projections

### Targeted Tests

1. Git repository with large ignored tree
2. Non-Git repository with large .cache/ tree
3. Ignored directory with name sorting before root manifests
4. Meaningful tracked change detection (ensure changes ARE observed)
5. Canonical projection stability

## Implementation Notes

### Git Inventory Parsing

- Output is NUL-terminated (`-z` flag)
- Split on `\0`, filter empty strings
- Relative paths from repository root
- Already excludes ignored files (git's job)
- No shell expansion occurs

### Fallback Robustness

If `git ls-files` fails (not in Git repo, git not available, permission issue):
- Gracefully falls back to bounded filesystem traversal
- Maintains all safety invariants
- Returns equivalent canonical projection

### Performance

- Single git query per analysis (not per file)
- Git execution is O(repository size) once, not O(discovered files)
- Filesystem fallback uses MAX_ENTRIES cap
- Content scanning is bounded (MAX_CONTENT_SCAN_FILES, MAX_CONTENT_BYTES)

## Boundary Invariants

### Secrets

Secret-bearing paths are NEVER:
- Traversed in filesystem walk
- Listed in git inventory (due to .gitignore)
- Scanned for content
- Exposed in risks (except notation that they were excluded)

### Symlinks

All symlinks are:
- Resolved before inclusion
- Validated against RUORA boundary
- Outside-boundary targets logged as risks, not followed

### Child Process Containment

The single `execFileSync('git', ...)` invocation is:
- Fixed arguments (no interpolation)
- Safe path passing (target path in cwd, not arguments)
- Bounded output (NUL-delimited paths)
- No shell context
- Fail-safe (exception caught, fallback engaged)

## Status

- **Specification Version**: v0
- **Implementation**: tools/reverse-engineer.js
- **Tests**: test/reverse-engineer.test.js
- **Authorization**: BOUNDED_SINGLE_GATE_IMPLEMENTATION
- **Verification**: PENDING

## Regression Baseline

Expected test result post-implementation:

```
targeted_reverse_engineer_suite: ZERO_FAILURES
full_live_checkout_suite: 440/440_PASS
clean_checkout_suite: 440/440_PASS_OR_HIGHER
invariance_suite: ZERO_FAILURES
canonical_observation_tests: ZERO_FAILURES
```
