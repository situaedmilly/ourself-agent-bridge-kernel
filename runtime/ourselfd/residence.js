const REQUIRED_RESIDENCE_EVIDENCE = Object.freeze([
  "INSTALL",
  "LOAD",
  "BIRTH",
  "PROCESS_IDENTITY",
  "LIVENESS",
  "RECONTACT"
]);

export const RESIDENCE_STATES = Object.freeze({
  UNPROVEN: "UNPROVEN",
  PROVEN: "PROVEN"
});

function assertEvidenceShape(evidence) {
  if (!evidence || typeof evidence !== "object") {
    throw new Error("RESIDENCE_EVIDENCE_INVALID");
  }
  if (typeof evidence.species !== "string" || !evidence.species) {
    throw new Error("RESIDENCE_EVIDENCE_SPECIES_INVALID");
  }
  if (typeof evidence.instance_id !== "string" || !evidence.instance_id) {
    throw new Error("RESIDENCE_EVIDENCE_INSTANCE_INVALID");
  }
}

export function evaluateMachineResidence(evidenceGraph) {
  if (!Array.isArray(evidenceGraph)) {
    throw new Error("RESIDENCE_GRAPH_INVALID");
  }

  const bySpecies = new Map();

  for (const evidence of evidenceGraph) {
    assertEvidenceShape(evidence);
    if (!bySpecies.has(evidence.species)) {
      bySpecies.set(evidence.species, evidence);
    }
  }

  const missing = REQUIRED_RESIDENCE_EVIDENCE.filter(
    (species) => !bySpecies.has(species)
  );

  if (missing.length) {
    return {
      state: RESIDENCE_STATES.UNPROVEN,
      missing,
      instance_id: null
    };
  }

  const instanceIds = new Set(
    REQUIRED_RESIDENCE_EVIDENCE.map((species) => bySpecies.get(species).instance_id)
  );

  if (instanceIds.size !== 1) {
    return {
      state: RESIDENCE_STATES.UNPROVEN,
      missing: [],
      reason: "INSTANCE_LINEAGE_MISMATCH",
      instance_id: null
    };
  }

  const birthIdentity = bySpecies.get("BIRTH").payload?.process_identity;
  const recontactIdentity = bySpecies.get("RECONTACT").payload?.process_identity;

  if (!birthIdentity || !recontactIdentity || birthIdentity !== recontactIdentity) {
    return {
      state: RESIDENCE_STATES.UNPROVEN,
      missing: [],
      reason: "PROCESS_IDENTITY_RECONTACT_MISMATCH",
      instance_id: [...instanceIds][0]
    };
  }

  return {
    state: RESIDENCE_STATES.PROVEN,
    missing: [],
    instance_id: [...instanceIds][0],
    process_identity: birthIdentity
  };
}

export function requiredResidenceEvidence() {
  return [...REQUIRED_RESIDENCE_EVIDENCE];
}
