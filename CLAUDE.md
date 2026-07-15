# OURSELF Signal Boot

Before repository inspection or mutation:

1. Read `.ourself/workflow-signals.v1.json`.
2. Scan the incoming WORKFLOWEXECUTIONSPEECH for exact `*_SIGNAL` markers.
3. Resolve by priority and announce `CONTROLLING_SIGNAL`.
4. Enforce all lower-priority signals as constraints.
5. No known marker: return `UNCLASSIFIED_SIGNAL` and stop before inspection.
6. Unknown marker: return `UNKNOWN_SIGNAL` and fail closed.
7. `STOP_SIGNAL` overrides all signals.
8. `SEAL_SIGNAL` does not grant mutation authority.
9. `FOUNDATION_SIGNAL` never grants mutation authority.

Use `OPERATING_SIGNAL` for session-posture, context-budget, archaeology, or execution-mode shifts.
