/**
 * reviews-at-risk.test.js — plain Node assertions for the "Reviews at risk"
 * queue. Run: node reviews-at-risk.test.js → "ALL TESTS PASSED (N assertions)".
 *
 * This list makes a claim about the owner's own conduct — "you have not replied
 * to this customer" — so the interesting cases are all about restraint:
 *
 *   - A review whose reply status was never captured must NOT appear. Older
 *     rows predate storage.js keeping the field, and accusing an owner of
 *     ignoring someone on the strength of a field we never read would send them
 *     hunting for a reply that is already there.
 *   - An undated review must not be aged from its scrape date. That would
 *     manufacture urgency out of when the scraper happened to run.
 *   - Ordering is by how long someone has been waiting, because that is the
 *     only thing that makes this a queue rather than a list.
 */
'use strict';

const { selectReviewsAtRisk, AT_RISK_STALE_DAYS } = require('./dashboard.js');

let n = 0;
function assert(cond, msg) {
  n++;
  if (!cond) { throw new Error('FAILED #' + n + ': ' + msg); }
}
function eq(a, b, msg) {
  assert(a === b, (msg || '') + ' (got ' + JSON.stringify(a) + ', expected ' + JSON.stringify(b) + ')');
}

const NOW = new Date('2026-08-06T12:00:00Z');
const daysAgo = (d) => new Date(NOW.getTime() - d * 86400000).toISOString();

function rev(over) {
  return Object.assign({
    externalId: 'x' + Math.random(),
    rating: 1,
    text: 'bad',
    author: 'A',
    ownerResponded: false,
    reviewedAtISO: daysAgo(1),
  }, over);
}

const run = (list) => selectReviewsAtRisk(list, { now: NOW });

// 1. The basic selection.
{
  const r = run([
    rev({ rating: 1 }),
    rev({ rating: 2 }),
    rev({ rating: 3 }),                       // not low-rated
    rev({ rating: 5 }),
    rev({ rating: 1, ownerResponded: true }), // already answered
  ]);
  eq(r.atRisk.length, 2, 'only unanswered 1-2★ reviews are at risk');
  eq(r.lowRatedTotal, 3, 'low-rated total counts the answered one too');
  eq(r.unknown, 0, 'nothing unknown here');
}

// 2. Unknown reply status is reported separately, never as unanswered.
//    This is the whole reason the field is tri-state instead of a boolean.
{
  const r = run([
    rev({ rating: 1, ownerResponded: undefined }),
    rev({ rating: 2 }),
    rev({ rating: 1, ownerResponded: undefined }),
  ]);
  eq(r.atRisk.length, 1, 'only the review we actually observed as unanswered is listed');
  eq(r.unknown, 2, 'the two unknowns are counted, not accused');

  // A row from before the field existed simply has no property at all.
  const legacy = { rating: 1, text: 'old', reviewedAtISO: daysAgo(300) };
  const r2 = run([legacy]);
  eq(r2.atRisk.length, 0, 'a legacy row never appears on the list');
  eq(r2.unknown, 1, 'it is surfaced as unknown instead');
}

// 3. Ordering: longest wait first — that is what makes it a queue.
{
  const r = run([
    rev({ author: 'recent', reviewedAtISO: daysAgo(2) }),
    rev({ author: 'ancient', reviewedAtISO: daysAgo(90) }),
    rev({ author: 'middle', reviewedAtISO: daysAgo(30) }),
  ]);
  eq(r.atRisk[0].review.author, 'ancient', 'longest waiting first');
  eq(r.atRisk[1].review.author, 'middle', 'then the next');
  eq(r.atRisk[2].review.author, 'recent', 'freshest last');
  eq(r.atRisk[0].ageDays, 90, 'age in whole days');
}

// 4. Equal age falls back to severity — a 1★ outranks a 2★.
{
  const r = run([
    rev({ author: 'two', rating: 2, reviewedAtISO: daysAgo(10) }),
    rev({ author: 'one', rating: 1, reviewedAtISO: daysAgo(10) }),
  ]);
  eq(r.atRisk[0].review.author, 'one', 'same wait, worse rating first');
}

// 5. Undated reviews: listed, but never given an invented age or rank.
{
  const r = run([
    rev({ author: 'dated', reviewedAtISO: daysAgo(5) }),
    rev({ author: 'undated', reviewedAtISO: '' }),
  ]);
  eq(r.atRisk.length, 2, 'an undated review still needs answering');
  eq(r.atRisk[0].review.author, 'dated', 'datable reviews rank first');
  eq(r.atRisk[1].ageDays, null, 'and the undated one carries no age');
  eq(r.atRisk[1].stale, false, 'so it is never marked stale on a guess');
}

// 6. Staleness threshold.
{
  const r = run([
    rev({ author: 'fresh', reviewedAtISO: daysAgo(AT_RISK_STALE_DAYS - 1) }),
    rev({ author: 'stale', reviewedAtISO: daysAgo(AT_RISK_STALE_DAYS + 1) }),
    rev({ author: 'exactly', reviewedAtISO: daysAgo(AT_RISK_STALE_DAYS) }),
  ]);
  const by = {};
  r.atRisk.forEach(x => { by[x.review.author] = x; });
  eq(by.fresh.stale, false, 'just inside the window is not stale');
  eq(by.stale.stale, true, 'past the window is stale');
  eq(by.exactly.stale, true, 'the boundary counts as stale');
  eq(r.staleCount, 2, 'stale count matches');
}

// 7. A future-dated review reads as 0 days, never as negative.
{
  const r = run([rev({ reviewedAtISO: new Date(NOW.getTime() + 86400000).toISOString() })]);
  eq(r.atRisk[0].ageDays, 0, 'clock skew cannot produce a negative age');
}

// 8. Garbage in, no crash out.
{
  eq(run([]).atRisk.length, 0, 'empty list');
  eq(run(null).atRisk.length, 0, 'null list');
  eq(run([null, undefined]).atRisk.length, 0, 'null entries are skipped');
  eq(run([rev({ rating: 0 })]).lowRatedTotal, 0, 'rating 0 is missing data, not a 0★ review');
  eq(run([rev({ reviewedAtISO: 'not a date' })]).atRisk[0].ageDays, null,
     'an unparseable date behaves like no date');
}

// 9. maxRating is configurable without changing the semantics.
{
  const list = [rev({ rating: 3 }), rev({ rating: 1 })];
  eq(selectReviewsAtRisk(list, { now: NOW }).atRisk.length, 1, 'default threshold is 2');
  eq(selectReviewsAtRisk(list, { now: NOW, maxRating: 3 }).atRisk.length, 2, 'raising it includes 3★');
}

console.log(`ALL TESTS PASSED (${n} assertions)`);
