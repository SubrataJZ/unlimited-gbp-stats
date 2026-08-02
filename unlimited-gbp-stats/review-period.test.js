/**
 * review-period.test.js — plain Node assertions for the Reviews-view period-filter math
 * (ReviewPeriod, exported from dashboard.js). Run: node review-period.test.js
 * → prints "ALL TESTS PASSED" on success.
 *
 * Regression guard for the header date picker driving the Reviews tab:
 *   - reviews with no resolvable date must never be silently assigned to a period
 *     or allowed to skew the period average
 *   - a missing prior-year period must show up as "no data", never a fake 0 or a
 *     misleading -100% delta
 *   - selecting the full dated-review range must be detected as a no-op (today's
 *     all-time behaviour), not a "period" with a redundant filtered view
 */
'use strict';

const ReviewPeriod = require('./dashboard.js');

let n = 0;
function assert(cond, msg) {
  n++;
  if (!cond) { throw new Error('FAILED #' + n + ': ' + msg); }
}
function eq(a, b, msg) { assert(a === b, (msg || '') + ' (got ' + JSON.stringify(a) + ', expected ' + JSON.stringify(b) + ')'); }

// ── periodBounds ──────────────────────────────────────────────────────────────

// 1. Single month
eq(ReviewPeriod.periodBounds(2026, 6, 2026, 6).startDate, '2026-06-01', 'single month start');
eq(ReviewPeriod.periodBounds(2026, 6, 2026, 6).endDate, '2026-06-30', 'single month end');

// 2. Multi-month range spanning a year boundary is irrelevant here, but full-year range is
eq(ReviewPeriod.periodBounds(2026, 1, 2026, 12).startDate, '2026-01-01', 'full year start');
eq(ReviewPeriod.periodBounds(2026, 1, 2026, 12).endDate, '2026-12-31', 'full year end');

// 3. Leap-year February vs non-leap February — last-day math must not hardcode 28
eq(ReviewPeriod.periodBounds(2024, 2, 2024, 2).endDate, '2024-02-29', 'leap Feb 2024 end = 29');
eq(ReviewPeriod.periodBounds(2023, 2, 2023, 2).endDate, '2023-02-28', 'non-leap Feb 2023 end = 28');

// ── filterReviewsByPeriod ───────────────────────────────────────────────────────

// 4. Boundary inclusivity: reviews dated exactly on start/end must be included
const boundaryReviews = [
  { rating: 5, reviewedAtISO: '2026-06-01' }, // exactly on startDate
  { rating: 4, reviewedAtISO: '2026-06-30' }, // exactly on endDate
  { rating: 3, reviewedAtISO: '2026-05-31' }, // one day before — excluded
  { rating: 2, reviewedAtISO: '2026-07-01' }, // one day after — excluded
];
const boundaryFiltered = ReviewPeriod.filterReviewsByPeriod(boundaryReviews, '2026-06-01', '2026-06-30');
eq(boundaryFiltered.inPeriod.length, 2, 'boundary dates included, adjacent days excluded');
eq(boundaryFiltered.undated.length, 0, 'no undated reviews in this fixture');

// 5. Undated reviews (empty reviewedAt, unparseable relative string) are NEVER
//    assigned to a period — they must come back separately, not silently dropped
//    into inPeriod and not silently dropped from the result entirely either.
const undatedReviews = [
  { rating: 5, reviewedAtISO: '2026-06-15' },
  { rating: 4, reviewedAt: '' },              // no date at all
  { rating: 3, reviewedAt: 'garbage' },       // unparseable
];
const undatedFiltered = ReviewPeriod.filterReviewsByPeriod(undatedReviews, '2026-06-01', '2026-06-30');
eq(undatedFiltered.inPeriod.length, 1, 'only the dated review counts toward the period');
eq(undatedFiltered.undated.length, 2, 'both undated reviews are reported, not dropped');

// ── averageRating ────────────────────────────────────────────────────────────────

// 6. Normal average
eq(ReviewPeriod.averageRating([{ rating: 5 }, { rating: 4 }, { rating: 3 }]), 4, 'average of 5,4,3 = 4');

// 7. Empty input → null, never a fake 0
eq(ReviewPeriod.averageRating([]), null, 'empty list → null average');

// 8. Out-of-range ratings excluded from the average (defensive against bad scraped data)
eq(ReviewPeriod.averageRating([{ rating: 5 }, { rating: 0 }, { rating: 6 }, { rating: undefined }]), 5,
  'invalid ratings (0, 6, undefined) excluded — only the valid 5 counts');

// ── isFullRangeSelected ──────────────────────────────────────────────────────────

const yearReviews = [
  { rating: 5, reviewedAtISO: '2026-01-10' },
  { rating: 4, reviewedAtISO: '2026-06-15' },
  { rating: 3, reviewedAtISO: '2026-12-20' },
];

// 9. Selecting the full Jan–Dec range that contains every dated review → full range
eq(ReviewPeriod.isFullRangeSelected(yearReviews, 2026, 1, 2026, 12), true,
  'range covering every dated review is a full-range selection');

// 10. Narrowing to just June → not a full range
eq(ReviewPeriod.isFullRangeSelected(yearReviews, 2026, 6, 2026, 6), false,
  'a narrower single-month selection is not a full-range selection');

// 11. No dated reviews at all → treated as full range (nothing to filter)
eq(ReviewPeriod.isFullRangeSelected([{ rating: 5, reviewedAt: 'garbage' }], 2026, 6, 2026, 6), true,
  'nothing dated to filter → full range');

// ── computeSummary ───────────────────────────────────────────────────────────────

// 12. Full scenario: reviews in period, reviews outside period, undated reviews, and a
//     prior-year period with data — verifies count/avg/undated/YoY delta math together.
const summaryReviews = [
  // June 2026 (the selected period): ratings 5, 4, 3 → avg 4.0
  { rating: 5, reviewedAtISO: '2026-06-05' },
  { rating: 4, reviewedAtISO: '2026-06-15' },
  { rating: 3, reviewedAtISO: '2026-06-25' },
  // Outside the period — must not be counted
  { rating: 5, reviewedAtISO: '2026-05-30' },
  { rating: 1, reviewedAtISO: '2026-07-02' },
  // Undated — must not be counted or silently folded into the period
  { rating: 5, reviewedAt: '' },
  { rating: 5, reviewedAt: 'garbage' },
  // June 2025 (prior year, same period): ratings 5, 5 → avg 5.0
  { rating: 5, reviewedAtISO: '2025-06-10' },
  { rating: 5, reviewedAtISO: '2025-06-20' },
];
const summary = ReviewPeriod.computeSummary(summaryReviews, 2026, 6, 2026, 6);

eq(summary.isFullRange, false, 'a single narrow month is not a full-range selection');
eq(summary.count, 3, 'summary count = 3 dated reviews inside June 2026');
eq(summary.avgRating, 4, 'summary avgRating = 4 (5,4,3 averaged)');
eq(summary.undatedCount, 2, 'summary undatedCount = 2, excluded from count/avg');
eq(summary.reviews.length, 3, 'summary.reviews (for the All-reviews list) has exactly the in-period reviews');

eq(summary.priorYear.hasData, true, 'prior-year (June 2025) has data');
eq(summary.priorYear.count, 2, 'prior-year count = 2');
eq(summary.priorYear.avgRating, 5, 'prior-year avgRating = 5');
eq(summary.priorYear.countDelta, 1, 'countDelta = 3 - 2 = +1');
eq(summary.priorYear.avgDelta, -1, 'avgDelta = 4.0 - 5.0 = -1');

// 13. No prior-year data at all → never a fake 0 or a misleading -100%, just nulls
//     and hasData: false so the UI can show a neutral "no prior-year data" state.
const noPriorYearReviews = [
  { rating: 5, reviewedAtISO: '2026-06-05' },
  { rating: 3, reviewedAtISO: '2026-06-20' },
  // nothing at all in 2025
];
const noPriorSummary = ReviewPeriod.computeSummary(noPriorYearReviews, 2026, 6, 2026, 6);
eq(noPriorSummary.count, 2, 'current-period count unaffected by missing prior year');
eq(noPriorSummary.avgRating, 4, 'current-period avg unaffected by missing prior year');
eq(noPriorSummary.priorYear.hasData, false, 'priorYear.hasData = false when nothing exists a year earlier');
eq(noPriorSummary.priorYear.count, null, 'priorYear.count = null, not 0, when there is no data');
eq(noPriorSummary.priorYear.avgRating, null, 'priorYear.avgRating = null when there is no data');
eq(noPriorSummary.priorYear.countDelta, null, 'countDelta = null (not a fake number) with no prior year');
eq(noPriorSummary.priorYear.avgDelta, null, 'avgDelta = null (not a misleading -100%) with no prior year');

// 14. Empty review list entirely → full range (nothing to filter), zero counts, no crash
const emptySummary = ReviewPeriod.computeSummary([], 2026, 6, 2026, 6);
eq(emptySummary.isFullRange, true, 'empty review list is treated as full range');
eq(emptySummary.count, 0, 'empty review list → count 0');
eq(emptySummary.avgRating, null, 'empty review list → avgRating null, not 0');
eq(emptySummary.priorYear.hasData, false, 'empty review list → no prior-year data either');

console.log('ALL TESTS PASSED (' + n + ' assertions)');
