/**
 * review-snapshot.test.js — plain Node assertions for GBPStorage's review
 * snapshot merge. Run: node review-snapshot.test.js  →  "ALL TESTS PASSED".
 *
 * Regression guard for the star-histogram wipe: saveReviewSnapshot used to
 * `put` a full record, so any writer without a histogram (every server-driven
 * one — the backend has no star column) blanked the breakdown a scrape had just
 * read off Google's page. Since a hydrate now follows EVERY scrape, that made
 * the dashboard's star breakdown empty itself in normal use.
 *
 * storage.js is a browser IIFE over IndexedDB, so this file installs a minimal
 * in-memory `indexedDB` before loading it — enough for the object-store get/put
 * paths these two functions touch.
 */
'use strict';

// ── Minimal in-memory IndexedDB ───────────────────────────────────────────────
// Implements only the surface storage.js uses. Requests resolve on a macrotask
// so the onsuccess handlers storage.js attaches are wired up before they fire.
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
  return {
    rows,
    get:   (key) => fakeRequest(() => rows.get(key)),
    put:   (val) => fakeRequest(() => { rows.set(val.id, JSON.parse(JSON.stringify(val))); return val.id; }),
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
    // Create the stores storage.js expects, then hand back the db.
    for (const n of ['businesses', 'metrics', 'reviewSnapshots', 'reviews', 'syncQueue']) {
      if (!stores.has(n)) db.createObjectStore(n);
    }
    return db;
  }),
};
// storage.js's open() reads e.target.result on BOTH upgradeneeded and success;
// our fake skips upgradeneeded and just returns a ready db from success.

// storage.js has no module.exports — it publishes itself on globalThis for the
// service-worker context, which is exactly the hook we use here.
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
function deepEq(a, b, msg) {
  assert(JSON.stringify(a) === JSON.stringify(b),
    (msg || '') + ' (got ' + JSON.stringify(a) + ', expected ' + JSON.stringify(b) + ')');
}

const DAY = '2026-08-01';
const STARS = { 1: 2, 2: 1, 3: 5, 4: 40, 5: 120 };

(async () => {
  // 1. The reported bug: scrape writes a histogram, hydrate follows with none.
  {
    const biz = 'biz-hydrate-after-scrape';
    await GBPStorage.saveReviewSnapshot(biz, {
      capturedOn: DAY, totalReviews: 168, avgRating: 4.6, stars: STARS,
    });
    // hydrateBusiness / pullReviewsFromServer shape — no `stars` key at all.
    await GBPStorage.saveReviewSnapshot(biz, {
      capturedOn: DAY, totalReviews: 168, avgRating: 4.6,
    });
    const [snap] = await GBPStorage.getReviewSnapshots(biz);
    deepEq(snap.stars, STARS, 'histogram must survive a server write that carries none');
  }

  // 2. An explicitly empty object is "no opinion", not "erase it".
  {
    const biz = 'biz-empty-object';
    await GBPStorage.saveReviewSnapshot(biz, { capturedOn: DAY, stars: STARS });
    await GBPStorage.saveReviewSnapshot(biz, { capturedOn: DAY, stars: {} });
    const [snap] = await GBPStorage.getReviewSnapshots(biz);
    deepEq(snap.stars, STARS, 'stars:{} must not displace a real histogram');
  }

  // 3. A real histogram still overwrites an older one — merge must not freeze it.
  {
    const biz = 'biz-rescrape';
    const NEWER = { 1: 2, 2: 1, 3: 5, 4: 41, 5: 123 };
    await GBPStorage.saveReviewSnapshot(biz, { capturedOn: DAY, stars: STARS });
    await GBPStorage.saveReviewSnapshot(biz, { capturedOn: DAY, stars: NEWER });
    const [snap] = await GBPStorage.getReviewSnapshots(biz);
    deepEq(snap.stars, NEWER, 'a fresh histogram must replace the stored one');
  }

  // 4. avgRating: a server row with neither displayRating nor trueAverage sends
  //    null, which must not blank a rating the scrape read.
  {
    const biz = 'biz-null-rating';
    await GBPStorage.saveReviewSnapshot(biz, { capturedOn: DAY, totalReviews: 168, avgRating: 4.6 });
    await GBPStorage.saveReviewSnapshot(biz, { capturedOn: DAY, totalReviews: 168, avgRating: null });
    const [snap] = await GBPStorage.getReviewSnapshots(biz);
    eq(snap.avgRating, 4.6, 'null avgRating must not erase a stored one');
  }

  // 5. ...but a genuine new rating still lands, including a legitimate 0.
  {
    const biz = 'biz-rating-update';
    await GBPStorage.saveReviewSnapshot(biz, { capturedOn: DAY, avgRating: 4.6 });
    await GBPStorage.saveReviewSnapshot(biz, { capturedOn: DAY, avgRating: 4.2 });
    const [a] = await GBPStorage.getReviewSnapshots(biz);
    eq(a.avgRating, 4.2, 'a new avgRating must overwrite');

    const biz0 = 'biz-total-zero';
    await GBPStorage.saveReviewSnapshot(biz0, { capturedOn: DAY, totalReviews: 5 });
    await GBPStorage.saveReviewSnapshot(biz0, { capturedOn: DAY, totalReviews: 0 });
    const [b] = await GBPStorage.getReviewSnapshots(biz0);
    eq(b.totalReviews, 0, 'an explicit 0 total must be written, not treated as absent');
  }

  // 6. totalReviews absent → keep what is stored (undefined must not become 0).
  {
    const biz = 'biz-total-absent';
    await GBPStorage.saveReviewSnapshot(biz, { capturedOn: DAY, totalReviews: 168 });
    await GBPStorage.saveReviewSnapshot(biz, { capturedOn: DAY, avgRating: 4.6 });
    const [snap] = await GBPStorage.getReviewSnapshots(biz);
    eq(snap.totalReviews, 168, 'absent totalReviews must not zero the stored value');
  }

  // 7. A first write for a day still populates defaults.
  {
    const biz = 'biz-first-write';
    await GBPStorage.saveReviewSnapshot(biz, { capturedOn: DAY });
    const [snap] = await GBPStorage.getReviewSnapshots(biz);
    eq(snap.totalReviews, 0, 'fresh row defaults totalReviews to 0');
    eq(snap.avgRating, null, 'fresh row defaults avgRating to null');
    deepEq(snap.stars, {}, 'fresh row defaults stars to {}');
    eq(snap.id, `${biz}_${DAY}`, 'row id is businessId_capturedOn');
  }

  // 8. Distinct days stay distinct rows — the merge is per-day, not per-business.
  {
    const biz = 'biz-two-days';
    await GBPStorage.saveReviewSnapshot(biz, { capturedOn: '2026-07-31', stars: { 5: 10 } });
    await GBPStorage.saveReviewSnapshot(biz, { capturedOn: DAY, totalReviews: 168 });
    const snaps = await GBPStorage.getReviewSnapshots(biz);
    eq(snaps.length, 2, 'two capture days → two rows');
    deepEq(snaps[0].stars, { 5: 10 }, "yesterday's histogram is untouched by today's write");
    deepEq(snaps[1].stars, {}, 'today\'s row has its own (empty) histogram');
  }

  // 9. Icon-font ligatures are scrubbed on the way into storage, so rows that
  //    arrive from the server already polluted are displayed clean.
  {
    const cases = [
      ['Ankit Roy Chowdhuryopen_in_new', 'Ankit Roy Chowdhury'],
      ['Rantim Banerjeeopen_in_new',     'Rantim Banerjee'],
      ['DR SUVAYAN SAHAopen_in_new',     'DR SUVAYAN SAHA'],
      ['God’s plan are always betteropen_in_new', 'God’s plan are always better'],
      ['Remo Ghoshopen_in_newopen_in_new', 'Remo Ghosh'],   // repeated icon
      ['Nicolas Costar',                 'Nicolas Costar'], // must NOT truncate
      ['Jean_Luc',                       'Jean_Luc'],
      ['',                               ''],
    ];
    for (const [raw, want] of cases) {
      eq(GBPStorage.stripIconLigature(raw), want, `stripIconLigature(${JSON.stringify(raw)})`);
    }

    const biz = 'biz-ligature';
    await GBPStorage.saveReviews(biz, [
      { externalId: 'r1', rating: 5, author: 'Barsha Mallickopen_in_new', text: 'nice' },
    ]);
    const [rev] = await GBPStorage.getReviews(biz);
    eq(rev.author, 'Barsha Mallick', 'saveReviews must store the scrubbed author');
  }

  console.log(`ALL TESTS PASSED (${n} assertions)`);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
