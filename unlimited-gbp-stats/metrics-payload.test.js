/**
 * metrics-payload.test.js — plain Node assertions for the metrics payload
 * builder. Run: node metrics-payload.test.js  →  prints "ALL TESTS PASSED".
 *
 * Regression guard for A5's dual-write: the payload sent to
 * POST /api/ingest/metrics must satisfy metrics-ingest.controller.ts exactly
 * (see backend/src/controllers/metrics-ingest.controller.ts).
 */
'use strict';

const { buildMetricsPayload, chunkIntelPayload } = require('./metrics-payload.js');

let n = 0;
function assert(cond, msg) {
  n++;
  if (!cond) { throw new Error('FAILED #' + n + ': ' + msg); }
}
function eq(a, b, msg) {
  assert(a === b, (msg || '') + ' (got ' + JSON.stringify(a) + ', expected ' + JSON.stringify(b) + ')');
}

const business = { id: 123456789, name: 'Test Business' };

// 1. collectedAt epoch ms → matching ISO string, not a number.
{
  const ts = 1700000000000;
  const payload = buildMetricsPayload(business, [
    { businessId: business.id, metricType: 'calls', year: 2023, month: 11, total: 10, collectedAt: ts },
  ]);
  const m = payload.businesses[0].metrics[0];
  eq(typeof m.collectedAt, 'string', 'collectedAt must be a string');
  eq(m.collectedAt, new Date(ts).toISOString(), 'collectedAt must be the matching ISO string');
}

// 2a. collectedAt absent → field omitted entirely.
{
  const payload = buildMetricsPayload(business, [
    { businessId: business.id, metricType: 'calls', year: 2023, month: 11, total: 10 },
  ]);
  const m = payload.businesses[0].metrics[0];
  assert(!('collectedAt' in m), 'collectedAt must be omitted when absent');
}

// 2b. collectedAt === 0 → field omitted entirely (reserved for backfill rows).
{
  const payload = buildMetricsPayload(business, [
    { businessId: business.id, metricType: 'calls', year: 2023, month: 11, total: 10, collectedAt: 0 },
  ]);
  const m = payload.businesses[0].metrics[0];
  assert(!('collectedAt' in m), 'collectedAt must be omitted when 0');
}

// 3. derived: true → isDerived: true.
{
  const payload = buildMetricsPayload(business, [
    { businessId: business.id, metricType: 'calls', year: 2023, month: 11, total: 10, derived: true },
  ]);
  eq(payload.businesses[0].metrics[0].isDerived, true, 'derived:true must map to isDerived:true');
}

// 3b. derived absent → isDerived: false.
{
  const payload = buildMetricsPayload(business, [
    { businessId: business.id, metricType: 'calls', year: 2023, month: 11, total: 10 },
  ]);
  eq(payload.businesses[0].metrics[0].isDerived, false, 'derived absent must map to isDerived:false');
}

// 4. googlePlaceId equals String(business.id).
{
  const payload = buildMetricsPayload(business, []);
  eq(payload.businesses[0].googlePlaceId, String(business.id), 'googlePlaceId must equal String(business.id)');
}

// 5. metricType not in the six accepted → skipped, not emitted.
{
  const payload = buildMetricsPayload(business, [
    { businessId: business.id, metricType: 'views', year: 2023, month: 11, total: 10 },
    { businessId: business.id, metricType: 'calls', year: 2023, month: 11, total: 10 },
  ]);
  eq(payload.businesses[0].metrics.length, 1, 'unknown metricType must be skipped');
  eq(payload.businesses[0].metrics[0].metricType, 'calls', 'only the known metricType must survive');
}

// 6. Empty daily:[] and yoyPercent:null → both keys omitted.
{
  const payload = buildMetricsPayload(business, [
    { businessId: business.id, metricType: 'calls', year: 2023, month: 11, total: 10, daily: [], yoyPercent: null },
  ]);
  const m = payload.businesses[0].metrics[0];
  assert(!('daily' in m), 'empty daily array must be omitted');
  assert(!('yoyPercent' in m), 'null yoyPercent must be omitted');
}

// 6b. Non-empty daily and a finite yoyPercent pass through.
{
  const payload = buildMetricsPayload(business, [
    { businessId: business.id, metricType: 'calls', year: 2023, month: 11, total: 10, daily: [1, 2, 3], yoyPercent: 12.5 },
  ]);
  const m = payload.businesses[0].metrics[0];
  assert(Array.isArray(m.daily) && m.daily.length === 3, 'non-empty daily must pass through');
  eq(m.yoyPercent, 12.5, 'finite yoyPercent must pass through');
}

// 7. breakdown / searchTerms present → passed through unchanged;
//    unknown extra key (profileViews) → not present in the output.
{
  const breakdown = { searchMobile: 5, searchDesktop: 3 };
  const searchTerms = [{ term: 'plumber', count: 4 }];
  const payload = buildMetricsPayload(business, [
    {
      businessId: business.id, metricType: 'overview', year: 2023, month: 11, total: 10,
      breakdown, searchTerms, profileViews: 999, derivedFrom: { year: 2022 },
    },
  ]);
  const m = payload.businesses[0].metrics[0];
  assert(JSON.stringify(m.breakdown) === JSON.stringify(breakdown), 'breakdown must pass through unchanged');
  assert(JSON.stringify(m.searchTerms) === JSON.stringify(searchTerms), 'searchTerms must pass through unchanged');
  assert(!('profileViews' in m), 'unknown extra key profileViews must not be present');
  assert(!('derivedFrom' in m), 'unknown extra key derivedFrom must not be present');
  assert(!('source' in m), 'source must never be sent — A3 does not accept it');
}


// chunkIntelPayload — the server rejects more than 1000 reviews per business
// per request; DC Chinese restaurant had 3100 stored, so its upload 400'd forever.
{
  const reviews = Array.from({ length: 2500 }, (_, i) => ({ externalReviewId: 'r' + i, rating: 5 }));
  const payload = { businesses: [{ name: 'DC', googlePlaceId: '1', isOwn: true, snapshot: { totalReviews: 2500 }, reviews }] };
  const bodies = chunkIntelPayload(payload, 1000);
  eq(bodies.length, 3, '2500 reviews → 3 requests');
  eq(bodies.map(x => x.businesses[0].reviews.length).join(','), '1000,1000,500', 'no request over 1000');
  eq(bodies.reduce((a, x) => a + x.businesses[0].reviews.length, 0), 2500, 'every review is sent once');
  assert(bodies[0].businesses[0].snapshot, 'the first request carries the snapshot');
  assert(!('snapshot' in bodies[1].businesses[0]) && !('snapshot' in bodies[2].businesses[0]), 'later ones do not');
  eq(bodies[2].businesses[0].googlePlaceId, '1', 'every request names the business');
  const noReviews = { businesses: [{ name: 'X', googlePlaceId: '2', snapshot: { totalReviews: 3 } }] };
  assert(chunkIntelPayload(noReviews, 1000)[0] === noReviews, 'a snapshot-only payload is sent as is');
}

console.log('ALL TESTS PASSED (' + n + ' assertions)');
