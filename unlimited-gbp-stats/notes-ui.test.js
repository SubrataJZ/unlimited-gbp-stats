/**
 * notes-ui.test.js — where notes land on the Performance chart, and when the
 * "add a note for this month?" prompt is offered. Run: node notes-ui.test.js
 * → "ALL TESTS PASSED (N assertions)".
 */
'use strict';

global.document = { querySelectorAll: () => [], addEventListener: () => {}, getElementById: () => null };
const { notesToMarkers, spikeMonth } = require('./dashboard.js');

let n = 0;
function assert(cond, msg) {
  n++;
  if (!cond) { throw new Error('FAILED #' + n + ': ' + msg); }
}
function eq(a, b, msg) {
  assert(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`);
}

const note = (id, eventDate, title = 'T', emoji = '🎉') => ({ id, eventDate, title, emoji });

// 1. A monthly view: a note lands on its month, whatever day it is dated.
{
  const cells = [
    { year: 2026, month: 5, day: null },
    { year: 2026, month: 6, day: null },
    { year: 2026, month: 7, day: null },
  ];
  const m = notesToMarkers([note('a', '2026-06-18T00:00:00.000Z')], cells);
  eq(m.map(x => [x.index, x.stack, x.note.id]), [[1, 0, 'a']], 'a June note sits on the June point');
}

// 2. A daily view: a note lands on its exact day, not on the month.
{
  const cells = [1, 2, 3, 4, 5].map(d => ({ year: 2025, month: 10, day: d }));
  const m = notesToMarkers([note('p', '2025-10-03T00:00:00.000Z')], cells);
  eq(m.map(x => x.index), [2], 'a note dated 3 October sits on the 3rd, not the 1st');
}

// 3. Two notes on the same point are stacked, not drawn on top of each other.
{
  const cells = [{ year: 2026, month: 7, day: null }];
  const m = notesToMarkers([note('x', '2026-07-01T00:00:00.000Z'), note('y', '2026-07-20T00:00:00.000Z')], cells);
  eq(m.map(x => x.stack), [0, 1], 'the second note on a point is stacked above the first');
}

// 4. A note outside the chart's range is not drawn.
{
  const cells = [{ year: 2026, month: 7, day: null }];
  eq(notesToMarkers([note('z', '2025-01-05T00:00:00.000Z')], cells), [], 'a note outside the range is skipped');
  eq(notesToMarkers(null, cells), [], 'no notes means nothing to draw');
}

// 5. A sharp move with no note yet is offered; the most recent one wins.
{
  const cells = ['Jan', 'Feb', 'Mar', 'Apr'].map((_, i) => ({ year: 2026, month: i + 1, day: null }));
  const s = spikeMonth([1000, 1400, 1450, 1000], cells, [], 30);
  eq(s && s.index, 3, 'April, a 31% drop on March, is offered (the latest spike)');
  eq(s && s.pct, -31, 'and reports the percentage');
}

// 6. A month that already has a note is not offered again.
{
  const cells = [{ year: 2026, month: 1, day: null }, { year: 2026, month: 2, day: null }];
  const withNote = [note('q', '2026-02-10T00:00:00.000Z')];
  eq(spikeMonth([100, 200], cells, withNote, 30), null, 'a spike with a note already on it is not offered');
  eq(spikeMonth([100, 200], cells, [], 30).index, 1, 'the same spike without a note is offered');
}

// 7. A small change is not a spike; a missing month is not compared.
{
  const cells = [{ year: 2026, month: 1, day: null }, { year: 2026, month: 2, day: null }];
  eq(spikeMonth([100, 110], cells, [], 30), null, 'a 10% change is not offered');
  eq(spikeMonth([0, 200], cells, [], 30), null, 'a month after zero is not compared, since the percentage is undefined');
  eq(spikeMonth([100, null], cells, [], 30), null, 'a missing month is not compared');
}

// 8. Daily cells are never offered as a month spike.
{
  const cells = [1, 2].map(d => ({ year: 2026, month: 3, day: d }));
  eq(spikeMonth([100, 900], cells, [], 30), null, 'day-level data does not trigger the month prompt');
}

console.log(`ALL TESTS PASSED (${n} assertions)`);
