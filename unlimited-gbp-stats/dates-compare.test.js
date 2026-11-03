/**
 * dates-compare.test.js — pairing chosen days for "Pick Dates" compare mode.
 * Run: node dates-compare.test.js → "ALL TESTS PASSED (N assertions)".
 */
'use strict';

global.document = { querySelectorAll: () => [], addEventListener: () => {}, getElementById: () => null };
const { isIsoDay, pairDatePicks, dayValue } = require('./dashboard.js');

let n = 0;
function assert(cond, msg) {
  n++;
  if (!cond) { throw new Error('FAILED #' + n + ': ' + msg); }
}
function eq(a, b, msg) {
  assert(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`);
}

// 1. Dates are accepted only when they are real calendar days.
{
  assert(isIsoDay('2026-10-19') === true, 'a normal day is accepted');
  assert(isIsoDay('2024-02-29') === true, 'leap day 2024 is accepted');
  assert(isIsoDay('2026-02-29') === false, 'a non-leap 29 February is rejected');
  assert(isIsoDay('2026-13-01') === false, 'month 13 is rejected');
  assert(isIsoDay('2026-10-1') === false, 'a day without a leading zero is rejected');
  assert(isIsoDay('') === false, 'an empty box is rejected');
}

// 2. Chosen days are paired in date order, first with first.
{
  const p = pairDatePicks(['2026-10-23', '2026-10-19'], ['2025-10-22', '2025-10-18']);
  eq(p, [
    { current: '2026-10-19', earlier: '2025-10-18' },
    { current: '2026-10-23', earlier: '2025-10-22' },
  ], 'the earliest of each list is paired, then the next');
}

// 3. When the lists differ in length, the extra days pair with nothing.
{
  const p = pairDatePicks(['2026-10-19', '2026-10-20', '2026-10-21'], ['2025-10-18']);
  eq(p, [
    { current: '2026-10-19', earlier: '2025-10-18' },
    { current: '2026-10-20', earlier: null },
    { current: '2026-10-21', earlier: null },
  ], 'a short list is padded with nulls');
  eq(pairDatePicks([], []), [], 'no picks means no pairs');
}

// 4. A day's value is read from the month's daily breakdown.
{
  const metrics = { '2026-10': { daily: [5, 0, 7] } };
  eq(dayValue(metrics, '2026-10-01'), 5, 'day 1 is the first entry');
  eq(dayValue(metrics, '2026-10-03'), 7, 'day 3 is the third entry');
  eq(dayValue(metrics, '2026-09-03'), null, 'a month that was not loaded gives no value');
  eq(dayValue({ '2026-10': { daily: [] } }, '2026-10-01'), null, 'a month with no daily data gives no value');
  eq(dayValue({ '2026-10': { total: 12 } }, '2026-10-01'), null, 'an estimated month (total only) gives no value');
  eq(dayValue({ '2026-10': null }, '2026-10-01'), null, 'a missing month record gives no value');
}

console.log(`ALL TESTS PASSED (${n} assertions)`);
