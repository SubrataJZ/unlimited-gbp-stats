/**
 * concept-view.test.js — plain Node assertions for the presentation logic of
 * the "What customers talk about" panel. Run: node concept-view.test.js →
 * "ALL TESTS PASSED (N assertions)".
 *
 * The backend decides what the concepts ARE; these functions decide what the
 * owner is told about them, and that is where a wrong answer does damage:
 *
 *   - describeConcept must not print raw window counts. The backend compares
 *     the last 4 months against the preceding 8, so "4 recently vs 8 before"
 *     reads as a collapse when the rate is actually flat. It quotes per-month
 *     rates for exactly that reason.
 *   - conceptHeadline picks the single line at the top of the panel. It must
 *     never manufacture urgency when nothing is wrong, and must not let a
 *     one-off complaint outrank a systemic one.
 */
'use strict';

const { describeConcept, conceptHeadline } = require('./dashboard.js');

let n = 0;
function assert(cond, msg) {
  n++;
  if (!cond) { throw new Error('FAILED #' + n + ': ' + msg); }
}
function eq(a, b, msg) {
  assert(a === b, (msg || '') + ' (got ' + JSON.stringify(a) + ', expected ' + JSON.stringify(b) + ')');
}

/** Build a concept row in the shape GET /api/ai/concepts returns. */
function concept(over) {
  return Object.assign({
    label: 'thing',
    kind: 'other',
    mentions: 10,
    positive: 5,
    negative: 3,
    neutral: 2,
    avgRating: 4.0,
    surfaces: [],
    recentMentions: 0,
    priorMentions: 0,
    recentPerMonth: 0,
    priorPerMonth: 0,
    trend: 'steady',
    ratingDelta: null,
  }, over);
}

// 1. Sentiment percentages, and the three parts filling the bar exactly.
{
  const r = describeConcept(concept({ mentions: 10, positive: 5, negative: 3, neutral: 2 }));
  eq(r.posPct, 50, 'positive share');
  eq(r.negPct, 30, 'negative share');
  eq(r.neutralPct, 20, 'neutral share is the remainder');
  eq(r.posPct + r.neutralPct + r.negPct, 100, 'the three bar segments always total 100%');
}

// 2. Rounding must never make the bar overflow its container.
{
  const r = describeConcept(concept({ mentions: 3, positive: 1, negative: 1, neutral: 1 }));
  eq(r.posPct + r.neutralPct + r.negPct, 100, 'thirds still total exactly 100%');
  assert(r.neutralPct >= 0, 'the remainder never goes negative');
}

// 3. The trend sentence quotes RATES, not the unequal raw window counts.
{
  const r = describeConcept(concept({
    trend: 'rising', recentMentions: 8, priorMentions: 6, recentPerMonth: 2, priorPerMonth: 0.75,
  }));
  assert(/0\.75\/mo/.test(r.trendText), 'quotes the prior rate per month');
  assert(/2\/mo/.test(r.trendText), 'and the recent rate per month');
  assert(/^up /.test(r.trendText), 'and says which direction');
  assert(!/\b8\b|\b6\b/.test(r.trendText), 'never prints the raw window counts, which are not comparable');
}

// 4. A brand-new concept is described as new, not as an infinite increase.
{
  const r = describeConcept(concept({
    trend: 'rising', recentMentions: 4, priorMentions: 0, recentPerMonth: 1, priorPerMonth: 0,
  }));
  assert(/newly appearing/.test(r.trendText), 'a concept with no history reads as newly appearing');
  assert(!/Infinity|NaN|%/.test(r.trendText), 'and never shows a division-by-zero artefact');
}

// 5. A concept that stopped being mentioned says so plainly.
{
  const r = describeConcept(concept({
    trend: 'falling', recentMentions: 0, priorMentions: 9, recentPerMonth: 0, priorPerMonth: 1.1,
  }));
  eq(r.trendText, 'no longer mentioned', 'disappearance is stated, not implied by a zero');
}

// 6. A steady concept gets no trend sentence at all — silence over noise.
{
  const r = describeConcept(concept({ trend: 'steady', recentPerMonth: 1, priorPerMonth: 1 }));
  eq(r.trendText, '', 'steady concepts say nothing about trend');
}

// 7. Tone follows the rating, which is the honest signal.
{
  eq(describeConcept(concept({ avgRating: 4.6, positive: 9, negative: 1, mentions: 10 })).tone, 'good',
     'well-rated, rarely criticised');
  eq(describeConcept(concept({ avgRating: 2.4, positive: 1, negative: 8, mentions: 10 })).tone, 'bad',
     'poorly rated');
  eq(describeConcept(concept({ avgRating: 3.8, positive: 4, negative: 3, mentions: 10 })).tone, 'neutral',
     'middling stays neutral rather than being forced into a verdict');

  // A concept can be disliked inside reviews that are otherwise glowing —
  // people love the place and still complain about this one thing. The
  // per-mention sentiment has to be able to overrule a flattering rating,
  // otherwise the one fixable problem hides behind the average.
  eq(describeConcept(concept({ avgRating: 4.5, positive: 2, negative: 7, neutral: 1, mentions: 10 })).tone,
     'bad', 'mostly-negative mentions mark a concept bad even at a high rating');
}

// 8. needsAttention is what promotes a row, and it demands evidence.
{
  eq(describeConcept(concept({ avgRating: 2.0, mentions: 5, negative: 4, positive: 1, neutral: 0 })).needsAttention,
     true, 'a badly rated concept with several mentions needs attention');
  eq(describeConcept(concept({ avgRating: 2.0, mentions: 2, negative: 2, positive: 0, neutral: 0 })).needsAttention,
     false, 'two mentions is not yet a pattern');
  eq(describeConcept(concept({
       avgRating: 3.6, mentions: 6, negative: 4, positive: 1, neutral: 1, trend: 'rising',
       recentPerMonth: 2, priorPerMonth: 0.5,
     })).needsAttention,
     true, 'a rising, mostly-negative concept is flagged even at a middling rating');
}

// 9. Guard rails: no rows, no crash.
{
  eq(describeConcept(null), null, 'null concept');
  eq(describeConcept(concept({ mentions: 0 })), null, 'a concept with no mentions is not describable');
  eq(conceptHeadline([]), null, 'no concepts, no headline');
  eq(conceptHeadline(null), null, 'null list, no headline');
}

// 10. The headline never invents urgency.
{
  const calm = conceptHeadline([
    concept({ label: 'biryani', avgRating: 4.7, mentions: 40, positive: 36, negative: 2, neutral: 2 }),
    concept({ label: 'parking', avgRating: 4.1, mentions: 12, positive: 8, negative: 2, neutral: 2 }),
  ]);
  eq(calm.tone, 'good', 'a healthy profile gets a positive headline');
  assert(/Nothing looks urgent/.test(calm.text), 'and says so plainly');
  assert(/biryani/.test(calm.text), 'crediting the strongest theme');
  assert(/4\.7/.test(calm.text), 'with its actual rating');
}

// 11. When something IS wrong, the systemic problem wins over the loud one-off.
{
  const alarming = conceptHeadline([
    // Small but 100% negative — real, yet only three people.
    concept({ label: 'music', avgRating: 2.0, mentions: 3, positive: 0, negative: 3, neutral: 0 }),
    // Larger and overwhelmingly negative — this is the one to act on.
    concept({ label: 'waiting time', avgRating: 2.2, mentions: 30, positive: 1, negative: 27, neutral: 2,
              trend: 'rising', recentPerMonth: 4, priorPerMonth: 1 }),
  ]);
  eq(alarming.tone, 'bad', 'a real problem gets a negative headline');
  assert(/waiting time/.test(alarming.text), 'the systemic problem leads, not the loudest small one');
  assert(!/^“music/.test(alarming.text), 'the three-mention concept does not take the headline');
  assert(/90%/.test(alarming.text), 'quotes the share that is negative');
  assert(/4\/mo/.test(alarming.text), 'and folds in the trend when there is one');
}

// 12. Cross-script surface forms survive to the UI unchanged — this is the
//     visible proof that the canonical English label is not a guess.
{
  const r = describeConcept(concept({
    label: 'biryani', surfaces: ['বিরিয়ানি', 'बिरयानी', 'biryani'], mentions: 9, positive: 8, negative: 0, neutral: 1,
  }));
  eq(r.label, 'biryani', 'the canonical label is what identifies the row');
  eq(r.surfaces.length, 3, 'and all three spellings are carried through for display');
  assert(r.surfaces.includes('বিরিয়ানি') && r.surfaces.includes('बिरयानी'),
         'in the reviewers\' own scripts');
}

console.log(`ALL TESTS PASSED (${n} assertions)`);
