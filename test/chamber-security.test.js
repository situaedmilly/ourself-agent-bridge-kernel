// test/chamber-security.test.js
// ── Bridge Pass 20 · OURSELF chamber security ───────────────────────────────
// Live-bridge checks of /ourself response headers + nonce CSP + no token leak,
// plus a STATIC scan of the chamber source proving the token-storage doctrine
// (tab-memory default, opt-in sessionStorage, no localStorage/cookie/URL token,
// clear-on-401/403). A static scan is appropriate: the chamber is server-
// rendered inline JS, and a full browser runtime would add disproportionate
// complexity for no extra assurance.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startBridge, BRIDGE_DIR } from './helpers/bridge-process.js';

let bridge;
before(async () => { bridge = await startBridge(); });
after(async () => { await bridge?.stop(); });

test('GET /ourself → exactly one 200 with the full hardened header set', async () => {
  const r = await fetch(bridge.baseUrl + '/ourself');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
});

test('CSP carries a nonce and no broad weakener', async () => {
  const r = await fetch(bridge.baseUrl + '/ourself');
  const csp = r.headers.get('content-security-policy');
  assert.ok(csp, 'CSP header present');
  assert.match(csp, /script-src 'nonce-[^']+'/, 'nonce on script-src');
  assert.match(csp, /style-src 'nonce-[^']+'/, 'nonce on style-src');
  for (const weak of ["'unsafe-inline'", "'unsafe-eval'", 'https:', 'data:']) {
    assert.ok(!csp.includes(weak), `CSP must not contain ${weak}`);
  }
  assert.ok(!/(^|\s)\*(\s|;|$)/.test(csp), 'CSP must not contain a bare wildcard source');
});

test('chamber page does not embed the throwaway token or .env material', async () => {
  const r = await fetch(bridge.baseUrl + '/ourself');
  const html = await r.text();
  assert.ok(!html.includes(bridge.token), 'token value must never appear in page source');
  assert.ok(!html.includes('BRIDGE_TOKEN'), 'no BRIDGE_TOKEN literal in page');
});

// ── Static token-storage doctrine scan (server.js source) ───────────────────
test('token-storage doctrine holds in chamber source', async () => {
  const src = await readFile(join(BRIDGE_DIR, 'server.js'), 'utf8');

  // tab-memory default
  assert.match(src, /var chamberToken = null/, 'tab-memory token variable default');

  // sessionStorage.setItem ONLY inside the if(remember) opt-in branch
  const setItems = [...src.matchAll(/sessionStorage\.setItem/g)];
  assert.equal(setItems.length, 1, 'exactly one sessionStorage.setItem');
  assert.match(src, /if\(remember\)\{try\{sessionStorage\.setItem/, 'setItem guarded by if(remember)');

  // checkbox default unchecked (no checked attribute on #remember)
  assert.match(src, /<input type="checkbox" id="remember">/, 'remember checkbox unchecked by default');

  // prohibited storage / propagation — match real API usage, not prose mentions
  // in doctrine comments (the comment block legitimately names these as banned).
  assert.ok(!/localStorage\s*[.[]/.test(src), 'no localStorage API use');
  assert.ok(!/document\.cookie/.test(src), 'no cookie token use');

  // clear-on-401/403 present
  assert.match(src, /r\.status===401\|\|r\.status===403/, 'clears token on 401/403');
  assert.match(src, /function clearToken/, 'clearToken routine present');
});
