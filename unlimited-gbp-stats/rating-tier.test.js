/**
 * rating-tier.test.js — plain Node assertions for the "5★ reviews to next tier"
 * card. Run: node rating-tier.test.js  →  "ALL TESTS PASSED (N assertions)".
 *
 * Regression guard for the rounded-average trap. Google displays a rounded
 * rating, so reconstructing an integer sum from it lands just BELOW the tier:
 * round(4.1 x 4233) = 17355, and 17355 / 4233 = 4.09993. Flooring that gives
 * tier 4.0, and the card advised "+1 5★ review → 4.1" for a profile already
 * showing 4.1 — advice that is both wrong and demoralising in the wrong
 * direction.
 *
 * The exact path (star histogram present) must keep flooring, because there the
 * sum is real and 4.19 genuinely is tier 4.1 with 4.2 still to earn.
 */
'use strict';

const { computeNextTierMetric } = require('./dashboard.js');

let n = 0;
function assert(cond, msg) {
  n++;
  if (!cond) { throw new Error('FAILED #' + n + ': ' + msg); }
}
function eq(a, b, msg) {
  assert(a === b, (msg || '') + ' (got ' + JSON.stringify(a) + ', expected ' + JSON.stringify(b) + ')');
}

// Build a histogram whose exact mean is known.
function hist(counts) {
  const stars = {};
  for (let s = 1; s <= 5; s++) stars[s] = counts[s] || 0;
  const total = Object.values(stars).reduce((a, b) => a + b, 0);
  return { totalReviews: total, stars, avgRating: null };
}

// 1. The reported case: 4,233 reviews displayed at 4.1, no histogram.
{
  const r = computeNextTierMetric({ totalReviews: 4233, avgRating: 4.1, stars: {} });
  assert(r, 'returns a result');
  eq(r.approx, true, 'flagged approximate when only the rounded average is known');
  assert(!/→ 4\.1\b/.test(r.sub), 'must NOT advise climbing to 4.1 from a profile already at 4.1');
  eq(r.sub, '5★ reviews → 4.2 (approx.)', 'targets the next tier up, and says it is approximate');
  eq(r.text, '+530', 'needs 530 more 5★ reviews to reach 4.2');
}

// 2. That figure is actually correct: 530 gets there, 529 does not.
{
  const N = 4233, S = 4.1 * 4233, T = 4.2;
  const avgWith = (x) => (S + 5 * x) / (N + x);
  assert(avgWith(530) >= T, '530 five-star reviews reaches 4.2');
  assert(avgWith(529) < T, '529 does not');
}

// 3. Exact histogram still floors — 4.19 is tier 4.1 with 4.2 to earn.
{
  // 90 x 5★ + 10 x 3★ = 480/100 = 4.80 ... use a sum landing at 4.19:
  // 81 x 5 + 19 x 1 = 405 + 19 = 424 over 100 = 4.24 -> tier 4.2
  const r = computeNextTierMetric(hist({ 5: 81, 1: 19 }));
  eq(r.approx, false, 'histogram path is exact, not approximate');
  eq(r.sub, '5★ reviews → 4.3', 'exact mean 4.24 is tier 4.2, so the target is 4.3');
  assert(!/approx/.test(r.sub), 'exact path must not be labelled approximate');
}

// 4. A profile exactly on a tier boundary must target the NEXT tier, not itself.
{
  const r = computeNextTierMetric(hist({ 5: 42, 4: 58 })); // (210+232)/100 = 4.42
  eq(r.sub, '5★ reviews → 4.5', 'mean 4.42 -> tier 4.4 -> target 4.5');
  const x = parseInt(r.text.slice(1), 10);
  const avgWith = (k) => (442 + 5 * k) / (100 + k);
  assert(avgWith(x) >= 4.5 - 1e-9, 'the advised count actually reaches the target');
  assert(avgWith(x - 1) < 4.5, 'and one fewer does not');
}

// 5. Perfect and near-perfect ratings degrade sanely instead of dividing by zero.
{
  const perfect = computeNextTierMetric(hist({ 5: 50 }));
  eq(perfect.text, '—', 'a perfect 5.0 has no next tier');
  eq(perfect.sub, 'Perfect rating reached', 'and says so');

  const nearly = computeNextTierMetric(hist({ 5: 999, 4: 1 })); // 4.999 -> tier 4.9
  eq(nearly.sub, 'needs all-5★ from here to reach 5.0', '4.9 can only be finished by perfection');
  eq(nearly.text, '∞', 'expressed as unbounded rather than a misleading number');
}

// 6. Missing or unusable input returns null rather than NaN on screen.
{
  eq(computeNextTierMetric(null), null, 'null snapshot');
  eq(computeNextTierMetric({ totalReviews: 0 }), null, 'no reviews');
  eq(computeNextTierMetric({ totalReviews: 10, avgRating: null, stars: {} }), null,
     'no histogram and no average is unanswerable');
}

console.log(`ALL TESTS PASSED (${n} assertions)`);
