/**
 * billing-service.test.ts — plain ts-node assertions for the pure parts of
 * billing.service (plan resolution, code format, expiry stacking). No DB.
 *
 * Run:  npx ts-node tests/billing-service.test.ts   (from backend/)
 *
 * billing.service.ts imports `{ prisma }` from '../index', so — like
 * metrics-intel.test.ts — we stub '../index' in the require cache first, then
 * `require()` the service (never a top-level `import`), so nothing boots the
 * Express app. The functions under test never touch prisma anyway.
 */
'use strict';

import path from 'path';

let n = 0;
function assert(cond: unknown, msg: string): void {
  n++;
  if (!cond) throw new Error(`FAILED #${n}: ${msg}`);
}
function eq(a: unknown, b: unknown, msg: string): void {
  assert(a === b, `${msg} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`);
}

const indexPath = require.resolve(path.join(__dirname, '..', 'src', 'index'));
(require.cache as any)[indexPath] = {
  id: indexPath,
  filename: indexPath,
  loaded: true,
  exports: { prisma: {} },
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  effectivePlan,
  computeNewExpiry,
  generateLicenseCode,
  normalizeCode,
  PLAN_LIMITS,
} = require('../src/services/billing.service');

const NOW = new Date('2026-09-06T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

// ── effectivePlan ──
eq(effectivePlan('FREE', null, NOW), 'FREE', 'free stays free');
eq(effectivePlan('PRO', new Date(NOW.getTime() + 10 * DAY), NOW), 'PRO', 'unexpired PRO is PRO');
eq(effectivePlan('PRO', new Date(NOW.getTime() - 1), NOW), 'FREE', 'expired PRO falls back to FREE');
eq(effectivePlan('AGENCY', null, NOW), 'AGENCY', 'paid plan with no expiry stays active');

// ── computeNewExpiry ──
eq(
  computeNewExpiry('FREE', null, 'PRO', 365, NOW).getTime(),
  NOW.getTime() + 365 * DAY,
  'FREE→PRO starts from now'
);
{
  const cur = new Date(NOW.getTime() + 30 * DAY);
  eq(computeNewExpiry('PRO', cur, 'PRO', 365, NOW).getTime(), cur.getTime() + 365 * DAY, 'PRO+PRO stacks from current expiry');
  eq(computeNewExpiry('PRO', cur, 'AGENCY', 365, NOW).getTime(), cur.getTime() + 365 * DAY, 'upgrade stacks');
}
eq(
  computeNewExpiry('PRO', new Date(NOW.getTime() - 10 * DAY), 'PRO', 365, NOW).getTime(),
  NOW.getTime() + 365 * DAY,
  'expired plan restarts from now'
);
eq(
  computeNewExpiry('AGENCY', new Date(NOW.getTime() + 100 * DAY), 'PRO', 365, NOW).getTime(),
  NOW.getTime() + 365 * DAY,
  'downgrade key does not extend the higher plan'
);

// ── code format ──
{
  const c = generateLicenseCode('PRO');
  assert(/^ZX-PRO-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(c), `code shape: ${c}`);
  assert(!/[ILOU]/.test(c.replace('ZX-PRO-', '')), 'no ambiguous letters in the random part');
  const many = new Set(Array.from({ length: 200 }, () => generateLicenseCode('AGENCY')));
  eq(many.size, 200, '200 generated codes are all unique');
}

// ── normalizeCode ──
eq(normalizeCode('  zx-pro-ab12-cd34-ef56 '), 'ZX-PRO-AB12-CD34-EF56', 'trims, uppercases, strips spaces');
eq(normalizeCode(null), '', 'null → empty');

// ── limits table ──
eq(PLAN_LIMITS.FREE.aiMonthlyUsd, 0, 'FREE has no AI budget of its own (falls back to env cap)');
assert(PLAN_LIMITS.PRO.trackedBusinesses > PLAN_LIMITS.FREE.trackedBusinesses, 'PRO tracks more than FREE');
assert(PLAN_LIMITS.AGENCY.aiMonthlyUsd > PLAN_LIMITS.PRO.aiMonthlyUsd, 'AGENCY AI budget > PRO');

console.log(`ALL TESTS PASSED (${n} assertions)`);
