import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REQUIRED_GRAPH_IDS,
  canDescribeTargetAsRealized,
  contract,
  validateRealiseLFInstanceSet,
} from '../specifications/selfgraph-realiself/validator.js';

function witnessedSet() {
  return [...REQUIRED_GRAPH_IDS].map((graph_id) => ({
    graph_id,
    instance_id: `INSTANCE:${graph_id}:001`,
    standing: 'WITNESSED',
  }));
}

test('SELFGRAPH REALISELF contract requires exactly 17 minimum jurisdiction instances', () => {
  assert.equal(contract.minimum_jurisdiction_instance_count, 17);
  assert.equal(REQUIRED_GRAPH_IDS.size, 17);
});

test('a complete witnessed one-per-jurisdiction set is realizelf-ready', () => {
  const result = validateRealiseLFInstanceSet(witnessedSet(), []);
  assert.equal(result.valid, true, result.errors.join(', '));
  assert.equal(result.observed_jurisdiction_instance_count, 17);
  assert.equal(canDescribeTargetAsRealized(witnessedSet(), []), true);
});

test('missing or unwitnessed instances fail closed', () => {
  const instances = witnessedSet().filter((item) => item.graph_id !== 'EVIDENCE');
  instances.push({ graph_id: 'ACTION', instance_id: 'ACTION:002', standing: 'PERSISTED' });
  const result = validateRealiseLFInstanceSet(instances, []);
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes('MISSING_JURISDICTION_INSTANCE:EVIDENCE'));
  assert.ok(result.errors.includes('INSTANCE_NOT_WITNESSED:ACTION'));
});

test('admission is a witnessed cross-graph relation, never an instance jurisdiction', () => {
  const relation = {
    relation_type: 'ADMITTED_AS',
    source_jurisdiction: 'AUTHORITY',
    target_jurisdiction: 'ACTION',
    witnessed: true,
  };
  const result = validateRealiseLFInstanceSet(witnessedSet(), [relation]);
  assert.equal(result.valid, true, result.errors.join(', '));
  assert.equal(REQUIRED_GRAPH_IDS.has('ADMISSION'), false);
});

test('unwitnessed foreign relation blocks realization', () => {
  const relation = {
    relation_type: 'ACTION_PRODUCED',
    source_jurisdiction: 'ACTION',
    target_jurisdiction: 'EVENT',
    witnessed: false,
  };
  const result = validateRealiseLFInstanceSet(witnessedSet(), [relation]);
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes('CROSS_GRAPH_RELATION_NOT_WITNESSED:ACTION_PRODUCED'));
});
