/**
 * migrate-business.test.js — folding a business's old id into its canonical
 * id must never throw away real captured data.
 * Run: node migrate-business.test.js → "ALL TESTS PASSED (N assertions)".
 *
 * RecoverEX lost 85 records (440 → 355) when its Search local id was folded
 * into its Maps CID. migrateBusinessData() kept whatever was under the CID and
 * deleted the alias copy — even when the CID copy was only an ESTIMATE derived
 * from Google's YoY % and the alias held the real captured number.
 */
'use strict';

function fakeRequest(resultFn) {
  const req = { onsuccess: null, onerror: null, result: undefined };
  setTimeout(() => {
    try { req.result = resultFn(); req.onsuccess?.({ target: req }); }
    catch (err) { req.error = err; req.onerror?.({ target: req }); }
  }, 0);
  return req;
}
function makeStore() {
  const rows = new Map();
  return {
    get: (k) => fakeRequest(() => rows.get(k)),
    put: (v) => fakeRequest(() => { rows.set(v.id, JSON.parse(JSON.stringify(v))); return v.id; }),
    delete: (k) => fakeRequest(() => { rows.delete(k); }),
    index: (name) => ({ getAll: (q) => fakeRequest(() => [...rows.values()].filter(r => r[name] === q)) }),
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
const S = globalThis.GBPStorage;

let n = 0;
function assert(c, msg) { n++; if (!c) throw new Error('FAILED #' + n + ': ' + msg); }
function eq(a, b, msg) { assert(a === b, `${msg} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`); }

const ALIAS = '12314840327329864086';   // RecoverEX's Search local id
const CID   = '7677681795290275669';    // RecoverEX's Maps CID

(async () => {
  // 1. The reported loss: real captured month under the alias, a YoY-derived
  //    estimate for the same month under the CID. The real one must survive.
  await S.saveMetric(ALIAS, 'overview', 2025, 3, 812, [], 4.5);
  await S.saveMetric(CID,   'overview', 2025, 3, 790, [], null, { derived: true });
  await S.migrateBusinessData(ALIAS, CID);
  let m = await S.getMetric(CID, 'overview', 2025, 3);
  eq(m.total, 812, 'the real captured number replaces the estimate');
  eq(!!m.derived, false, 'and is no longer marked as an estimate');

  // 2. Both real: keep the more complete (higher) total, as hydrate does.
  await S.saveMetric(ALIAS, 'calls', 2025, 4, 40, []);
  await S.saveMetric(CID,   'calls', 2025, 4, 31, []);
  await S.migrateBusinessData(ALIAS, CID);
  eq((await S.getMetric(CID, 'calls', 2025, 4)).total, 40, 'the higher real total wins');

  // 3. The canonical real record is not replaced by a smaller alias copy...
  await S.saveMetric(ALIAS, 'calls', 2025, 5, 10, []);
  await S.saveMetric(CID,   'calls', 2025, 5, 55, []);
  await S.migrateBusinessData(ALIAS, CID);
  eq((await S.getMetric(CID, 'calls', 2025, 5)).total, 55, 'a larger canonical record is kept');

  // 4. ...nor by an alias estimate.
  await S.saveMetric(ALIAS, 'calls', 2025, 6, 99, [], null, { derived: true });
  await S.saveMetric(CID,   'calls', 2025, 6, 20, []);
  await S.migrateBusinessData(ALIAS, CID);
  m = await S.getMetric(CID, 'calls', 2025, 6);
  eq(m.total, 20, 'a real canonical number is never replaced by an estimate');

  // 5. Months only under the alias still move across, and the alias is emptied.
  await S.saveMetric(ALIAS, 'directions', 2021, 1, 7, []);
  await S.migrateBusinessData(ALIAS, CID);
  eq((await S.getMetric(CID, 'directions', 2021, 1)).total, 7, 'alias-only months are moved');
  eq((await S.getAllMetricsForBusiness(ALIAS)).length, 0, 'nothing is left under the alias');

  // 6. Business names. Search pages offered headings like "People also ask"
  //    questions or the rating "5.0(29)"; each capture overwrote the stored
  //    name, so the dashboard listed businesses by those.
  const junk = ['What is the largest Chinese restaurant?', '5', '5.0(29)', 'Google review summary', '', ' '];
  for (const j of junk) assert(S.isJunkBusinessName(j), `"${j}" is recognised as junk`);
  for (const ok of ['RecoverEX - Trusted Data Recovery Kolkata', 'Chowman (Kalyani)', '7-Eleven', 'রিকভারএক্স'])
    assert(!S.isJunkBusinessName(ok), `"${ok}" is a real name`);

  await S.saveBusiness({ id: CID, name: 'RecoverEX - Trusted Data Recovery Kolkata' });
  await S.saveBusiness({ id: CID, name: '5.0(29)' });
  eq((await S.getBusiness(CID)).name, 'RecoverEX - Trusted Data Recovery Kolkata', 'a junk name never overwrites a real one');
  await S.saveBusiness({ id: CID, name: 'RecoverEX Dum Dum' });
  eq((await S.getBusiness(CID)).name, 'RecoverEX Dum Dum', 'a real new name still replaces the old one');
  await S.saveBusiness({ id: 'b-new', name: 'Which is the best Chinese restaurant?' });
  await S.saveBusiness({ id: 'b-new', name: 'Chowman (Kalyani)' });
  eq((await S.getBusiness('b-new')).name, 'Chowman (Kalyani)', 'a stored junk name is repaired by the next real one');

  console.log(`ALL TESTS PASSED (${n} assertions)`);
})().catch(e => { console.error(e.message); process.exit(1); });
