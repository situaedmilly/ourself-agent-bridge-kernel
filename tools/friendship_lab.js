
import { createClient } from '@supabase/supabase-js';
import { execSync } from 'child_process';

async function getSecretFromKeychain() {
  try {
    const cmd = `security find-generic-password -s "com.openai.codex.supabase-friendshiplab" -a "supabase-friendshiplab" -w`;
    return execSync(cmd, { encoding: 'utf8' }).trim();
  } catch (e) {
    throw new Error('Keychain access failed for FriendshipLab secret');
  }
}

export function formatProfileLookup(queryValue, rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return `Profile not found: ${queryValue}`;
  }
  if (rows.length > 1) {
    const names = rows.map((row) => row?.display_name).filter(Boolean);
    const candidates = names.length ? names.join(', ') : 'multiple matching records';
    return `Ambiguous profile query: ${queryValue}. Matches: ${candidates}. Refine the name.`;
  }
  const profile = rows[0];
  return `Profile Found: ${profile.display_name} (ID: ${profile.id}, Created: ${profile.created_at})`;
}

export async function handleFriendshipQuery(args, dependencies = {}) {
  // Dependency injection is for deterministic unit tests only; production uses
  // the OS keychain and the official Supabase client by default.
  const readSecret = dependencies.getSecretFromKeychain ?? getSecretFromKeychain;
  const makeClient = dependencies.createClient ?? createClient;
  if (typeof args !== 'string' || args.trim().length === 0) {
    return 'Invalid FriendshipLab query: a non-empty query string is required.';
  }
  const [rawAction, ...params] = args.trim().split(/\s+/);
  const action = rawAction.toLowerCase();
  const queryValue = params.join(' ');

  if (!['get', 'graph'].includes(action) || !queryValue) {
    return `Invalid FriendshipLab query. Use 'get <name>' or 'graph <handle>'.`;
  }

  try {
    const secretKey = await readSecret();
    const supabase = makeClient('https://fbhdsnvixylqitjlwafb.supabase.co', secretKey);

    if (action === 'get') {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, display_name, created_at')
        .ilike('display_name', `%${queryValue}%`)
        .limit(2);

      if (error) throw error;
      return formatProfileLookup(queryValue, data);
    }

    if (action === 'graph') {
      const { data, error } = await supabase
        .from('relationship_labels')
        .select('handle, label, note')
        .eq('handle', queryValue)
        .limit(50);

      if (error) throw error;
      if (!data || data.length === 0) return `No graph data for handle: ${queryValue}`;

      return `Graph Labels for ${queryValue}: ${data.map(d => `${d.label} (${d.note})`).join(', ')}`;
    }

    return `Unknown FriendshipLab action: ${action}. Use 'get <name>' or 'graph <handle>'.`;
  } catch (e) {
    // Provider/keychain failures must propagate so the approval route receipts
    // the operation as FAILED instead of reporting an error string as success.
    throw new Error(`FriendshipLab Error: ${e.message}`);
  }
}
