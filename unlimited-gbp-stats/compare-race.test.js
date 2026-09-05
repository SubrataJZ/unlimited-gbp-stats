/**
 * compare-race.test.js — switching the metric tab while Compare is on must
 * never leave the previous tab's comparison data on screen.
 * Run: node compare-race.test.js → "ALL TESTS PASSED (N assertions)".
 *
 * Reported behaviour: with Compare on, switching from Directions to Calls
 * shows the Calls chart's own line correctly, but the comparison (dashed)
 * line keeps showing Directions' numbers — wrong, but it LOOKS like a valid
 * chart, so nothing about it reads as broken. It only self-corrects if the
 * user turns Compare off and back on.
 *
 * Root cause: loadComparePeriodData() fetches the comparison period over the
 * network, while everything else in loadMetricData() is a fast local read.
 * Switching tabs quickly starts a second fetch before the first has resolved,
 * and network responses don't have to arrive in the order they were sent —
 * there was nothing stopping an OLDER call's response from being written
 * after a NEWER call's, silently replacing the correct data with stale data
 * for a tab the user has already left.
 *
 * This file drives loadComparePeriodData() directly, controlling exactly when
 * each of two overlapping fetches resolves, to prove the write from the call
 * that loses the race is discarded rather than applied.
 */
'use strict';

global.document = { querySelectorAll: () => [], addEventListener: () => {} };
global.GBPStorage = {
  METRIC_TYPES: ['overview', 'calls', 'directions'],
  getAvailableMonths: async () => [{ year: 2026, month: 1 }],
  getMetric: async () => null,
  getMetricsForRange: async () => [],
};

// Deferred fetches, keyed by the metricType in the request URL, so the test
// can resolve them in whichever order it wants — exactly like two real
// network responses that don't have to land in send order.
const pendingFetches = new Map();
global.fetch = (url) => {
  const metricType = new URL(url).searchParams.get('metricType');
  return new Promise((resolve) => {
    pendingFetches.set(metricType, () => resolve({
      ok: true,
      json: async () => ({ periods: [{ month: 1, year: 2025, total: 1, yoyPercent: 5, metricType }] }),
    }));
  });
};

const { state, loadComparePeriodData, __setAuthUserForTests } = require('./dashboard.js');
__setAuthUserForTests({ email: 'a@b.com', accessToken: 'tok' }); // routes through fetch, not the local fallback

let n = 0;
function assert(cond, msg) {
  n++;
  if (!cond) { throw new Error('FAILED #' + n + ': ' + msg); }
}
function eq(a, b, msg) {
  assert(a === b, (msg || '') + ' (got ' + JSON.stringify(a) + ', expected ' + JSON.stringify(b) + ')');
}

function resolveFetchFor(metricType) {
  const fn = pendingFetches.get(metricType);
  assert(fn, `a pending fetch for '${metricType}' exists to resolve`);
  fn();
  pendingFetches.delete(metricType);
}

/** Wait until both expected fetches have actually been issued — loadComparePeriodData
 *  reaches fetch() only after a couple of its own internal awaits. */
async function waitForFetches(...metricTypes) {
  for (let i = 0; i < 50 && !metricTypes.every(mt => pendingFetches.has(mt)); i++) {
    await Promise.resolve();
  }
  for (const mt of metricTypes) assert(pendingFetches.has(mt), `fetch for '${mt}' was issued`);
}

Object.assign(state, {
  businessId: 'biz-1',
  startYear: 2026, startMonth: 1, endYear: 2026, endMonth: 1,
  compareEnabled: true,
  compareMode: 'yoy',
});

(async () => {
  // 1. Switch to Directions, start loading its comparison.
  state.metricType = 'directions';
  const directionsCall = loadComparePeriodData();

  // 2. Before it resolves, the user clicks Calls — a second comparison load
  //    starts for the new tab while the first is still in flight.
  state.metricType = 'calls';
  const callsCall = loadComparePeriodData();

  await waitForFetches('directions', 'calls');

  // 3. Calls' response — the one for the tab the user is actually on — wins
  //    the race and arrives first.
  resolveFetchFor('calls');
  await callsCall;
  eq(state.comparePeriodData[0].metricType, 'calls',
     'the tab the user is on gets its own comparison data');

  // 4. Directions' response — older, and for a tab already left — arrives
  //    after. This is the exact moment the bug happened: it used to
  //    overwrite state.comparePeriodData unconditionally.
  resolveFetchFor('directions');
  await directionsCall;
  eq(state.comparePeriodData[0].metricType, 'calls',
     'a slower, superseded response must not overwrite the newer result with stale data');

  // 5. And the reverse order — the still-current call finishing last — must
  //    still win, precisely because it is current, not because of timing luck.
  state.metricType = 'directions';
  const d2 = loadComparePeriodData();
  state.metricType = 'calls';
  const c2 = loadComparePeriodData();
  await waitForFetches('directions', 'calls');

  resolveFetchFor('directions'); // the stale response arrives first this time
  await d2;
  eq(state.comparePeriodData.length, 0,
     'the stale response arriving first must not be allowed to write at all — ' +
     "state stays empty (Calls' own response has not arrived yet) rather than showing Directions");

  resolveFetchFor('calls');
  await c2;
  eq(state.comparePeriodData[0].metricType, 'calls',
     'the current call still lands its own data regardless of arrival order');

  console.log(`ALL TESTS PASSED (${n} assertions)`);
})().catch(err => { console.error(err.stack || err.message); process.exit(1); });
