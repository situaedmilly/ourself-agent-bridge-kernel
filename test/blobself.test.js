Process started with PID 72772 (shell: /bin/zsh)
Initial output:
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { reverseEngineerGitHubBlob, compareLocalFileToBlob } from '../runtime/blobself.js';

test('BlobSELF observes a GitHub file without mutation', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    ok: true,
    status: 200,
    async json() {
      return {
        type: 'file',
        name: 'README.md',
        path: 'README.md',
        sha: 'abc123',
        size: 12,
        html_url: 'https://github.com/situaedmilly/ourself-agent-bridge-kernel/blob/main/README.md',
        download_url: 'https://raw.githubusercontent.com/situaedmilly/ourself-agent-bridge-kernel/main/README.md',
      };
    },
  });
  try {
    const result = await reverseEngineerGitHubBlob({
      owner: 'situaedmilly',
      repo: 'ourself-agent-bridge-kernel',
      path: 'README.md',
      ref: 'main',
    });
    assert.equal(result.ok, true);
    assert.equal(result.class, 'blobself_reverse_engineer');
    assert.equal(result.mutation, false);
    assert.equal(result.execution, false);
    assert.equal(result.blob.sha, 'abc123');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('BlobSELF computes Git blob SHA for a local comparison', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'blobself-'));
  const file = join(dir, 'sample.txt');
  const content = Buffer.from('OURSELF BLOBSELF\n');
  await writeFile(file, content);
  const expected = createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${content.length}\0`), content]))
    .digest('hex');

  const result = await compareLocalFileToBlob(file, expected);
  assert.equal(result.ok, true);
  assert.equal(result.comparison.match, true);
  assert.equal(result.local.git_blob_sha, expected);
});

