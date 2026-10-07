# BlobSELF REVERSELF v1

## Purpose

BlobSELF REVERSELF provides an authenticated, read-only AgentBridge surface for observing a GitHub file blob through GitHub HTTP and optionally comparing that remote Git blob identity with a local file.

## Constitutional boundary

- OBSERVATION != ADMISSION
- GITHUB_BLOB != LOCAL_FILE
- BLOB_SHA != CONTENT_AUTHORITY
- REMOTE_HTTP != EXECUTION
- CONFIGURATION_EVIDENCE != EXECUTION_EVIDENCE
- No GitHub mutation is performed by the observation route.
- No shell command is executed by the observation route.
- No model is started or invoked by the observation route.

## HTTP surface

`POST /blobself/reverse-engineer`

Authentication:

`x-ourself-token`

Request:

```json
{
  "owner": "situaedmilly",
  "repo": "ourself-agent-bridge-kernel",
  "path": "README.md",
  "ref": "main",
  "localPath": "/Users/millysituated/OURSELF/..."
}
```

The route:

1. Validates the GitHub locator.
2. Performs a read-only GitHub HTTP GET against the repository contents API.
3. Establishes remote blob metadata when a file resolves.
4. Optionally resolves `localPath` through the existing AgentBridge filesystem boundary.
5. Computes the local Git blob SHA using Git's `blob <byte-length>\0` framing.
6. Emits a durable observation event.
7. Returns a bounded witness.
8. Performs no write or execution.

## Witness shape

```json
{
  "status": "OBSERVED",
  "admission": "READ_ONLY_REMOTE_OBSERVATION",
  "witness": {
    "witness_version": "ourself.blobself.witness.v1",
    "source": "GITHUB_HTTP",
    "locator": {},
    "blob": {
      "sha": "...",
      "size": 0,
      "name": "...",
      "path": "...",
      "html_url": "...",
      "download_url": "..."
    },
    "comparison": null,
    "observed_at": "..."
  }
}
```

## ReverseSELF crossing

```
GitHub HTTP
    |
    v
REMOTE BLOB OBSERVATION
    |
    +--> blob SHA / size / locator
    |
    +--> optional LOCAL FILE
             |
             v
        Git blob SHA
             |
             v
        MATCH / MISMATCH
             |
             v
      AgentBridge witness
```

## Explicit non-actions

BlobSELF does not:

- create or update GitHub blobs;
- create commits;
- update refs;
- execute shell commands;
- dispatch terminal proposals;
- start models;
- grant authority;
- convert observation into admission.

GitHub's Git database API separately supports blob creation, tree creation, commits, and ref updates. Those are intentionally outside this v1 observation route.
