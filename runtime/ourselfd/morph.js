/**
 * OURSELF MORPH-001
 * Pure morphological-potential compiler.
 *
 * This module computes bounded field potential only.
 * It does not authorize, actuate, observe external effects, or write state.
 */

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function compileMorphField(samples, queryPoints, { maxDisplacement }) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new TypeError("correspondence_set must contain at least one sample");
  }
  if (!Array.isArray(queryPoints)) {
    throw new TypeError("queryPoints must be an array");
  }
  if (!Number.isFinite(maxDisplacement) || maxDisplacement <= 0) {
    throw new TypeError("maxDisplacement must be a positive finite number");
  }

  return queryPoints.map((x) => {
    let weighted = 0;
    let weightTotal = 0;

    for (const sample of samples) {
      if (!Number.isFinite(sample.position) || !Number.isFinite(sample.displacement) ||
          !Number.isFinite(sample.weight) || sample.weight <= 0) {
        throw new TypeError("invalid correspondence sample");
      }

      const distance = Math.abs(x - sample.position);
      const weight = sample.weight / Math.max(distance, Number.EPSILON);
      weighted += weight * sample.displacement;
      weightTotal += weight;
    }

    const raw = weighted / weightTotal;
    return {
      position: x,
      displacement: clamp(raw, -maxDisplacement, maxDisplacement)
    };
  });
}

export function evaluateMembrane(domain, admittedDomain, field, epsilon = 0) {
  if (!Array.isArray(domain) || !Array.isArray(admittedDomain) || !Array.isArray(field)) {
    throw new TypeError("domain, admittedDomain, and field must be arrays");
  }
  if (!Number.isFinite(epsilon) || epsilon < 0) {
    throw new TypeError("epsilon must be a non-negative finite number");
  }

  const allowed = new Set(admittedDomain);
  return field.map((point) => ({
    ...point,
    admitted: allowed.has(point.region),
    withinTolerance: allowed.has(point.region) || Math.abs(point.displacement) <= epsilon
  }));
}

export function morphLifecycle() {
  return [
    "MORPH_DECLARED",
    "CORRESPONDENCE_VALIDATED",
    "FIELD_COMPILED",
    "FIELD_BOUNDED",
    "MEMBRANE_EVALUATED",
    "ADMITTED_OR_DENIED",
    "ACTUATED",
    "OBSERVED",
    "RECEIPTED",
    "VERIFIED"
  ];
}
