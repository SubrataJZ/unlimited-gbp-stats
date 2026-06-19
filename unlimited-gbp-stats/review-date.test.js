/**
 * review-date.test.js — plain Node assertions for the review-date utilities.
 * Run: node review-date.test.js   →  prints "ALL TESTS PASSED" on success.
 *
 * Regression guard for the core bug: the review-rate chart must bucket reviews
 * by their ACTUAL review date, never by the date they were fetched/collected.
 */
'use strict';

const GBPDate = require('./review-date.js');

let n = 0;
function assert(cond, msg) {
  n++;
  if (!cond) { throw new Error('FAILED #' + n + ': ' + msg); }
}
function eq(a, b, msg) { assert(a === b, (msg || '') + ' (got ' + JSON.stringify(a) + ', expected ' + JSON.stringify(b) + ')'); }

// 1. Absolute "Day Month Year" (the format shown in the UI)
eq(GBPDate.parseRelativeReviewDate('7 Feb 2023'), '2023-02-07', 'parse "7 Feb 2023"');

// 2. Another absolute day-month-year
eq(GBPDate.parseRelativeReviewDate('16 Nov 2024'), '2024-11-16', 'parse "16 Nov 2024"');

// 3. Relative "N weeks ago" anchored to a fixed now
const now = new Date('2026-06-19T12:00:00');
const twoWeeks = new Date(now); twoWeeks.setDate(twoWeeks.getDate() - 14);
eq(
  GBPDate.parseRelativeReviewDate('2 weeks ago', now),
  twoWeeks.toISOString().slice(0, 10),
  'parse "2 weeks ago" relative to fixed now'
);

// 3b. "a month ago" and "Feb 2023" (Month Year) also covered
const aMonth = new Date(now); aMonth.setMonth(aMonth.getMonth() - 1);
eq(GBPDate.parseRelativeReviewDate('a month ago', now), aMonth.toISOString().slice(0, 10), 'parse "a month ago"');
eq(GBPDate.parseRelativeReviewDate('Feb 2023'), '2023-02-01', 'parse "Feb 2023"');

// 4. Bucketing keys by REVIEW date, not capture date.
//    Each review's collectedAt is deliberately set to a wildly different time
//    than its reviewedAt — if the bucketer ever used collectedAt, the keys/
//    span below would be wrong.
const reviews = [
  { rating: 5, reviewedAt: '7 Feb 2023',  collectedAt: Date.parse('2026-06-19') },
  { rating: 4, reviewedAt: '20 Feb 2023', collectedAt: Date.parse('2026-06-19') },
  { rating: 5, reviewedAt: '5 Jan 2025',  collectedAt: Date.parse('2026-06-19') },
];
const buckets = GBPDate.bucketReviewsByPeriod(reviews, 'month', now);

// First bucket = the earliest review month; last = the latest review month.
eq(buckets[0].key, '2023-02', 'first bucket is earliest review month');
eq(buckets[buckets.length - 1].key, '2025-01', 'last bucket is latest review month');

// Feb 2023 has two reviews; Jan 2025 has one.
eq(buckets[0].count, 2, 'Feb 2023 count');
eq(buckets[buckets.length - 1].count, 1, 'Jan 2025 count');

// Gap-fill: every month from 2023-02 to 2025-01 inclusive = 24 buckets.
eq(buckets.length, 24, 'gap-filled month span 2023-02..2025-01');

// In-between months are zero-filled.
const mar2023 = buckets.find(b => b.key === '2023-03');
assert(mar2023 && mar2023.count === 0, 'gap month 2023-03 is zero-filled');

// 5. Cumulative is monotonically non-decreasing and ends at total dated reviews.
let prev = -1;
for (const b of buckets) { assert(b.cumulative >= prev, 'cumulative non-decreasing'); prev = b.cumulative; }
eq(buckets[buckets.length - 1].cumulative, 3, 'final cumulative = total dated reviews');

// 6. Empty / undated input → empty array.
eq(GBPDate.bucketReviewsByPeriod([], 'month').length, 0, 'empty input → []');
eq(GBPDate.bucketReviewsByPeriod([{ rating: 5, reviewedAt: 'garbage' }], 'month').length, 0, 'undated input → []');

console.log('ALL TESTS PASSED (' + n + ' assertions)');
