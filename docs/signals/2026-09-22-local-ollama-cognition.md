# Local Ollama Cognition Signal

**Signal Number:** `OURSELF-SIG-20260922-001`  
**Message Number:** `OURSELF-MSG-20260922-001`  
**GitHub Issue:** #18  
**Host:** OURSELFPIMAC  
**Observed:** 2026-09-22

## Proven runtime

```
Linux OURSELFPIMAC 6.18.39+rpt-rpi-2712 #1 SMP PREEMPT Debian 1:6.18.39-1+rpt1 (2026-07-29) aarch64
Ollama: 127.0.0.1:11434
```

Installed models observed:

| Model | ID | Size | Parameters | Quantization | Context | Capabilities |
|---|---|---:|---:|---|---:|---|
| `qwen2.5-coder:7b` | `dae161e27b0e` | 4.7 GB | 7.6B | Q4_K_M | 32768 | completion, tools, insert |
| `qwen2.5-coder:0.5b` | `4ff64a7f502a` | 397 MB | 494.03M | Q4_K_M | 32768 | completion, tools, insert |

## Direct inference receipt

A direct request was sent to:

```
POST http://127.0.0.1:11434/api/chat
```

with:

```json
{
  "model": "qwen2.5-coder:7b",
  "messages": [
    {
      "role": "user",
      "content": "Respond with exactly: OURSELF COGNITION ONLINE"
    }
  ],
  "stream": false
}
```

Observed response:

```json
{
  "model": "qwen2.5-coder:7b",
  "message": {
    "role": "assistant",
    "content": "OURSELF COGNITION ONLINE"
  },
  "done": true,
  "done_reason": "stop",
  "prompt_eval_count": 39,
  "eval_count": 7
}
```

Observed timing:

- total duration: 64.515120840 seconds
- model load duration: 58.334651514 seconds
- prompt evaluation duration: 3.785727 seconds
- generation duration: 2.391560 seconds
- output tokens: 7

## State transition

The following transition is now witnessed:

```
OURSELFPIMAC
    ↓
Ollama :11434
    ↓
qwen2.5-coder:7b
    ↓
/api/chat
    ↓
OURSELF COGNITION ONLINE
```

This proves local cognition availability. It does **not** prove AgentBridge-to-Ollama routing, SUPERBIN admission, or OS actuation.

## Sovereignty boundary

The intended governed path remains:

```
MODEL INTENT
    ↓
SUPERBIN IR
    ↓
ADMISSION
    ↓
ourselfd
    ↓
OS
    ↓
RECEIPT
```

Therefore:

```
COGNITION ≠ AUTHORITY
VALID ≠ AUTHORIZED ≠ ACTUATABLE ≠ EXECUTED ≠ WITNESSED ≠ ADMITTED
```

## Next proof

The next bounded experiment is:

```
AgentBridge
    ↓
Ollama :11434
    ↓
qwen2.5-coder:7b
```

Acceptance requires a witnessed deterministic response and a recorded receipt, without granting execution authority merely because model inference is available.
