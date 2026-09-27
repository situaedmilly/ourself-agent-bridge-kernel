import contract from './selfgraph-realiself-instance-requirements.v1.json' with { type: 'json' };

export const REQUIRED_GRAPH_IDS = new Set(
  contract.jurisdiction_instance_requirements.map((item) => item.graph_id),
);

export function validateRealiseLFInstanceSet(instances = [], relations = []) {
  const errors = [];
  const counts = new Map();

  for (const instance of instances) {
    if (!instance?.graph_id) {
      errors.push('INSTANCE_MISSING_GRAPH_ID');
      continue;
    }
    if (!REQUIRED_GRAPH_IDS.has(instance.graph_id)) {
      errors.push(`UNKNOWN_GRAPH_INSTANCE:${instance.graph_id}`);
      continue;
    }
    counts.set(instance.graph_id, (counts.get(instance.graph_id) ?? 0) + 1);
    if (instance.standing !== 'WITNESSED') {
      errors.push(`INSTANCE_NOT_WITNESSED:${instance.graph_id}`);
    }
  }

  for (const requirement of contract.jurisdiction_instance_requirements) {
    if ((counts.get(requirement.graph_id) ?? 0) < requirement.minimum_instances) {
      errors.push(`MISSING_JURISDICTION_INSTANCE:${requirement.graph_id}`);
    }
  }

  for (const relation of relations) {
    if (!REQUIRED_GRAPH_IDS.has(relation?.source_jurisdiction) ||
        !REQUIRED_GRAPH_IDS.has(relation?.target_jurisdiction)) {
      errors.push(`UNKNOWN_CROSS_GRAPH_ENDPOINT:${relation?.relation_type ?? 'UNKNOWN'}`);
    }
    if (relation?.source_jurisdiction === relation?.target_jurisdiction) {
      errors.push(`RELATION_NOT_CROSS_GRAPH:${relation?.relation_type ?? 'UNKNOWN'}`);
    }
    if (relation?.witnessed !== true) {
      errors.push(`CROSS_GRAPH_RELATION_NOT_WITNESSED:${relation?.relation_type ?? 'UNKNOWN'}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    minimum_jurisdiction_instance_count: contract.minimum_jurisdiction_instance_count,
    observed_jurisdiction_instance_count: [...counts.values()].reduce((sum, value) => sum + value, 0),
  };
}

export function canDescribeTargetAsRealized(instances = [], relations = []) {
  return validateRealiseLFInstanceSet(instances, relations).valid;
}

export { contract };
