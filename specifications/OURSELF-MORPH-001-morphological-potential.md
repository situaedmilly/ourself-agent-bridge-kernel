# OURSELF MORPH-001 — Morphological Potential and Jurisdictional Field

Status: proposed computational layer, additive and non-authoritative.

## Primitive

MORPH is a constrained transformation of a state through a declared correspondence field, subject to bounded influence and jurisdictional membrane constraints, producing an observable effect and a separately verifiable receipt.

MORPHOLOGICAL_POTENTIAL is bounded relational capacity represented as a computable transformation field over a defined domain.

## Constitutional separations

- CORRESPONDENCE != AUTHORIZATION
- POTENTIAL != PERMISSION
- FIELD != EFFECT
- EFFECT != PROOF
- FIELD_COMPILER != ACTUATOR
- MEMBRANE_EVALUATOR != AUTHORITY_GRANTOR

The caller may declare the transformation relation. The runtime computes the field from the declared correspondence and field parameters. The caller cannot assert the computed field as valid.

## Lifecycle

```
MORPH_DECLARED
  -> CORRESPONDENCE_VALIDATED
  -> FIELD_COMPILED
  -> FIELD_BOUNDED
  -> MEMBRANE_EVALUATED
  -> ADMITTED | DENIED
  -> ACTUATED
  -> OBSERVED
  -> RECEIPTED
  -> VERIFIED
```

No direct MORPH_DECLARED -> VERIFIED promotion exists.

## SUPERBIN boundary

A SUPERBIN_MORPH_SPEC contains:

- origin_state_commitment
- correspondence_set
- domain
- field_parameters
- invariant_set
- membrane_ref
- authority_ref
- admission_conditions
- actuator_contract
- receipt_contract

The executable SUPERBIN does not contain an authoritative precomputed potential field. The field is derived by the runtime compiler.

## Field model

For a query point X and correspondence samples i:

```
Delta(X) = sum_i w_i(X) * Delta_i(X) / sum_i w_i(X)
```

where weights and displacement samples are runtime inputs constrained by the declared domain and field parameters.

This specification records the reusable field-construction invariant. It does not claim that a particular geometric implementation is equivalent to Beier–Neely. Beier–Neely is field-construction ancestry only; OURSELF jurisdiction and evidence semantics remain independent.

## Membrane invariant

For an effect region R:

```
R notin AdmittedDomain => E(R) <= epsilon
```

epsilon MUST be explicit when a non-zero tolerance is permitted. A strict membrane uses epsilon = 0.

## Security posture

The compiler is pure and non-authoritative. It does not start processes, write arbitrary files, mutate external state, grant authority, or actuate a morph.

A compiled field is potential evidence, not effect evidence.

## Rollback

Delete the additive MORPH implementation, contract, and tests. No existing capability contract or actuator is modified by this layer.
