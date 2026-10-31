/**
 * cors-origin.test.ts — which origins may call the API. No DB, no server.
 * Run:  npx ts-node tests/cors-origin.test.ts   (from backend/)
 *
 * Regression: a browser POST from the server's own pages (login page, web
 * dashboard) carries Origin: <the server's own address>. The allowlist didn't
 * hold it, so every such POST was rejected with a 500 — email/password login
 * and the dashboard's session refresh never worked in a real browser.
 */
'use strict';

import { isAllowedOrigin } from '../src/utils/cors-origin';

let n = 0;
function assert(cond: unknown, msg: string): void {
  n++;
  if (!cond) throw new Error(`FAILED #${n}: ${msg}`);
}

const SELF = 'https://gbp.zixify.zixai.in';
const EXTRA = ['http://localhost:3000', 'https://zixify.zixai.in'];
const ok = (o: string | undefined) => isAllowedOrigin(o, SELF, EXTRA);

assert(ok(undefined), 'no Origin (curl, server-to-server) is allowed');
assert(ok(SELF), "the server's own origin is allowed");
assert(ok('chrome-extension://mijkelehhdboakkcekamkmcpahnppldh'), 'a real extension id is allowed');
assert(ok('https://zixify.zixai.in'), 'a configured extra origin is allowed');

assert(!ok('https://evil.example'), 'a foreign site is rejected');
assert(!ok('https://gbp.zixify.zixai.in.evil.example'), 'a look-alike suffix is rejected');
assert(!ok('http://gbp.zixify.zixai.in'), 'the same host over http is not the same origin');
assert(!ok('https://gbp.zixify.zixai.in:8443'), 'a different port is not the same origin');
assert(!ok('chrome-extension://evil.com'), 'a non-extension-id chrome-extension origin is rejected');
assert(!ok('null'), 'the "null" origin is rejected');

console.log(`ALL TESTS PASSED (${n} assertions)`);
