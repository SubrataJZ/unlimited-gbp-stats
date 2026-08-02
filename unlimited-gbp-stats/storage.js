/**
 * Storage Layer - IndexedDB for unlimited historical data
 *
 * Schema:
 *   businesses: { id, name, address, lastUpdated }
 *   metrics:    { id mod businessId_metricType_YYYY-MM, businessId, metricType, year, month, total, daily[], collectedAt }
 *
 * Metric types: overview, calls, chat_clicks, bookings, directions, website_clicks
 */

const GBPStorage = (() => {
  const DB_NAME = 'gbp_unlimited_stats';
  const DB_VERSION = 3;
  let _db = null;

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        // Businesses store
        if (!db.objectStoreNames.contains('businesses')) {
          const bizStore = db.createObjectStore('businesses', { keyPath: 'id' });
          bizStore.createIndex('name', 'name', { unique: false });
        }
        // Metrics store
        if (!db.objectStoreNames.contains('metrics')) {
          const metStore = db.createObjectStore('metrics', { keyPath: 'id' });
          metStore.createIndex('businessId', 'businessId', { unique: false });
          metStore.createIndex('businessMetric', ['businessId', 'metricType'], { unique: false });
          metStore.createIndex('businessMetricDate', ['businessId', 'metricType', 'year', 'month'], { unique: false });
        }
        // ── v2: review snapshots (one per business per capture day) ──
        if (!db.objectStoreNames.contains('reviewSnapshots')) {
          const snapStore = db.createObjectStore('reviewSnapshots', { keyPath: 'id' });
          snapStore.createIndex('businessId', 'businessId', { unique: false });
        }
        // ── v2: individual scraped reviews (idempotent by businessId_externalId) ──
        if (!db.objectStoreNames.contains('reviews')) {
          const revStore = db.createObjectStore('reviews', { keyPath: 'id' });
          revStore.createIndex('businessId', 'businessId', { unique: false });
        }
        // ── v3: durable sync outbox ──
        // Every server push is enqueued here FIRST, then drained by a
        // chrome.alarms worker in background.js. Replaces the old
        // fire-and-forget `.catch(() => {})` pushes, where a push that failed
        // because the token had expired or the machine was offline was lost
        // with no record and no retry — the single largest cause of a business
        // having data locally that never reached the server.
        if (!db.objectStoreNames.contains('syncQueue')) {
          const qStore = db.createObjectStore('syncQueue', { keyPath: 'id', autoIncrement: true });
          qStore.createIndex('nextAttemptAt', 'nextAttemptAt', { unique: false });
          qStore.createIndex('dedupeKey', 'dedupeKey', { unique: false });
        }
      };
      req.onsuccess = (e) => {
        _db = e.target.result;
        resolve(_db);
      };
      req.onerror = (e) => reject(e.target.error);
    });
  }

  function tx(storeName, mode = 'readonly') {
    return open().then(db => {
      const transaction = db.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      return { transaction, store };
    });
  }

  function promisifyRequest(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // ── Business operations ──

  async function saveBusiness(business) {
    const { store } = await tx('businesses', 'readwrite');
    business.lastUpdated = Date.now();
    return promisifyRequest(store.put(business));
  }

  async function getBusiness(id) {
    const { store } = await tx('businesses');
    return promisifyRequest(store.get(id));
  }

  async function getAllBusinesses() {
    const { store } = await tx('businesses');
    return promisifyRequest(store.getAll());
  }

  async function deleteBusiness(id) {
    const { store } = await tx('businesses', 'readwrite');
    return promisifyRequest(store.delete(id));
  }

  // ── Metric operations ──

  function makeMetricId(businessId, metricType, year, month) {
    const mm = String(month).padStart(2, '0');
    return `${businessId}_${metricType}_${year}-${mm}`;
  }

  async function saveMetric(businessId, metricType, year, month, total, daily, yoyPercent = null, extra = {}) {
    const { store } = await tx('metrics', 'readwrite');
    const record = {
      id: makeMetricId(businessId, metricType, year, month),
      businessId,
      metricType,
      year,
      month,
      total,
      daily, // array of numbers, one per day
      yoyPercent,
      ...extra,  // e.g. breakdown:{searchMobile,searchDesktop,mapsMobile,mapsDesktop}, searchTerms:[{term,count}]
      collectedAt: Date.now()
    };
    return promisifyRequest(store.put(record));
  }

  async function getMetric(businessId, metricType, year, month) {
    const { store } = await tx('metrics');
    const id = makeMetricId(businessId, metricType, year, month);
    return promisifyRequest(store.get(id));
  }

  async function getMetricsForRange(businessId, metricType, startYear, startMonth, endYear, endMonth) {
    const { store } = await tx('metrics');
    const results = [];
    // Iterate through months in range
    let y = startYear, m = startMonth;
    while (y < endYear || (y === endYear && m <= endMonth)) {
      const id = makeMetricId(businessId, metricType, y, m);
      const record = await promisifyRequest(store.get(id));
      if (record) results.push(record);
      m++;
      if (m > 12) { m = 1; y++; }
    }
    return results;
  }

  async function getAllMetricsForBusiness(businessId) {
    const { store } = await tx('metrics');
    const index = store.index('businessId');
    return promisifyRequest(index.getAll(businessId));
  }

  async function getAvailableMonths(businessId, metricType) {
    const metrics = await getAllMetricsForBusiness(businessId);
    return metrics
      .filter(m => m.metricType === metricType)
      .map(m => ({ year: m.year, month: m.month, total: m.total }))
      .sort((a, b) => a.year - b.year || a.month - b.month);
  }

  async function getOldestAndNewest(businessId) {
    const metrics = await getAllMetricsForBusiness(businessId);
    if (!metrics.length) return null;
    const sorted = metrics.sort((a, b) => a.year - b.year || a.month - b.month);
    return {
      oldest: { year: sorted[0].year, month: sorted[0].month },
      newest: { year: sorted[sorted.length - 1].year, month: sorted[sorted.length - 1].month }
    };
  }

  // ── Review operations (v2) ──

  function todayStr() {
    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  }

  /**
   * Save a dated review snapshot. One snapshot per business per day — re-running
   * on the same day MERGES into that day's row rather than replacing it.
   *
   * The merge is what keeps the star histogram alive. Only a scrape can read the
   * 1–5 star breakdown, because it is rendered on Google's page and the backend
   * has no column for it; every server-driven write (hydrateBusiness,
   * pullReviewsFromServer) therefore has no `stars` to offer. Under the previous
   * full-replace `put`, the first hydrate after a scrape — which now runs after
   * EVERY scrape — overwrote the freshly-read histogram with `{}`, so the
   * dashboard's star breakdown silently emptied itself. Same story for a null
   * avgRating arriving from a server row that has neither displayRating nor
   * trueAverage.
   *
   * Rule: a field is only written when the incoming snapshot actually carries a
   * value for it. Absent/null/empty means "no opinion", not "set to nothing".
   *
   * @param {object} snap { totalReviews?, avgRating?, stars?:{1..5}, capturedOn? }
   */
  async function saveReviewSnapshot(businessId, snap) {
    const { store } = await tx('reviewSnapshots', 'readwrite');
    const capturedOn = snap.capturedOn || todayStr();
    const id = `${businessId}_${capturedOn}`;
    const existing = (await promisifyRequest(store.get(id))) || null;

    // An empty object carries no histogram — treat it as "not provided" so it
    // can never displace one that was actually read off the page.
    const hasStars = snap.stars && Object.keys(snap.stars).length > 0;

    const record = {
      id,
      businessId,
      capturedOn,
      totalReviews: snap.totalReviews ?? existing?.totalReviews ?? 0,
      avgRating:    snap.avgRating   ?? existing?.avgRating   ?? null,
      stars:        hasStars ? snap.stars : (existing?.stars || {}),
      collectedAt:  Date.now(),
    };
    await promisifyRequest(store.put(record));
    return record;
  }

  async function getReviewSnapshots(businessId) {
    const { store } = await tx('reviewSnapshots');
    const index = store.index('businessId');
    const all = await promisifyRequest(index.getAll(businessId));
    return all.sort((a, b) => (a.capturedOn < b.capturedOn ? -1 : 1));
  }

  // ── Icon-font ligature scrubber ─────────────────────────────────────────────
  // Google renders icons as Material Symbols ligatures, so an "open in new tab"
  // affordance inside a reviewer's name element has the literal textContent
  // "open_in_new" — "Ankit Roy Chowdhury" arrives as
  // "Ankit Roy Chowdhuryopen_in_new".
  //
  // content.js strips these at scrape time, but that only protects NEW scrapes.
  // Rows already stored (and rows arriving from the server, which holds the
  // polluted copy) stay wrong forever. Scrubbing here — on the way INTO local
  // storage — fixes both paths at once, including the hydrate that follows every
  // scrape, so the dashboard heals itself without a backend migration.
  //
  // Matching is by EXACT ligature name. A generic /[a-z]+(?:_[a-z]+)+$/ is wrong:
  // it matches greedily backwards into the name ("Remo Ghoshopen_in_new" →
  // "Remo G"). Every name here contains an underscore, so it cannot collide with
  // a real surname — a bare "star" would truncate "Costar" → "Co".
  const LIGATURES = [
    'open_in_new', 'more_vert', 'more_horiz', 'arrow_outward', 'arrow_forward',
    'arrow_back', 'chevron_right', 'chevron_left', 'expand_more', 'expand_less',
    'photo_camera', 'thumb_up', 'thumb_down', 'content_copy', 'check_circle',
  ];
  const TRAILING_LIGATURE_RE = new RegExp('(?:' + LIGATURES.join('|') + ')+$');

  function stripIconLigature(s) {
    if (!s) return '';
    return String(s).replace(/\s+/g, ' ').trim().replace(TRAILING_LIGATURE_RE, '').trim();
  }

  /**
   * Save an array of individual reviews (idempotent by externalId).
   * @param {Array} reviews [{ externalId, rating, text, author, isLocalGuide, hasPhoto, reviewedAt }]
   */
  async function saveReviews(businessId, reviews) {
    if (!Array.isArray(reviews) || !reviews.length) return 0;
    const { store } = await tx('reviews', 'readwrite');
    let n = 0;
    for (const r of reviews) {
      if (!r || !r.externalId) continue;
      await promisifyRequest(store.put({
        id: `${businessId}_${r.externalId}`,
        businessId,
        externalId:   r.externalId,
        rating:       r.rating || 0,
        text:         r.text || '',
        author:       stripIconLigature(r.author),
        isLocalGuide: !!r.isLocalGuide,
        hasPhoto:     !!r.hasPhoto,
        reviewedAt:    r.reviewedAt || '',
        reviewedAtISO: r.reviewedAtISO || '',
        collectedAt:   Date.now(),
      }));
      n++;
    }
    return n;
  }

  async function getReviews(businessId) {
    const { store } = await tx('reviews');
    const index = store.index('businessId');
    return promisifyRequest(index.getAll(businessId));
  }

  // ── Alias migration ──
  // One business can be discovered under two numeric ids: the GBP local id
  // (performance iframe /local/business/<id>, Search #mpd=~<id>) and the
  // canonical Google CID (place links, data-fid). The backend reconciles these
  // by name+address, but this LOCAL db does not — leaving performance under one
  // business row and reviews under another, so the dashboard shows only one
  // kind of data at a time. When a scrape knows both ids it passes the local id
  // as aliasId and this moves every record to the canonical id.
  async function migrateBusinessData(fromId, toId) {
    if (!fromId || !toId || fromId === toId) return { moved: 0 };
    let moved = 0;

    // Metrics: id embeds businessId_metricType_YYYY-MM — recompute under toId.
    // Never clobber an existing canonical record; alias data is the stale copy.
    {
      const { store } = await tx('metrics', 'readwrite');
      const rows = await promisifyRequest(store.index('businessId').getAll(fromId));
      for (const r of rows) {
        const newId = makeMetricId(toId, r.metricType, r.year, r.month);
        const existing = await promisifyRequest(store.get(newId));
        if (!existing) { await promisifyRequest(store.put({ ...r, id: newId, businessId: toId })); moved++; }
        await promisifyRequest(store.delete(r.id));
      }
    }
    {
      const { store } = await tx('reviewSnapshots', 'readwrite');
      const rows = await promisifyRequest(store.index('businessId').getAll(fromId));
      for (const r of rows) {
        const newId = `${toId}_${r.capturedOn}`;
        const existing = await promisifyRequest(store.get(newId));
        if (!existing) { await promisifyRequest(store.put({ ...r, id: newId, businessId: toId })); moved++; }
        await promisifyRequest(store.delete(r.id));
      }
    }
    {
      const { store } = await tx('reviews', 'readwrite');
      const rows = await promisifyRequest(store.index('businessId').getAll(fromId));
      for (const r of rows) {
        const newId = `${toId}_${r.externalId}`;
        const existing = await promisifyRequest(store.get(newId));
        if (!existing) { await promisifyRequest(store.put({ ...r, id: newId, businessId: toId })); moved++; }
        await promisifyRequest(store.delete(r.id));
      }
    }

    // Business row: keep the canonical one, absorb the alias.
    const fromBiz = await getBusiness(fromId);
    if (fromBiz) {
      const toBiz = await getBusiness(toId);
      if (!toBiz) await saveBusiness({ ...fromBiz, id: toId });
      await deleteBusiness(fromId);
    }
    if (moved) console.log(`[GBPStorage] migrated ${moved} records: ${fromId} → ${toId}`);
    return { moved };
  }

  // ── Sync outbox (v3) ──
  //
  // Durable queue of pushes that still owe the server data. A job is only
  // removed once the server has acknowledged it, so closing the browser mid
  // sync, an expired token, or being offline all end in a retry rather than
  // silent loss. Backoff is exponential and capped — jobs are never dropped,
  // because a dropped job means data that exists only in this browser.

  const BASE_BACKOFF_MS = 30 * 1000;   // first retry after 30s
  const MAX_BACKOFF_MS  = 6 * 60 * 60 * 1000; // never wait longer than 6h

  function backoffFor(attempts) {
    return Math.min(BASE_BACKOFF_MS * Math.pow(2, attempts), MAX_BACKOFF_MS);
  }

  /**
   * Enqueue a push, collapsing onto any job that already owns this dedupeKey.
   *
   * The previous rule only collapsed onto a job with `attempts === 0`, which
   * made the queue grow without bound exactly when it must not. Once a job had
   * failed once — expired token, offline, a rejected payload — every later
   * scrape of the same thing appended ANOTHER job instead of replacing it. A
   * user who keeps working while uploads are failing ends up with dozens of
   * jobs that all carry the same logical push, each retried forever. That is
   * what "76 pending" is: not 76 pieces of unsent data, but one problem
   * multiplied by 76 scrapes.
   *
   * Collapsing is safe for every kind currently queued, because each dedupeKey
   * addresses one logical record and the newest payload supersedes the older:
   *   - metrics -> key is business+metricType+year-month, payload is that one
   *     metric, newest wins.
   *   - intel (full) -> payload is the complete scrape, a superset.
   *   - intel (partial) -> payload is "reviews the SERVER does not have". If an
   *     earlier partial never landed, the server still lacks those reviews, so
   *     the next incremental scrape re-collects them and its payload is again a
   *     superset.
   *
   * `attempts` is carried over rather than reset, so a persistently failing
   * push keeps climbing its backoff ladder instead of restarting at 30s on
   * every scrape. `nextAttemptAt` IS reset: a fresh scrape is a deliberate user
   * action, and making them wait out a 6-hour backoff to find out whether it
   * works now is worse than spending one request.
   *
   * @param {string} kind        'metrics' | 'intel'
   * @param {string} businessId  Local business id the job belongs to.
   * @param {string} dedupeKey   Stable key for this logical push.
   * @param {object} payload     Body handed to the sender in background.js.
   */
  async function enqueueSync(kind, businessId, dedupeKey, payload) {
    const { store } = await tx('syncQueue', 'readwrite');
    const existing = await promisifyRequest(store.index('dedupeKey').getAll(dedupeKey));

    if (existing.length) {
      // Keep the oldest so queue order (and its place in the backoff ladder) is
      // preserved; fold the newest payload onto it and drop the duplicates.
      const sorted = existing.sort((a, b) => (a.queuedAt || 0) - (b.queuedAt || 0));
      const keep = sorted[0];
      for (const dup of sorted.slice(1)) await promisifyRequest(store.delete(dup.id));
      await promisifyRequest(store.put({
        ...keep,
        kind,
        businessId,
        payload,
        queuedAt: Date.now(),
        nextAttemptAt: Date.now(),
      }));
      return keep.id;
    }

    return promisifyRequest(store.add({
      kind,
      businessId,
      dedupeKey,
      payload,
      attempts: 0,
      lastError: null,
      nextAttemptAt: Date.now(),
      queuedAt: Date.now(),
    }));
  }

  /**
   * Collapse pre-existing duplicate jobs down to one per dedupeKey.
   *
   * enqueueSync now prevents duplicates from forming, but that does nothing for
   * queues already bloated by the old rule. Called at the start of every drain
   * so an affected install heals on its own rather than needing the user to
   * discard the queue (which would throw away real unsent data).
   *
   * The surviving job is the NEWEST, since its payload supersedes the others
   * (see enqueueSync), and it keeps the highest attempts count seen for the key
   * so the backoff ladder is not silently reset.
   *
   * @returns {Promise<{removed:number, keys:number}>}
   */
  async function compactSyncQueue() {
    const { store } = await tx('syncQueue', 'readwrite');
    const all = await promisifyRequest(store.getAll());
    const byKey = new Map();
    for (const job of all) {
      const key = job.dedupeKey || `__id:${job.id}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(job);
    }

    let removed = 0;
    for (const [, jobs] of byKey) {
      if (jobs.length < 2) continue;
      jobs.sort((a, b) => (a.queuedAt || 0) - (b.queuedAt || 0));
      const keep = jobs[jobs.length - 1];
      const maxAttempts = Math.max(...jobs.map(j => j.attempts || 0));
      const lastError = jobs.map(j => j.lastError).filter(Boolean).pop() || null;
      for (const dup of jobs.slice(0, -1)) {
        await promisifyRequest(store.delete(dup.id));
        removed++;
      }
      await promisifyRequest(store.put({ ...keep, attempts: maxAttempts, lastError }));
    }
    if (removed) console.log(`[GBPStorage] compacted sync queue: removed ${removed} duplicate job(s)`);
    return { removed, keys: byKey.size };
  }

  /** Jobs whose nextAttemptAt has passed, oldest first. */
  async function getDueSyncJobs(limit = 25) {
    const { store } = await tx('syncQueue');
    const all = await promisifyRequest(store.getAll());
    return all
      .filter(j => (j.nextAttemptAt || 0) <= Date.now())
      .sort((a, b) => (a.queuedAt || 0) - (b.queuedAt || 0))
      .slice(0, limit);
  }

  /** Remove an acknowledged job. */
  async function completeSyncJob(id) {
    const { store } = await tx('syncQueue', 'readwrite');
    return promisifyRequest(store.delete(id));
  }

  /** Record a failure and schedule the next attempt with exponential backoff. */
  async function failSyncJob(id, error) {
    const { store } = await tx('syncQueue', 'readwrite');
    const job = await promisifyRequest(store.get(id));
    if (!job) return null;
    const attempts = (job.attempts || 0) + 1;
    const updated = {
      ...job,
      attempts,
      lastError: String(error || 'unknown').slice(0, 500),
      nextAttemptAt: Date.now() + backoffFor(attempts),
    };
    await promisifyRequest(store.put(updated));
    return updated;
  }

  /**
   * Queue health for the dashboard header. Today the header can read
   * "✓ Up to date" while every push is 401ing; this is what makes it honest.
   */
  async function getSyncQueueStatus() {
    const { store } = await tx('syncQueue');
    const all = await promisifyRequest(store.getAll());
    const failing = all.filter(j => (j.attempts || 0) > 0);
    return {
      depth: all.length,
      failing: failing.length,
      oldestQueuedAt: all.length ? Math.min(...all.map(j => j.queuedAt || 0)) : null,
      lastError: failing.length
        ? failing.sort((a, b) => (b.attempts || 0) - (a.attempts || 0))[0].lastError
        : null,
    };
  }

  /** Drop every queued job. Only for the dashboard's explicit "discard" action. */
  async function clearSyncQueue() {
    const { store } = await tx('syncQueue', 'readwrite');
    return promisifyRequest(store.clear());
  }

  // ── Export / Import for backup ──

  async function exportAll() {
    const businesses = await getAllBusinesses();
    const metrics = await promisifyRequest((await tx('metrics')).store.getAll());
    const reviewSnapshots = await promisifyRequest((await tx('reviewSnapshots')).store.getAll());
    const reviews = await promisifyRequest((await tx('reviews')).store.getAll());
    return { version: DB_VERSION, exportedAt: Date.now(), businesses, metrics, reviewSnapshots, reviews };
  }

  async function importAll(data) {
    if (!data.businesses || !data.metrics) throw new Error('Invalid import data');
    for (const biz of data.businesses) {
      await saveBusiness(biz);
    }
    const { store } = await tx('metrics', 'readwrite');
    for (const metric of data.metrics) {
      await promisifyRequest(store.put(metric));
    }
    // v2 stores — optional in older backups
    if (Array.isArray(data.reviewSnapshots)) {
      const { store: s } = await tx('reviewSnapshots', 'readwrite');
      for (const snap of data.reviewSnapshots) await promisifyRequest(s.put(snap));
    }
    if (Array.isArray(data.reviews)) {
      const { store: s } = await tx('reviews', 'readwrite');
      for (const rev of data.reviews) await promisifyRequest(s.put(rev));
    }
  }

  // ── Stats ──

  async function getStats() {
    const businesses = await getAllBusinesses();
    const { store } = await tx('metrics');
    const allMetrics = await promisifyRequest(store.getAll());
    const byBusiness = {};
    for (const m of allMetrics) {
      if (!byBusiness[m.businessId]) byBusiness[m.businessId] = 0;
      byBusiness[m.businessId]++;
    }
    return {
      totalBusinesses: businesses.length,
      totalRecords: allMetrics.length,
      recordsByBusiness: byBusiness
    };
  }

  return {
    open,
    saveBusiness,
    getBusiness,
    getAllBusinesses,
    deleteBusiness,
    saveMetric,
    getMetric,
    getMetricsForRange,
    getAllMetricsForBusiness,
    getAvailableMonths,
    getOldestAndNewest,
    saveReviewSnapshot,
    getReviewSnapshots,
    saveReviews,
    getReviews,
    stripIconLigature,
    migrateBusinessData,
    enqueueSync,
    compactSyncQueue,
    getDueSyncJobs,
    completeSyncJob,
    failSyncJob,
    getSyncQueueStatus,
    clearSyncQueue,
    exportAll,
    importAll,
    getStats,
    METRIC_TYPES: ['overview', 'calls', 'chat_clicks', 'bookings', 'directions', 'website_clicks'],
    METRIC_LABELS: {
      overview: 'Overview',
      calls: 'Calls',
      chat_clicks: 'Chat clicks',
      bookings: 'Bookings',
      directions: 'Directions',
      website_clicks: 'Website clicks'
    },
    METRIC_DESCRIPTIONS: {
      overview: 'Business Profile interactions',
      calls: 'Calls made from your Business Profile',
      chat_clicks: 'Chat clicks made from your Business Profile',
      bookings: 'Bookings made from your Business Profile',
      directions: 'Direction requests from your Business Profile',
      website_clicks: 'Website clicks from your Business Profile'
    }
  };
})();

// Make available globally in all contexts (content scripts, extension pages, and service workers)
if (typeof window !== 'undefined') {
  window.GBPStorage = GBPStorage;
} else if (typeof globalThis !== 'undefined') {
  // Service worker context (no window, but has globalThis)
  globalThis.GBPStorage = GBPStorage;
}
