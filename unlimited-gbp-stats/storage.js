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
  const DB_VERSION = 2;
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
   * Save a dated review snapshot. One snapshot per business per day —
   * re-running on the same day overwrites that day's row.
   * @param {object} snap { totalReviews, avgRating, stars:{1..5}, capturedOn? }
   */
  async function saveReviewSnapshot(businessId, snap) {
    const { store } = await tx('reviewSnapshots', 'readwrite');
    const capturedOn = snap.capturedOn || todayStr();
    const record = {
      id: `${businessId}_${capturedOn}`,
      businessId,
      capturedOn,
      totalReviews: snap.totalReviews || 0,
      avgRating:    snap.avgRating ?? null,
      stars:        snap.stars || {},
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
        author:       r.author || '',
        isLocalGuide: !!r.isLocalGuide,
        hasPhoto:     !!r.hasPhoto,
        reviewedAt:   r.reviewedAt || '',
        collectedAt:  Date.now(),
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
