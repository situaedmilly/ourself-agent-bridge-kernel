import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const readJson = async (path) => JSON.parse(await readFile(resolve(root, path), 'utf8'));

test('host-admin request schema and operation catalog have identical bounded operation sets', async () => {
  const schema = await readJson('contracts/host-admin-request.v0.1.schema.json');
  const catalog = await readJson('HOST-ADMIN/host-admin-operation-catalog.v0.1.json');
  const schemaOps = [...schema.properties.operation_id.enum].sort();
  const catalogOps = catalog.operations.map((item) => item.id).sort();
  assert.deepEqual(catalogOps, schemaOps);
  assert.ok(schema.properties.capability.pattern.includes('host\\.admin'));
  for (const operation of catalog.operations) {
    assert.equal(operation.capability, `host.admin.${operation.id}`);
  }
});

test('catalog denies generic command execution and protects SELFSERVER-2', async () => {
  const catalog = await readJson('HOST-ADMIN/host-admin-operation-catalog.v0.1.json');
  assert.equal(catalog.default_decision, 'DENY');
  assert.equal(catalog.shell_execution, false);
  assert.equal(catalog.arbitrary_paths, false);
  assert.equal(catalog.arbitrary_executables, false);
  assert.equal(catalog.prohibited.shell, true);
  assert.equal(catalog.prohibited.sudo_proxy, true);
  assert.equal(catalog.prohibited.selfserver2_mutation, true);
  assert.equal(catalog.host_controls.admission_max_ttl_seconds, 300);
  assert.equal(catalog.host_controls.nonce_single_use, true);
});

test('C10 subject is pinned to the admitted commit, path, and digest', async () => {
  const schema = await readJson('contracts/host-admin-request.v0.1.schema.json');
  assert.ok(schema.required.includes('subject_binding'));
  const binding = schema.properties.subject_binding.properties;
  assert.equal(binding.repository.const, 'situaedmilly/ALTONUMBUSELF');
  assert.equal(binding.branch.const, 'morph-xi/selfmoat-proving');
  assert.equal(binding.commit.const, '3fdde73c099f9b99814d72dc224c638965be27e9');
  assert.equal(binding.path.const, 'evidence/morph-xiii/FINAL-PROOF-001.json');
  assert.equal(binding.sha256.const, '22a4228da535aab04fb653b19f07d71fc81d3305fc9a0db398a2e6acfc717c5f');
});

test('OpenAPI exposes request and read-only status only; no generic execution route', async () => {
  const openapi = await readFile(resolve(root, 'HOST-ADMIN/host-admin.openapi.yaml'), 'utf8');
  assert.match(openapi, /\/portal\/v1\/host-admin\/requests:/);
  assert.match(openapi, /\/portal\/v1\/host-admin\/requests\/\{request_id\}:/);
  assert.doesNotMatch(openapi, /\/shell|\/exec(?:ute)?\b|command_text|arbitrary_argv/i);
});
