/**
 * review-reply-state.test.js — storage.js must not lose ownerResponded.
 * Run: node review-reply-state.test.js → "ALL TESTS PASSED (N assertions)".
 *
 * Only the Maps/Search scrape can see whether the owner replied. The
 * server-pull paths in background.js carry the field when the backend knows it,
 * but any payload that omits it must leave the stored value alone.
 *
 * This is the same shape of bug as the star histogram in 1.20.2: a blind
 * store.put() replaces the whole record, so one write that happens not to
 * mention a field silently destroys it. Here the consequence is that an
 * already-answered review reappears on the "Reviews at risk" queue, and the
 * owner is told they ignored a customer they actually replied to.
 *
 * Uses the same in-memory IndexedDB shim as review-snapshot.test.js.
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

/** What a Maps scrape produces (content.js extractIndividualReviews). */
const scraped = (over) => Object.assign({
  externalId: 'r1', rating: 1, text: 'bad', author: 'A',
  isLocalGuide: false, hasPhoto: false, ownerResponded: true,
  reviewedAt: '2026-07-01', reviewedAtISO: '2026-07-01T00:00:00.000Z',
}, over);

/** What the OLD server-pull mapping produced — note: no ownerResponded key. */
const fromServerLegacy = (over) => Object.assign({
  externalId: 'r1', rating: 1, text: 'bad', author: 'A',
  isLocalGuide: false, hasPhoto: false, reviewedAt: '2026-07-01',
}, over);

const one = async (biz) => (await GBPStorage.getReviews(biz))[0];

(async () => {
  // 1. The bug this guards: scrape says "replied", a hydrate that omits the
  //    field follows, and the answer must survive.
  {
    const biz = 'biz-hydrate-after-scrape';
    await GBPStorage.saveReviews(biz, [scraped({ ownerResponded: true })]);
    await GBPStorage.saveReviews(biz, [fromServerLegacy()]);
    eq((await one(biz)).ownerResponded, true,
       'a server write carrying no reply status must not erase a scraped one');
  }

  // 2. It works in the other direction too — an unanswered review stays that way.
  {
    const biz = 'biz-false-survives';
    await GBPStorage.saveReviews(biz, [scraped({ ownerResponded: false })]);
    await GBPStorage.saveReviews(biz, [fromServerLegacy()]);
    eq((await one(biz)).ownerResponded, false, 'false is a value, not an absence');
  }

  // 3. A real update still wins. When the scrape genuinely observes a reply,
  //    the review must leave the at-risk queue.
  {
    const biz = 'biz-real-update';
    await GBPStorage.saveReviews(biz, [scraped({ ownerResponded: false })]);
    await GBPStorage.saveReviews(biz, [scraped({ ownerResponded: true })]);
    eq((await one(biz)).ownerResponded, true, 'a newly observed reply overwrites');
  }

  // 4. Never seen, never invented. A review only ever written by the old server
  //    path must read as unknown, not as unanswered — selectReviewsAtRisk keys
  //    off exactly this distinction.
  {
    const biz = 'biz-never-known';
    await GBPStorage.saveReviews(biz, [fromServerLegacy()]);
    eq((await one(biz)).ownerResponded, undefined,
       'absent stays absent rather than defaulting to false');
  }

  // 5. The backend now sends it, so a hydrate can legitimately set it.
  {
    const biz = 'biz-server-knows';
    await GBPStorage.saveReviews(biz, [fromServerLegacy()]);
    await GBPStorage.saveReviews(biz, [fromServerLegacy({ ownerResponded: true })]);
    eq((await one(biz)).ownerResponded, true, 'a server payload that knows the answer sets it');
  }

  // 6. authorReviewCount gets the same protection.
  {
    const biz = 'biz-author-count';
    await GBPStorage.saveReviews(biz, [scraped({ authorReviewCount: 42 })]);
    await GBPStorage.saveReviews(biz, [fromServerLegacy()]);
    eq((await one(biz)).authorReviewCount, 42, 'reviewer contribution count survives a hydrate');
  }

  // 7. Everything else still round-trips — the merge must not drop normal fields.
  {
    const biz = 'biz-fields';
    await GBPStorage.saveReviews(biz, [scraped({ rating: 2, text: 'meh', author: 'Bob' })]);
    const r = await one(biz);
    eq(r.rating, 2, 'rating');
    eq(r.text, 'meh', 'text');
    eq(r.author, 'Bob', 'author');
    eq(r.businessId, biz, 'businessId');
    eq(r.externalId, 'r1', 'externalId');
    eq(r.reviewedAtISO, '2026-07-01T00:00:00.000Z', 'reviewedAtISO');
  }

  // 8. The ligature scrub from 1.20.3 still applies through the merged path.
  {
    const biz = 'biz-ligature';
    await GBPStorage.saveReviews(biz, [scraped({ author: 'Priya Sharmaopen_in_new' })]);
    eq((await one(biz)).author, 'Priya Sharma', 'icon ligature still stripped on write');
  }

  console.log(`ALL TESTS PASSED (${n} assertions)`);
})().catch(err => { console.error(err.message); process.exit(1); });
