// Authorized GitHub Actions transport.
// Fixed-origin, fixed-shape transport for the GitHub Actions control membrane.
// It deliberately does not expose generic HTTP to model output.

'use strict';

const GITHUB_API_ORIGIN = 'https://api.github.com';
const GITHUB_API_VERSION = '2026-03-10';
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT']);
const ALLOWED_PATH = /^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/(workflows|permissions|runner-groups|runners)(?:\/[^/]+)*$/;

function assertRequest(request) {
  if (!request || typeof request !== 'object') throw new Error('GitHub transport request must be an object');
  if (!ALLOWED_METHODS.has(request.method)) throw new Error('GitHub transport method is not allowed');
  if (typeof request.path !== 'string' || !ALLOWED_PATH.test(request.path)) throw new Error('GitHub transport path is outside the Actions boundary');
  if (request.body !== undefined && typeof request.body !== 'string') throw new Error('GitHub transport body must be serialized JSON');
  if (request.method === 'GET' && request.body !== undefined) throw new Error('GET transport requests cannot carry a body');
}

export function createGitHubActionsTransport({ token = process.env.GITHUB_TOKEN, fetchImpl = globalThis.fetch } = {}) {
  if (typeof token !== 'string' || token.trim().length === 0) throw new Error('GITHUB_TOKEN is required for GitHub Actions transport');
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');

  return async function authorizedGitHubActionsTransport(request) {
    assertRequest(request);
    const response = await fetchImpl(GITHUB_API_ORIGIN + request.path, {
      method: request.method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: 'Bearer ' + token,
        'x-github-api-version': GITHUB_API_VERSION,
        ...(request.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(request.body !== undefined ? { body: request.body } : {}),
    });

    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }

    if (!response.ok) {
      const error = new Error('GitHub Actions API ' + response.status + ': ' + (data?.message ?? 'request failed'));
      error.status = response.status;
      error.github = data;
      throw error;
    }

    return Object.freeze({ status: response.status, data });
  };
}

export const GITHUB_ACTIONS_TRANSPORT = Object.freeze({
  origin: GITHUB_API_ORIGIN,
  api_version: GITHUB_API_VERSION,
  methods: Object.freeze([...ALLOWED_METHODS]),
});
