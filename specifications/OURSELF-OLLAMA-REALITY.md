# OURSELF Ollama Reality

## Purpose

Define Ollama as the local model-serving substrate for the OURSELF cognitive ecosystem without collapsing the model, runtime, agent, execution environment, or evidence layer into one identity.

## Ontology

| Layer | Identity | Function |
|---|---|---|
| Constitutional system | OURSELF | doctrine, jurisdiction, invariants |
| Cognitive substrate | OURSELFLLM | language, reasoning, semantic compilation |
| Agent | ALCHEMYSELF | orchestration and transformation |
| Inspection | THIRDEYE_HARNESS | adversarial review and witnessing |
| Chamber | CHAMBOXREALITY | bounded admission, execution, observation, verification |
| Model realization | QWENSELF | model instance used for local cognition |
| Runtime | OLLAMA | local model serving |
| Compute | MACHINE_OS | physical/virtual compute substrate |
| Persistence | MEMORY_LEDGER | lineage, receipts, state |

## Runtime Boundary

The canonical transition is:

```
OURSELFLLM
  -> ALCHEMYSELF
  -> THIRDEYE_HARNESS
  -> CHAMBOXREALITY
  -> OLLAMA / QWENSELF
  -> COMPUTATION
  -> RECEIPT
  -> MEMORY
  -> RECONTACT
```

The model may generate plans, algorithms, code, semantic objects, and transition contracts. It does not thereby gain authority to execute those transitions.

## Ollama API Surface

The adapter intentionally uses Ollama's local HTTP API:

- `GET /api/version` for runtime version.
- `GET /api/tags` for locally available models.
- `GET /api/ps` for currently running models.
- `POST /api/show` for model metadata.
- `POST /api/chat` for cognitive inference.

Structured output is requested through the `format` field. Runtime telemetry such as token counts and durations is retained as computational evidence, not proof of external world-state change.

## Configuration

Defaults:

```text
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen2.5-coder:7b
```

The adapter does not read credentials and does not mutate environment state.

## State Law

```
COGNITIVELY_BOUND
AGENTICALLY_PLANNED
AUTHORIZED
ADMITTED
ACTUATED
OBSERVED
VERIFIED
PERSISTED
```

These states are distinct. A successful `/api/chat` response establishes model-runtime activity, not external actuation.

## Failure Law

Malformed structured output remains untrusted:

```
MODEL_OUTPUT
  -> PARSE
  -> VALIDATE
  -> ADMIT
```

A JSON parse failure is not silently converted into a successful cognitive transition.

## Security Boundary

The default endpoint is loopback. The adapter does not execute shell commands, write Git state, authorize proposals, or mutate governance files.

## Recontact

A runtime witness should query `/api/version`, `/api/tags`, and `/api/ps` before treating a remembered Ollama state as current.
