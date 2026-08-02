/**
 * sync-queue.test.js — plain Node assertions for the GBPStorage sync outbox.
 * Run: node sync-queue.test.js  →  "ALL TESTS PASSED (N assertions)".
 *
 * Regression guard for unbounded queue growth. enqueueSync used to collapse a
 * re-queued push only onto a job with `attempts === 0`, so once a job had
 * failed even once, every later scrape of the same thing APPENDED another job.
 * A user working while uploads fail accumulates dozens of jobs carrying the
 * same logical push — the "76 pending" report — each retried forever.
 *
 * storage.js is a browser IIFE over IndexedDB, so this installs a minimal
 * in-memory `indexedDB` first (same shim shape as review-snapshot.test.js).
 */
'use strict';

function fakeRequest(resultFn) {
  const req = { onsuccess: null, onerror: null, result: undefined };
  setTimeout(() => {
    try {
      req.result = resultFn();
      req.onsuccess?.({ target: req });
    } catch (err) {
      req.error = err;
      req.onerror?.({ target: req });
    }
  }, 0);
  return req;
}

function makeStore() {
  const rows = new Map();
  let autoId = 0;
  return {
    rows,
    get:    (key) => fakeRequest(() => rows.get(key)),
    getAll: ()    => fakeRequest(() => [...rows.values()]),
    delete: (key) => fakeRequest(() => { rows.delete(key); }),
    add:    (val) => fakeRequest(() => {
      const id = ++autoId;
      rows.set(id, JSON.parse(JSON.stringify({ ...val, id })));
      return id;
    }),
    put:    (val) => fakeRequest(() => {
      const id = val.id ?? ++autoId;
      rows.set(id, JSON.parse(JSON.stringify({ ...val, id })));
      return id;
    }),
    index: (name) => ({
      getAll: (q) => fakeRequest(() => [...rows.values()].filter(r => r[name] === q)),
    }),
    createIndex: () => {},
  };
}

const stores = new Map();
const db = {
  objectStoreNames: { contains: (n) => stores.has(n) },
  createObjectStore: (n) => { stores.set(n, makeStore()); return stores.get(n); },
  transaction: (n) => ({ objectStore: () => stores.get(n) || db.createObjectStore(n) }),
};
global.indexedDB = {
  open: () => fakeRequest(() => {
    for (const n of ['businesses', 'metrics', 'reviewSnapshots', 'reviews', 'syncQueue']) {
      if (!stores.has(n)) db.createObjectStore(n);
    }
    return db;
  }),
};

require('./storage.js');
const GBPStorage = globalThis.GBPStorage;

let n = 0;
function assert(cond, msg) {
  n++;
  if (!cond) { throw new Error('FAILED #' + n + ': ' + msg); }
}
function eq(a, b, msg) {
  assert(a === b, (msg || '') + ' (got ' + JSON.stringify(a) + ', expected ' + JSON.stringify(b) + ')');
}

const q = () => stores.get('syncQueue').rows;
const jobsFor = (key) => [...q().values()].filter(j => j.dedupeKey === key);

(async () => {
  // 1. The reported bug: scrape, fail, scrape, fail, ... must stay at ONE job.
  {
    const key = 'intel:111';
    for (let i = 0; i < 76; i++) {
      const id = await GBPStorage.enqueueSync('intel', '111', key, { round: i });
      await GBPStorage.failSyncJob(id, 'HTTP 401');   // server rejecting throughout
    }
    eq(jobsFor(key).length, 1, '76 failed scrape cycles must collapse to one job');
    eq(jobsFor(key)[0].payload.round, 75, 'the surviving job carries the newest payload');
    assert(jobsFor(key)[0].attempts >= 2, 'attempts must keep climbing, not reset each scrape');
  }

  // 2. A fresh scrape re-arms a job that was sitting in a long backoff — the
  //    user asked for this data to go now.
  {
    const key = 'intel:222';
    const id = await GBPStorage.enqueueSync('intel', '222', key, { v: 1 });
    for (let i = 0; i < 5; i++) await GBPStorage.failSyncJob(id, 'offline');
    const backedOff = q().get(id);
    assert(backedOff.nextAttemptAt > Date.now() + 60_000, 'precondition: job is in a long backoff');

    await GBPStorage.enqueueSync('intel', '222', key, { v: 2 });
    const rearmed = q().get(id);
    assert(rearmed.nextAttemptAt <= Date.now() + 1000, 'a new scrape must re-arm the job');
    eq(rearmed.attempts, backedOff.attempts, 'but the attempts ladder is preserved');
    eq(rearmed.payload.v, 2, 'and the payload is the newest');
  }

  // 3. Distinct dedupe keys stay independent — collapsing must not merge
  //    different months, or a full scrape with a partial one.
  {
    await GBPStorage.enqueueSync('metrics', '333', 'metrics:333:calls:2026-6', { m: 6 });
    await GBPStorage.enqueueSync('metrics', '333', 'metrics:333:calls:2026-7', { m: 7 });
    await GBPStorage.enqueueSync('intel',   '333', 'intel:333',                { full: true });
    await GBPStorage.enqueueSync('intel',   '333', 'intel:333:partial',        { partial: true });
    eq(jobsFor('metrics:333:calls:2026-6').length, 1, 'June metrics job');
    eq(jobsFor('metrics:333:calls:2026-7').length, 1, 'July metrics job');
    eq(jobsFor('intel:333').length, 1, 'full intel job');
    eq(jobsFor('intel:333:partial').length, 1, 'partial intel job stays separate from the full one');
    eq(q().get(jobsFor('intel:333')[0].id).payload.full, true, 'a partial batch must not overwrite a queued full scrape');
  }

  // 4. compactSyncQueue heals a queue that is ALREADY bloated (the upgrade path
  //    — enqueueSync alone does nothing for jobs queued by the old build).
  {
    const store = stores.get('syncQueue');
    const key = 'intel:444';
    for (let i = 0; i < 10; i++) {
      await new Promise(r => {
        const req = store.add({
          kind: 'intel', businessId: '444', dedupeKey: key, payload: { round: i },
          attempts: i, lastError: 'HTTP 401', nextAttemptAt: Date.now(), queuedAt: 1000 + i,
        });
        req.onsuccess = r;
      });
    }
    eq(jobsFor(key).length, 10, 'precondition: 10 legacy duplicates');

    const res = await GBPStorage.compactSyncQueue();
    eq(jobsFor(key).length, 1, 'compaction leaves one job per key');
    eq(res.removed, 9, 'and reports how many it removed');
    const survivor = jobsFor(key)[0];
    eq(survivor.payload.round, 9, 'the survivor is the newest payload');
    eq(survivor.attempts, 9, 'and keeps the highest attempts seen, so backoff is not reset');
    eq(survivor.lastError, 'HTTP 401', 'and keeps the last error for the status chip');
  }

  // 5. Compaction is safe to run on a healthy queue and on an empty one.
  {
    const before = q().size;
    const res = await GBPStorage.compactSyncQueue();
    eq(res.removed, 0, 'nothing to remove on an already-compact queue');
    eq(q().size, before, 'and no jobs are lost');
  }

  // 6. Queue status reflects the collapsed reality, not the old inflation.
  {
    const status = await GBPStorage.getSyncQueueStatus();
    eq(status.depth, q().size, 'depth matches the real queue');
    assert(status.lastError !== undefined, 'status exposes lastError for the header chip');
  }

  console.log(`ALL TESTS PASSED (${n} assertions)`);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
