// runtime/blobself.js
// BlobSELF REVERSELF v1
// Read-only GitHub blob observation for the authenticated AgentBridge.
// No shell execution, no GitHub mutation, no model execution.

import { createHash } from 'crypto';
import { stat, readFile } from 'fs/promises';

const GITHUB_API = process.env.GITHUB_API_URL || 'https://api.github.com';
const MAX_LOCAL_COMPARE_BYTES = 100 * 1024 * 1024;

function fail(code, message, extra = {}) {
  return { ok: false, error: code, message, ...extra };
}

function validateLocator(input) {
  const owner = String(input?.owner ?? '');
  const repo = String(input?.repo ?? '');
  const path = String(input?.path ?? '');
  const ref = input?.ref == null ? null : String(input.ref);

  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(owner)) return fail('INVALID_OWNER', 'Invalid GitHub owner.');
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(repo)) return fail('INVALID_REPO', 'Invalid GitHub repository.');
  if (!path || path.length > 1000 || path.startsWith('/') || path.includes('..')) {
    return fail('INVALID_PATH', 'Invalid GitHub repository path.');
  }
  if (ref !== null && (ref.length > 255 || /[\r\n]/.test(ref))) {
    return fail('INVALID_REF', 'Invalid GitHub ref.');
  }
  return { ok: true, owner, repo, path, ref };
}

function authHeaders() {
  const headers = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2026-03-10',
    'user-agent': 'OURSELF-BlobSELF/1.0',
  };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
}

async function githubGet(path) {
  const response = await fetch(`${GITHUB_API}${path}`, {
    method: 'GET',
    headers: authHeaders(),
    signal: AbortSignal.timeout(5000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    return fail('GITHUB_HTTP_ERROR', `GitHub returned HTTP ${response.status}.`, {
      status: response.status,
      github: body && typeof body === 'object' ? { message: body.message ?? null, documentation_url: body.documentation_url ?? null } : null,
    });
  }
  return { ok: true, body };
}

export async function reverseEngineerGitHubBlob(input) {
  const loc = validateLocator(input);
  if (!loc.ok) return loc;

  const encodedPath = loc.path.split('/').map(encodeURIComponent).join('/');
  const query = loc.ref ? `?ref=${encodeURIComponent(loc.ref)}` : '';
  const result = await githubGet(`/repos/${encodeURIComponent(loc.owner)}/${encodeURIComponent(loc.repo)}/contents/${encodedPath}${query}`);
  if (!result.ok) return result;

  const body = result.body;
  if (!body || Array.isArray(body) || body.type !== 'file') {
    return fail('NOT_FILE_BLOB', 'GitHub locator did not resolve to a single file.', { observed_type: body?.type ?? null });
  }

  return {
    ok: true,
    class: 'blobself_reverse_engineer',
    analysis_only: true,
    mutation: false,
    execution: false,
    source: 'GITHUB_HTTP',
    locator: {
      owner: loc.owner,
      repo: loc.repo,
      path: loc.path,
      ref: loc.ref,
    },
    blob: {
      sha: body.sha ?? null,
      size: body.size ?? null,
      name: body.name ?? null,
      path: body.path ?? null,
      html_url: body.html_url ?? null,
      download_url: body.download_url ?? null,
    },
    evidence: {
      github_blob_observed: Boolean(body.sha),
      content_observed: false,
      content_limit_bytes: MAX_LOCAL_COMPARE_BYTES,
    },
    non_actions: [
      'No GitHub write performed',
      'No local file written',
      'No shell executed',
      'No model execution',
    ],
  };
}

export async function compareLocalFileToBlob(localPath, blobSha) {
  if (!localPath || !blobSha) return fail('INVALID_COMPARISON', 'localPath and blobSha are required.');
  const info = await stat(localPath).catch(() => null);
  if (!info?.isFile()) return fail('LOCAL_FILE_NOT_FOUND', 'Local comparison target is not a file.');
  if (info.size > MAX_LOCAL_COMPARE_BYTES) {
    return fail('LOCAL_COMPARE_TOO_LARGE', `Local comparison is capped at ${MAX_LOCAL_COMPARE_BYTES} bytes.`);
  }
  const content = await readFile(localPath);
  const gitHeader = Buffer.from(`blob ${content.length}\\0`);
  const localGitBlobSha = createHash('sha1').update(Buffer.concat([gitHeader, content])).digest('hex');
  return {
    ok: true,
    local: { path: localPath, size: content.length, git_blob_sha: localGitBlobSha },
    comparison: {
      expected_git_blob_sha: blobSha,
      match: localGitBlobSha === blobSha,
    },
  };
}
