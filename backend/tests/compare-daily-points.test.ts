/**
 * compare-daily-points.test.ts — Compare and reports read day-by-day values
 * from stored months, and never count days that have not happened yet.
 * Run: npx ts-node tests/compare-daily-points.test.ts → "ALL TESTS PASSED (N assertions)".
 */
import { flattenDaily, MonthRow } from '../src/utils/daily-points';

let n = 0;
function assert(cond: boolean, msg: string) {
  n++;
  if (!cond) throw new Error('FAILED #' + n + ': ' + msg);
}

const row = (over: Partial<MonthRow>): MonthRow => ({
  id: 'm1', metricType: 'overview', year: 2026, month: 10, total: 0,
  daily: null, collectedAt: null, createdAt: new Date(0), ...over,
});

const PLACE = 'place-1';
const oct = row({ daily: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200, 210, 220, 230, 240, 250, 260, 270, 280, 290, 300, 310] });

// 1. A whole month, all days in the past: every day comes back in order.
{
  const pts = flattenDaily([oct], PLACE, new Date(2026, 9, 1), new Date(2026, 9, 31), new Date(2026, 11, 1));
  assert(pts.length === 31, 'full past month returns 31 days');
  assert(pts[0].value === 10 && pts[30].value === 310, 'values in day order');
  assert(pts[0].date.getDate() === 1 && pts[30].date.getDate() === 31, 'dates line up with days');
}

// 2. Partial month: only days up to today count. Today is 10 Oct.
{
  const pts = flattenDaily([oct], PLACE, new Date(2026, 9, 1), new Date(2026, 9, 31), new Date(2026, 9, 10));
  assert(pts.length === 10, 'partial month keeps only the 10 days so far');
  assert(pts[pts.length - 1].date.getDate() === 10, 'last point is today, not later');
}

// 3. Range inside a month: start and end are inclusive.
{
  const pts = flattenDaily([oct], PLACE, new Date(2026, 9, 5), new Date(2026, 9, 7), new Date(2026, 11, 1));
  assert(pts.length === 3, 'inclusive 3-day range');
  assert(pts.map((p) => p.value).join(',') === '50,60,70', 'range values are the right days');
}

// 4. Derived rows have no daily values and add nothing.
{
  const derived = row({ id: 'd1', month: 9, daily: null, total: 500 });
  const pts = flattenDaily([derived], PLACE, new Date(2026, 8, 1), new Date(2026, 8, 30), new Date(2026, 11, 1));
  assert(pts.length === 0, 'derived row with no daily values is skipped');
}

// 5. Months outside the range are ignored, and points carry the place id.
{
  const pts = flattenDaily([oct], PLACE, new Date(2025, 9, 1), new Date(2025, 9, 31), new Date(2026, 11, 1));
  assert(pts.length === 0, 'month outside the range returns nothing');
}
{
  const pts = flattenDaily([oct], PLACE, new Date(2026, 9, 1), new Date(2026, 9, 2), new Date(2026, 11, 1));
  assert(pts.every((p) => p.locationId === PLACE), 'points carry the place id');
}

console.log(`ALL TESTS PASSED (${n} assertions)`);
