import test from 'node:test';
import assert from 'node:assert/strict';
import { formatProfileLookup } from '../tools/friendship_lab.js';

test('profile lookup reports no match without turning it into a provider error', () => {
  assert.equal(formatProfileLookup('NoSuchProfile', []), 'Profile not found: NoSuchProfile');
});

test('profile lookup returns the single matched profile', () => {
  assert.equal(
    formatProfileLookup('Milly', [{ display_name: 'Milly', id: 'profile-1', created_at: '2026-01-01' }]),
    'Profile Found: Milly (ID: profile-1, Created: 2026-01-01)',
  );
});

test('profile lookup reports ambiguity when multiple profiles match', () => {
  assert.equal(
    formatProfileLookup('Founder', [{ display_name: 'Founder One' }, { display_name: 'Founder Two' }]),
    'Ambiguous profile query: Founder. Matches: Founder One, Founder Two. Refine the name.',
  );
});

function fakeSupabase(results, calls) {
  return {
    from(table) {
      calls.push(['from', table]);
      const query = {
        select(fields) { calls.push(['select', fields]); return query; },
        ilike(column, pattern) { calls.push(['ilike', column, pattern]); return query; },
        eq(column, value) { calls.push(['eq', column, value]); return query; },
        limit(value) { calls.push(['limit', value]); return Promise.resolve({ data: results[table] ?? [], error: null }); },
      };
      return query;
    },
  };
}

test('FriendshipLab handler bounds profile fields and returns an ambiguity result for duplicates', async () => {
  const calls = [];
  const result = await (await import('../tools/friendship_lab.js')).handleFriendshipQuery(
    'get Founder',
    {
      getSecretFromKeychain: async () => 'test-only-secret',
      createClient: (_url, key) => {
        assert.equal(key, 'test-only-secret');
        return fakeSupabase({ profiles: [{ display_name: 'Founder One' }, { display_name: 'Founder Two' }] }, calls);
      },
    },
  );
  assert.equal(result, 'Ambiguous profile query: Founder. Matches: Founder One, Founder Two. Refine the name.');
  assert.deepEqual(calls, [
    ['from', 'profiles'],
    ['select', 'id, display_name, created_at'],
    ['ilike', 'display_name', '%Founder%'],
    ['limit', 2],
  ]);
});

test('FriendshipLab handler returns not-found for an empty profile result', async () => {
  const calls = [];
  const { handleFriendshipQuery } = await import('../tools/friendship_lab.js');
  const result = await handleFriendshipQuery('get NoSuchProfile', {
    getSecretFromKeychain: async () => 'test-only-secret',
    createClient: () => fakeSupabase({ profiles: [] }, calls),
  });
  assert.equal(result, 'Profile not found: NoSuchProfile');
});

test('FriendshipLab graph query selects only bounded fields and caps result rows', async () => {
  const calls = [];
  const { handleFriendshipQuery } = await import('../tools/friendship_lab.js');
  const result = await handleFriendshipQuery('graph milly-handle', {
    getSecretFromKeychain: async () => 'test-only-secret',
    createClient: () => fakeSupabase({
      relationship_labels: [{ label: 'founder', note: 'test note' }],
    }, calls),
  });
  assert.equal(result, 'Graph Labels for milly-handle: founder (test note)');
  assert.deepEqual(calls, [
    ['from', 'relationship_labels'],
    ['select', 'handle, label, note'],
    ['eq', 'handle', 'milly-handle'],
    ['limit', 50],
  ]);
});

test('FriendshipLab provider failures propagate so the bridge can receipt FAILED', async () => {
  const { handleFriendshipQuery } = await import('../tools/friendship_lab.js');
  await assert.rejects(
    () => handleFriendshipQuery('get Milly', {
      getSecretFromKeychain: async () => { throw new Error('keychain unavailable'); },
      createClient: () => { throw new Error('must not be called'); },
    }),
    /FriendshipLab Error: keychain unavailable/,
  );
});
