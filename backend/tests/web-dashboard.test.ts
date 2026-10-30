/**
 * web-dashboard.test.ts — the web dashboard's data logic, no DB, no browser.
 *
 * Run:  npx ts-node tests/web-dashboard.test.ts   (from backend/)
 *
 * Covers shapeDashboard (server side) and the pure helpers exported by
 * src/templates/app/app.js (client side): month series with gaps, YoY on
 * overlapping months only, and no division by a zero baseline.
 */
'use strict';

import path from 'path';
import { shapeDashboard, RECENT_REVIEWS } from '../src/services/dashboard.service';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ui = require(path.join(__dirname, '..', 'src', 'templates', 'app', 'app.js'));

let n = 0;
function assert(cond: unknown, msg: string): void {
  n++;
  if (!cond) throw new Error(`FAILED #${n}: ${msg}`);
}
function eq(a: unknown, b: unknown, msg: string): void {
  assert(a === b, `${msg} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`);
}

// ── shapeDashboard ──────────────────────────────────────────────────────────
{
  const reviews = Array.from({ length: 12 }, (_, i) => ({
    rating: 5, text: 'x'.repeat(500), authorName: 'A' + i, ownerResponded: i % 2 === 0,
    reviewedAt: new Date(Date.UTC(2026, 0, 1 + i)),
  }));
  const out = shapeDashboard([
    { id: 'c', name: 'Zeta competitor', googlePlaceId: '3', isOwn: false, metrics: [], snapshots: [], reviews: [] },
    { id: 'b', name: 'Beta', googlePlaceId: '2', isOwn: true, metrics: [], snapshots: [], reviews: [] },
    {
      id: 'a', name: 'Alpha', googlePlaceId: '1', isOwn: true,
      metrics: [{ metricType: 'calls', year: 2026, month: 9, total: 59, isDerived: false }],
      snapshots: [
        { capturedOn: '2026-08-01', totalReviews: 20, displayRating: 4.6 },
        { capturedOn: '2026-10-01', totalReviews: 29, displayRating: 5.0 },
      ],
      reviews,
    },
  ]);
  eq(out.map(b => b.id).join(','), 'a,b,c', 'own with data, then own, then competitors');
  eq(out[0].rating, 5.0, 'rating from the newest snapshot');
  eq(out[0].totalReviews, 29, 'review count from the newest snapshot');
  eq(out[0].reviews.length, RECENT_REVIEWS, 'only the newest few reviews are sent');
  eq(out[0].reviews[0].author, 'A11', 'newest review first');
  eq(out[0].reviews[0].text.length, 300, 'review text is trimmed');
  eq(JSON.stringify(out[0].metrics[0]), '["calls",2026,9,59,false]', 'compact metric rows');
  eq(out[1].rating, null, 'no snapshot → no rating, not a crash');
}

// ── client helpers ──────────────────────────────────────────────────────────
{
  const rows = [
    ['overview', 2025, 9, 100, true],   // last year, estimate
    ['overview', 2025, 10, 200, false],
    ['overview', 2026, 9, 150, false],
    ['overview', 2026, 10, 300, false],
    // 2026-08 missing on purpose
    ['overview', 2026, 7, 999, false],  // no 2025-07 baseline
    ['calls', 2026, 11, 5, false],
  ];
  const idx = ui.indexMetrics(rows);
  eq(ui.latestYm(rows, 'overview'), ui.ym(2026, 10), 'latest month per metric, not across metrics');
  eq(ui.latestYm(rows, 'bookings'), null, 'no data → null');

  const s = ui.buildSeries(idx, 'overview', ui.ym(2026, 10), 4); // Jul..Oct 2026
  eq(s.map((p: any) => p.m).join(','), '7,8,9,10', 'consecutive months, gaps included');
  eq(s[1].v, null, 'a missing month is null, not 0');
  eq(s[2].prev, 100, 'same month last year');
  assert(s[2].prevEst === true, 'last year flagged as an estimate');

  const t = ui.compareTotals(s);
  eq(t.total, 999 + 150 + 300, 'period total counts every month present');
  eq(t.now, 450, 'comparison uses only months present in both years');
  eq(t.prev, 300, 'baseline over the same months');
  eq(t.change, 50, '450 vs 300 = +50%');

  eq(ui.pct(10, 0), null, 'no division by a zero baseline');
  eq(ui.pct(null, 10), null, 'no value → no change');
  eq(ui.compareTotals(ui.buildSeries(idx, 'overview', ui.ym(2026, 7), 1)).change, null, 'no overlap → no change shown');
  eq(ui.fromYm(ui.ym(2026, 12)).m, 12, 'December round-trips');
  eq(ui.fromYm(ui.ym(2027, 1)).y, 2027, 'January rolls the year');
}

console.log(`ALL TESTS PASSED (${n} assertions)`);
