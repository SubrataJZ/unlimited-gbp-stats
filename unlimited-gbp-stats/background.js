/**
 * Background Service Worker
 * Acts as the storage bridge between content scripts (web page origin)
 * and extension pages like the dashboard (extension origin).
 *
 * ALL IndexedDB operations must go through here so that both the
 * content script (which saves data) and the dashboard (which reads data)
 * are using the SAME database under the extension origin.
 *
 * Server Sync
 * ───────────
 * Every time data is saved locally it is also pushed to the configured
 * sync server (POST /api/sync). Failures are logged but never break the
 * local save — local storage is always the source of truth.
 */

importScripts('storage.js', 'metrics-payload.js');

// Pre-warm the DB connection on startup
GBPStorage.open().catch(e => console.error('[GBP BG] Storage init error:', e));

// ── Hardcoded server URLs — change these to your deployed servers ────────────
const SERVER_URL        = 'https://gbp.zixify.zixai.in';          // SQLite sync server (metrics)
const BACKEND_URL       = 'https://gbp.zixify.zixai.in/backend';  // TS/Postgres backend (reviews/intel)
const GOOGLE_CLIENT_ID  = '512083455568-3caijv22kvq0g5n2i1oajg3bmergclpb.apps.googleusercontent.com';

// ── Auth helpers ──────────────────────────────────────────────────────────────

/** Get the stored JWT auth token. Returns null if not logged in. */
async function getAuthToken() {
  return new Promise(resolve => {
    chrome.storage.local.get(['gbpAuthToken'], r => resolve(r.gbpAuthToken || null));
  });
}

/** Save token + user info after successful login/register. */
async function saveAuthSession(token, user) {
  return new Promise(resolve => {
    chrome.storage.local.set({ gbpAuthToken: token, gbpUser: user }, resolve);
  });
}

/** Save the timestamp of the most recent pull for a business. */
async function setLastPull(businessId, timestamp) {
  return new Promise(resolve => {
    chrome.storage.local.get(['gbpLastPull'], result => {
      const lastPull = result.gbpLastPull || {};
      lastPull[businessId] = timestamp;
      chrome.storage.local.set({ gbpLastPull: lastPull }, resolve);
    });
  });
}

/**
 * Push one metric record to the sync server.
 * Never throws — failures are logged silently.
 *
 * @param {string}  locationCode  The Google numeric location/business ID.
 * @param {string}  businessName  Human-readable name.
 * @param {object}  metric        The full metric object to push.
 * @returns {Promise<{ok:boolean, status?:string, error?:string}>}
 */
async function syncMetricToServer(locationCode, businessName, metric) {
  const token = await getAuthToken();
  if (!token) return { ok: false, error: 'Not logged in' };

  try {
    const resp = await fetch(`${SERVER_URL}/api/sync`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ locationCode, businessName, metric }),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => resp.statusText);
      console.warn(`[GBP BG] Server sync HTTP ${resp.status}:`, text);
      return { ok: false, error: `HTTP ${resp.status}` };
    }

    const data = await resp.json();
    console.log(`[GBP BG] Server synced → ${data.id} (${data.status})`);
    return { ok: true, status: data.status };

  } catch (err) {
    console.warn('[GBP BG] Server sync failed (offline?):', err.message);
    return { ok: false, error: err.message };
  }
}

/** Read the stored backend ingest key (zx_...). Null if not connected. */
async function getBackendKey() {
  return new Promise(resolve => {
    chrome.storage.local.get(['gbpBackendKey'], r => resolve(r.gbpBackendKey || null));
  });
}

/**
 * Connect this extension to the Postgres backend using the SAME Google access
 * token already obtained for the SQLite login. Exchanges it for a backend JWT,
 * then provisions a per-user zx_ ingest key and stores it. Best-effort.
 */
async function connectBackend(googleAccessToken) {
  try {
    // 1. Google token → backend JWT
    const r1 = await fetch(`${BACKEND_URL}/api/auth/google/extension`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ accessToken: googleAccessToken }),
    });
    if (!r1.ok) return { ok: false, error: `auth HTTP ${r1.status}` };
    const { token } = await r1.json();
    if (!token) return { ok: false, error: 'No backend token returned' };

    // 2. Provision (or look up) the zx_ ingest key
    const r2 = await fetch(`${BACKEND_URL}/api/auth/provision-extension`, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'x-extension-id': chrome.runtime.id },
    });
    if (!r2.ok) return { ok: false, error: `provision HTTP ${r2.status}` };
    const data = await r2.json();

    if (data.apiKey) {
      // First provision — raw key returned exactly once. Persist it.
      await new Promise(res => chrome.storage.local.set({ gbpBackendKey: data.apiKey }, res));
      console.log('[GBP BG] Backend connected — zx_ key stored');
      return { ok: true, key: data.apiKey };
    }

    // alreadyProvisioned but we have no local key (e.g. reinstall): mint a fresh
    // named key so ingestion still works. The old one stays valid but unused.
    const existing = await getBackendKey();
    if (!existing) {
      const r3 = await fetch(`${BACKEND_URL}/api/auth/api-keys`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body:    JSON.stringify({ name: `ext-${chrome.runtime.id}-${Date.now()}` }),
      });
      if (r3.ok) {
        const d3 = await r3.json();
        if (d3.apiKey) {
          await new Promise(res => chrome.storage.local.set({ gbpBackendKey: d3.apiKey }, res));
          console.log('[GBP BG] Backend re-connected — fresh zx_ key stored');
          return { ok: true, key: d3.apiKey };
        }
      }
    }
    return { ok: true, alreadyProvisioned: true };
  } catch (err) {
    console.warn('[GBP BG] Backend connect failed:', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Build the /api/ingest/intel payload from the scraper's neutral review shape.
 * The numeric GBP business id is used as the stable per-org dedup key
 * (googlePlaceId) so review data lines up with the same business the dashboard
 * already tracks via metrics.
 */
function buildIntelPayload(business, snapshot, reviews, isOwn = true) {
  const b = {
    name: business?.name || String(business?.id || 'Unknown'),
    googlePlaceId: String(business?.id || ''),
    isOwn: !!isOwn,
  };
  if (snapshot && (snapshot.totalReviews || snapshot.avgRating != null)) {
    b.snapshot = {
      totalReviews: snapshot.totalReviews || 0,
      // backend field is displayRating; omit when absent
      ...(snapshot.avgRating != null ? { displayRating: snapshot.avgRating } : {}),
      capturedOn: new Date().toISOString(),
    };
  }
  if (Array.isArray(reviews) && reviews.length) {
    b.reviews = reviews
      .filter(r => r && r.externalId && Number.isFinite(r.rating) && r.rating >= 1 && r.rating <= 5)
      .map(r => ({
        externalReviewId: String(r.externalId),
        rating: Math.round(r.rating),
        ...(r.text ? { text: String(r.text).slice(0, 5000) } : {}),
        ...(r.author ? { authorName: String(r.author).slice(0, 200) } : {}),
        isLocalGuide: !!r.isLocalGuide,
        hasPhoto: !!r.hasPhoto,
        // Include parsed ISO date when available; never send the relative string.
        ...(r.reviewedAtISO ? { reviewedAt: String(r.reviewedAtISO) } : {}),
        // Pass through authorReviewCount when it's a finite integer.
        ...(Number.isFinite(r.authorReviewCount) && r.authorReviewCount > 0
          ? { authorReviewCount: Math.round(r.authorReviewCount) } : {}),
        // ownerResponded: always include as a boolean.
        ownerResponded: !!r.ownerResponded,
      }));

    // Compute snapshot aggregates from scraped reviews and merge into snapshot.
    // Only when reviews were actually scraped (non-empty array).
    const withPhotos      = reviews.filter(r => r.hasPhoto).length;
    const localGuides     = reviews.filter(r => r.isLocalGuide).length;
    const contributions   = reviews
      .map(r => r.authorReviewCount)
      .filter(v => Number.isFinite(v) && v > 0);
    const avgContrib = contributions.length
      ? Math.round((contributions.reduce((a, v) => a + v, 0) / contributions.length) * 100) / 100
      : undefined;
    const validRatings = reviews.filter(r => Number.isFinite(r.rating) && r.rating >= 1 && r.rating <= 5);
    const trueAverage = validRatings.length
      ? Math.round((validRatings.reduce((a, r) => a + r.rating, 0) / validRatings.length) * 100) / 100
      : undefined;

    // Ensure we have a snapshot object to merge into (create a minimal one if absent)
    if (!b.snapshot) {
      b.snapshot = {
        totalReviews: validRatings.length,
        capturedOn: new Date().toISOString(),
      };
    }
    b.snapshot.reviewsWithPhotos   = withPhotos;
    b.snapshot.localGuideReviews   = localGuides;
    if (avgContrib !== undefined)  b.snapshot.avgReviewerContribution = avgContrib;
    if (trueAverage !== undefined) b.snapshot.trueAverage = trueAverage;
  }
  return { businesses: [b] };
}

/**
 * Push a review snapshot + individual reviews to the Postgres backend's
 * /api/ingest/intel. Never throws — local storage stays source of truth.
 */
async function syncReviewToBackend(business, snapshot, reviews, isOwn = true) {
  const key = await getBackendKey();
  if (!key) return { ok: false, error: 'Backend not connected — sign in with Google to enable review sync' };

  const payload = buildIntelPayload(business, snapshot, reviews, isOwn);
  const b = payload.businesses[0];
  if (!b.snapshot && !(b.reviews && b.reviews.length)) return { ok: false, error: 'Nothing to sync' };

  try {
    const resp = await fetch(`${BACKEND_URL}/api/ingest/intel`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${key}`,
        'x-extension-id': chrome.runtime.id,
      },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => resp.statusText);
      console.warn(`[GBP BG] Intel sync HTTP ${resp.status}:`, text);
      return { ok: false, error: `HTTP ${resp.status}` };
    }
    const data = await resp.json();
    console.log('[GBP BG] Reviews synced to backend:', data.summary);
    return { ok: true, summary: data.summary };
  } catch (err) {
    console.warn('[GBP BG] Intel sync failed (offline?):', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Pull review snapshots + reviews for all the user's businesses from the
 * backend and merge into local IndexedDB. Keyed by the numeric id stored as
 * googlePlaceId so it maps to the dashboard's businesses.
 */
async function pullReviewsFromServer(businessId) {
  const key = await getBackendKey();
  if (!key) return { success: false, error: 'Backend not connected' };
  try {
    const resp = await fetch(`${BACKEND_URL}/api/ingest/intel`, {
      headers: { 'Authorization': `Bearer ${key}`, 'x-extension-id': chrome.runtime.id },
    });
    if (!resp.ok) return { success: false, error: `HTTP ${resp.status}` };
    const data = await resp.json();

    let snaps = 0, revs = 0;
    for (const b of data.businesses || []) {
      const localId = b.googlePlaceId || b.id;
      if (!localId) continue;
      for (const s of b.snapshots || []) {
        await GBPStorage.saveReviewSnapshot(localId, {
          capturedOn:   (s.capturedOn || '').slice(0, 10),
          totalReviews: s.totalReviews,
          avgRating:    s.displayRating ?? s.trueAverage ?? null,
          stars:        {},
        });
        snaps++;
      }
      const mapped = (b.reviews || []).map(r => ({
        externalId:   r.externalReviewId,
        rating:       r.rating,
        text:         r.text || '',
        author:       r.authorName || '',
        isLocalGuide: !!r.isLocalGuide,
        hasPhoto:     !!r.hasPhoto,
        reviewedAt:   r.reviewedAt ? String(r.reviewedAt).slice(0, 10) : '',
      }));
      if (mapped.length) { await GBPStorage.saveReviews(localId, mapped); revs += mapped.length; }
    }
    return { success: true, snapshots: snaps, reviews: revs };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ── Metrics dual-write to Postgres backend (A5) ────────────────────────────────
//
// Best-effort push of local metric records to POST /api/ingest/metrics,
// ALONGSIDE the existing SQLite sync (syncMetricToServer / pushAllToServer)
// above — this never replaces it. Uses GBPMetricsPayload.buildMetricsPayload
// (unlimited-gbp-stats/metrics-payload.js, loaded via importScripts at the
// top of this file) to build the request body, the same zx_ ingest key as
// syncReviewToBackend, and the same fire-and-forget / never-throw contract.

/**
 * Kill switch: gate every Postgres metrics push on a chrome.storage.local
 * flag, default ON when unset. Extension updates propagate slowly and
 * cannot be hot-fixed — if this push misbehaves in the field, flipping one
 * storage key beats shipping an emergency release.
 * @returns {Promise<boolean>}
 */
async function metricsBackendSyncEnabled() {
  return new Promise(resolve => {
    chrome.storage.local.get(['gbpBackendMetricsSync'], r => resolve(r.gbpBackendMetricsSync !== false));
  });
}

/**
 * Push a business's metric records to the Postgres backend's
 * /api/ingest/metrics. Never throws — local storage stays source of truth,
 * and the existing SQLite sync stays the primary path.
 *
 * @param {{id:*, name?:string}} business
 * @param {Array} metrics  Local metric records (see storage.js saveMetric).
 * @returns {Promise<{ok:boolean, summary?:object, error?:string}>}
 */
async function syncMetricsToBackend(business, metrics) {
  const enabled = await metricsBackendSyncEnabled();
  if (!enabled) return { ok: false, error: 'disabled' };

  const key = await getBackendKey();
  if (!key) return { ok: false, error: 'Backend not connected' };

  if (!Array.isArray(metrics) || !metrics.length) return { ok: false, error: 'Nothing to sync' };

  // Chunk at 500 metrics per request — A3's cap is 1000/business; leave headroom.
  const CHUNK_SIZE = 500;
  let lastSummary;
  try {
    for (let i = 0; i < metrics.length; i += CHUNK_SIZE) {
      const chunk = metrics.slice(i, i + CHUNK_SIZE);
      const payload = GBPMetricsPayload.buildMetricsPayload(business, chunk);
      const b = payload.businesses[0];
      if (!b.metrics.length) continue; // whole chunk was unsupported metricTypes

      const resp = await fetch(`${BACKEND_URL}/api/ingest/metrics`, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${key}`,
          'x-extension-id': chrome.runtime.id,
        },
        body: JSON.stringify(payload),
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => resp.statusText);
        console.warn(`[GBP BG] Metrics backend sync HTTP ${resp.status}:`, text);
        return { ok: false, error: `HTTP ${resp.status}` };
      }

      const data = await resp.json();
      lastSummary = data.summary;
    }
    console.log('[GBP BG] Metrics synced to backend:', lastSummary);
    return { ok: true, summary: lastSummary };
  } catch (err) {
    console.warn('[GBP BG] Metrics backend sync failed (offline?):', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Push ALL local metrics to the Postgres backend, grouped by business.
 * Mirrors pushAllToServer() above but targets /api/ingest/metrics. Manual
 * trigger only (message handler 'pushAllMetricsToBackend') — intentionally
 * NOT wired into autoSync() yet; an untested bulk push should not fire
 * automatically on first install.
 *
 * @returns {Promise<{success:boolean, businesses?:number, error?:string}>}
 */
async function pushAllMetricsToBackend() {
  const enabled = await metricsBackendSyncEnabled();
  if (!enabled) return { success: false, error: 'disabled' };

  const key = await getBackendKey();
  if (!key) return { success: false, error: 'Backend not connected' };

  try {
    const exportData = await GBPStorage.exportAll();
    const businesses = exportData.businesses || [];
    const allMetrics = exportData.metrics   || [];

    let pushedBusinesses = 0;
    for (const biz of businesses) {
      const bizMetrics = allMetrics.filter(m => m.businessId === biz.id);
      if (!bizMetrics.length) continue;

      const result = await syncMetricsToBackend(biz, bizMetrics);
      if (result.ok) {
        pushedBusinesses++;
        console.log(`[GBP BG] pushAllMetricsToBackend: ${biz.name || biz.id} synced`);
      } else {
        console.warn(`[GBP BG] pushAllMetricsToBackend: ${biz.name || biz.id} failed:`, result.error);
      }
    }

    return { success: true, businesses: pushedBusinesses };
  } catch (err) {
    console.warn('[GBP BG] pushAllMetricsToBackend failed:', err.message);
    return { success: false, error: err.message };
  }
}

// ── Sync v2: unified hydration + durable outbox ───────────────────────────────
//
// WHY THIS EXISTS
// Before v2, performance metrics and review data travelled on completely
// separate rails: metrics were pushed to the SQLite server AND to Postgres but
// could only be READ BACK from SQLite, while reviews lived only in Postgres.
// Two servers, two credentials, two id spaces. Whenever one rail was healthy
// and the other was not, the dashboard rendered exactly half a business —
// performance with no reviews, or reviews with no performance.
//
// v2 collapses the read path onto a single endpoint (GET /api/ingest/sync)
// that returns metrics AND reviews in one response, so "half a business" stops
// being a representable state: either both arrive or neither does.
//
// Everything here is gated on the gbpSyncV2 flag, DEFAULT OFF. With the flag
// off, every v1 code path above runs exactly as before — this is the rollback,
// and it does not require reinstalling the extension.

/**
 * Master kill switch for all v2 sync behaviour. Defaults OFF (opt-in) so an
 * extension update can never change sync behaviour under a user who did not
 * ask for it. Mirrors metricsBackendSyncEnabled()'s storage-flag pattern.
 * @returns {Promise<boolean>}
 */
async function syncV2Enabled() {
  return new Promise(resolve => {
    chrome.storage.local.get(['gbpSyncV2'], r => resolve(r.gbpSyncV2 === true));
  });
}

/** Read/write the per-business incremental sync cursor (server `syncedAt`). */
async function getSyncCursor(businessId) {
  return new Promise(resolve => {
    chrome.storage.local.get(['gbpSyncCursor'], r => resolve((r.gbpSyncCursor || {})[businessId] || null));
  });
}
async function setSyncCursor(businessId, syncedAt) {
  return new Promise(resolve => {
    chrome.storage.local.get(['gbpSyncCursor'], r => {
      const cur = r.gbpSyncCursor || {};
      cur[businessId] = syncedAt;
      chrome.storage.local.set({ gbpSyncCursor: cur }, resolve);
    });
  });
}

/**
 * Pull a business's COMPLETE server state — metrics, snapshots and reviews —
 * and merge it into local IndexedDB in one pass.
 *
 * This is the function that answers "whenever performance is scraped, reviews
 * should come down too": every scrape calls it, so the local store converges
 * on the server's full picture regardless of which button was pressed or which
 * Google page the scrape happened on.
 *
 * Alias handling: the server reconciles the GBP local id and the Maps CID into
 * one TrackedBusiness, but the client historically had no way to learn that.
 * The response's googlePlaceId is the canonical id, so when it differs from the
 * id we asked about, local records are folded onto it — self-healing the split
 * rows that cause the half-empty dashboard.
 *
 * @param {string}  businessId  Local business id (CID, GBP local id, or slug).
 * @param {boolean} full        Ignore the incremental cursor and refetch all.
 * @returns {Promise<{success:boolean, metrics?:number, reviews?:number, snapshots?:number, canonicalId?:string, error?:string}>}
 */
async function hydrateBusiness(businessId, full = false) {
  const key = await getBackendKey();
  if (!key) return { success: false, error: 'Backend not connected' };

  const since = full ? null : await getSyncCursor(businessId);

  try {
    const url = `${BACKEND_URL}/api/ingest/sync${since ? `?since=${encodeURIComponent(since)}` : ''}`;
    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${key}`, 'x-extension-id': chrome.runtime.id },
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => resp.statusText);
      return { success: false, error: `HTTP ${resp.status}: ${text}`.slice(0, 200) };
    }
    const data = await resp.json();

    // Locate the business we asked about. Match on googlePlaceId first, then
    // fall back to the backend's own cuid, so this works whether the caller
    // passed a Google id or a TrackedBusiness id.
    const wanted = String(businessId);
    const match = (data.businesses || []).find(
      b => String(b.googlePlaceId) === wanted || String(b.id) === wanted
    );
    if (!match) {
      // Not an error: a business scraped seconds ago may not be on the server
      // yet (its push is still in the outbox). Cursor is deliberately NOT
      // advanced, so the next hydrate re-asks for the same window.
      return { success: true, metrics: 0, reviews: 0, snapshots: 0, notOnServer: true };
    }

    const canonicalId = String(match.googlePlaceId || businessId);

    // Fold any records held under the id we asked about onto the canonical id.
    if (canonicalId !== wanted) {
      await GBPStorage.migrateBusinessData(wanted, canonicalId);
      console.log(`[GBP BG] hydrate: folded ${wanted} → ${canonicalId} (server canonical)`);
    }

    await GBPStorage.saveBusiness({ id: canonicalId, name: match.name || canonicalId });

    // ── Metrics ──
    // Same merge rule as pullFromServer: a real local record is never
    // overwritten by a derived server one, and a higher local total wins.
    let metricsMerged = 0;
    for (const m of match.metrics || []) {
      const serverIsReal = !m.isDerived;
      const existing = await GBPStorage.getMetric(canonicalId, m.metricType, m.year, m.month);
      if (existing) {
        const localIsReal = !existing.derived;
        if (localIsReal && !serverIsReal) continue;
        if (localIsReal && serverIsReal && existing.total >= m.total) continue;
      }
      const extra = {};
      if (m.breakdown)   extra.breakdown   = m.breakdown;
      if (m.searchTerms) extra.searchTerms = m.searchTerms;
      await GBPStorage.saveMetric(
        canonicalId, m.metricType, m.year, m.month,
        m.total, Array.isArray(m.daily) ? m.daily : [],
        m.yoyPercent ?? null,
        { derived: !!m.isDerived, ...extra }
      );
      metricsMerged++;
    }

    // ── Review snapshots ──
    let snapsMerged = 0;
    for (const s of match.snapshots || []) {
      await GBPStorage.saveReviewSnapshot(canonicalId, {
        capturedOn:   String(s.capturedOn || '').slice(0, 10),
        totalReviews: s.totalReviews,
        avgRating:    s.displayRating ?? s.trueAverage ?? null,
        stars:        {},
      });
      snapsMerged++;
    }

    // ── Individual reviews ──
    const mapped = (match.reviews || []).map(r => ({
      externalId:   r.externalReviewId,
      rating:       r.rating,
      text:         r.text || '',
      author:       r.authorName || '',
      isLocalGuide: !!r.isLocalGuide,
      hasPhoto:     !!r.hasPhoto,
      reviewedAt:   r.reviewedAt ? String(r.reviewedAt).slice(0, 10) : '',
    }));
    if (mapped.length) await GBPStorage.saveReviews(canonicalId, mapped);

    // Advance the cursor only after everything above committed. A crash
    // mid-merge therefore replays the window rather than skipping it.
    if (data.syncedAt) await setSyncCursor(canonicalId, data.syncedAt);

    console.log(`[GBP BG] hydrated ${canonicalId}: ${metricsMerged} metrics, ${snapsMerged} snapshots, ${mapped.length} reviews`);
    return {
      success: true,
      canonicalId,
      metrics: metricsMerged,
      snapshots: snapsMerged,
      reviews: mapped.length,
    };
  } catch (err) {
    console.warn('[GBP BG] hydrateBusiness failed:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Send one outbox job. Returns true only when the server has acknowledged it —
 * a false return keeps the job queued for a later attempt.
 * @param {{kind:string, payload:object}} job
 */
async function sendSyncJob(job) {
  if (job.kind === 'metrics') {
    const r = await syncMetricsToBackend(job.payload.business, job.payload.metrics);
    if (r.ok) return { ok: true };
    // 'disabled' and 'Nothing to sync' are terminal, not transient: retrying
    // cannot change the outcome, so drop rather than retry forever.
    if (r.error === 'disabled' || r.error === 'Nothing to sync') return { ok: true, dropped: true };
    return { ok: false, error: r.error };
  }
  if (job.kind === 'intel') {
    const p = job.payload;
    const r = await syncReviewToBackend(p.business, p.snapshot, p.reviews, p.isOwn !== false);
    if (r.ok) return { ok: true };
    if (r.error === 'Nothing to sync') return { ok: true, dropped: true };
    return { ok: false, error: r.error };
  }
  return { ok: true, dropped: true }; // unknown kind — never block the queue
}

/**
 * Drain due outbox jobs. Safe to call concurrently with itself (guarded), and
 * safe to call when offline — failures just reschedule with backoff.
 */
let _draining = false;
async function drainSyncQueue() {
  if (_draining) return { drained: 0, skipped: true };
  _draining = true;
  let drained = 0, failed = 0;
  try {
    const jobs = await GBPStorage.getDueSyncJobs(25);
    for (const job of jobs) {
      let result;
      try {
        result = await sendSyncJob(job);
      } catch (e) {
        result = { ok: false, error: e.message };
      }
      if (result.ok) {
        await GBPStorage.completeSyncJob(job.id);
        drained++;
      } else {
        await GBPStorage.failSyncJob(job.id, result.error);
        failed++;
      }
    }
    if (drained || failed) console.log(`[GBP BG] outbox drained=${drained} failed=${failed}`);
    return { drained, failed };
  } finally {
    _draining = false;
  }
}

// Periodic drain. The alarm is the safety net that makes the queue durable
// across service-worker shutdowns — MV3 tears the worker down aggressively, so
// an in-memory retry timer would not survive.
const SYNC_ALARM = 'gbpSyncDrain';
chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 5 });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== SYNC_ALARM) return;
  syncV2Enabled().then(on => {
    if (!on) return;
    GBPStorage.open().then(() => drainSyncQueue()).catch(() => {});
  });
});

// ── AI Review Reply Copilot (Module D) ────────────────────────────────────────
//
// Uses the same zx_ ingest key as syncReviewToBackend/pullReviewsFromServer
// above (getBackendKey()) — the /api/ai/* routes accept it via
// validateJWTOrApiKey on the backend, since the extension never holds a
// short-lived backend JWT (see backend/src/middlewares/auth.middleware.ts).

/**
 * Resolve the numeric Google business id (as seen by content.js /
 * extractBusinessId()) to our backend's TrackedBusiness cuid, by matching
 * googlePlaceId in the same GET /api/ingest/intel payload the extension
 * already uses to pull review data.
 */
async function resolveTrackedBusinessId(businessId) {
  const key = await getBackendKey();
  if (!key) return null;
  try {
    const resp = await fetch(`${BACKEND_URL}/api/ingest/intel`, {
      headers: { 'Authorization': `Bearer ${key}`, 'x-extension-id': chrome.runtime.id },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const match = (data.businesses || []).find(b => b.googlePlaceId === String(businessId));
    return match?.id || null;
  } catch (err) {
    console.warn('[GBP BG] resolveTrackedBusinessId failed:', err.message);
    return null;
  }
}

/**
 * List un-replied (or all) scraped reviews for a business, for the extension's
 * "Auto-draft replies" flow. Maps the numeric GBP business id to our
 * trackedBusinessId first.
 */
async function aiListUnrepliedReviews(businessId) {
  const key = await getBackendKey();
  if (!key) return { ok: false, error: 'Backend not connected — sign in with Google to enable AI replies' };

  const trackedBusinessId = await resolveTrackedBusinessId(businessId);
  if (!trackedBusinessId) return { ok: false, error: 'This business has not been synced to the backend yet. Fetch reviews first.' };

  try {
    const resp = await fetch(
      `${BACKEND_URL}/api/ai/reviews?trackedBusinessId=${encodeURIComponent(trackedBusinessId)}&onlyUnreplied=true`,
      { headers: { 'Authorization': `Bearer ${key}` } }
    );
    if (!resp.ok) {
      const text = await resp.text().catch(() => resp.statusText);
      return { ok: false, error: `HTTP ${resp.status}: ${text}` };
    }
    const data = await resp.json();
    return { ok: true, reviews: data.reviews || [], trackedBusinessId };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Generate AI draft replies for a batch of scraped review ids.
 */
async function aiBulkDraft(businessId, scrapedReviewIds, model) {
  const key = await getBackendKey();
  if (!key) return { ok: false, error: 'Backend not connected — sign in with Google to enable AI replies' };

  const trackedBusinessId = await resolveTrackedBusinessId(businessId);
  if (!trackedBusinessId) return { ok: false, error: 'This business has not been synced to the backend yet.' };

  try {
    const resp = await fetch(`${BACKEND_URL}/api/ai/reply/bulk`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify({ scrapedReviewIds, trackedBusinessId, ...(model ? { model } : {}) }),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => resp.statusText);
      return { ok: false, error: `HTTP ${resp.status}: ${text}` };
    }
    const data = await resp.json();
    return { ok: true, results: data.results || [], stoppedForBudget: !!data.stoppedForBudget };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Return the calling user's monthly AI usage/cost-cap summary. */
async function aiUsage() {
  const key = await getBackendKey();
  if (!key) return { ok: false, error: 'Backend not connected' };
  try {
    const resp = await fetch(`${BACKEND_URL}/api/ai/usage`, {
      headers: { 'Authorization': `Bearer ${key}` },
    });
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
    const data = await resp.json();
    return { ok: true, usage: data.usage };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Pull all data for a business from the server and merge into local IndexedDB.
 * Only requests records newer than the last successful pull (using ?since=).
 *
 * @param {string} businessId
 * @returns {Promise<{success:boolean, merged:number, error?:string}>}
 */
/**
 * Pull data for one business from the server and merge into local IndexedDB.
 *
 * Merge strategy — "take the best of both":
 *   • If the record exists locally with a HIGHER total → keep local (don't overwrite).
 *   • If the record exists locally with a LOWER total  → take server value.
 *   • If the record only exists on server              → save it locally.
 *   • Derived records are never used to overwrite real ones.
 *
 * @param {string}  businessId
 * @param {boolean} full  When true, fetch ALL records (since=0), ignoring lastPull cache.
 */
async function pullFromServer(businessId, full = false) {
  const token = await getAuthToken();
  if (!token) return { success: false, error: 'Not logged in' };

  const lastPull = await new Promise(resolve =>
    chrome.storage.local.get(['gbpLastPull'], r => resolve(r.gbpLastPull || {}))
  );
  // full=true → always fetch everything; otherwise use cached timestamp
  const since = full ? 0 : (lastPull[businessId] || 0);

  try {
    const url  = `${SERVER_URL}/api/business/${businessId}?since=${since}`;
    const resp = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });

    if (resp.status === 404) return { success: true, merged: 0 };  // new business — nothing there yet
    if (!resp.ok) {
      const text = await resp.text().catch(() => resp.statusText);
      return { success: false, error: `HTTP ${resp.status}: ${text}` };
    }

    const { business, metrics } = await resp.json();

    // Save the business record locally
    if (business) {
      await GBPStorage.saveBusiness({ id: business.id, name: business.name });
    }

    // Merge each metric — take the higher total, never overwrite real with derived
    let merged = 0;
    for (const m of (metrics || [])) {
      const serverIsReal = !m.derived;

      // Check what we already have locally for this slot
      const existing = await GBPStorage.getMetric(
        m.businessId || businessId, m.metricType, m.year, m.month
      );

      if (existing) {
        const localIsReal = !existing.derived;
        // Never overwrite a real local record with a derived server record
        if (localIsReal && !serverIsReal) continue;
        // Keep local if it has a higher or equal total (local scrape is source of truth)
        if (localIsReal && serverIsReal && existing.total >= m.total) continue;
      }

      // Server has better/missing data — save it
      const extra = buildExtraFields(m);
      await GBPStorage.saveMetric(
        m.businessId || businessId,
        m.metricType,
        m.year, m.month,
        m.total, m.daily || [],
        m.yoyPercent ?? null,
        { derived: !!m.derived, ...extra }
      );
      merged++;
    }

    // Update last-pull timestamp
    await setLastPull(businessId, Date.now());

    console.log(`[GBP BG] Pulled ${merged} records from server for ${businessId} (full=${full})`);
    return { success: true, merged };

  } catch (err) {
    console.warn('[GBP BG] Pull from server failed:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Bidirectional sync — push all local data up, then pull all server data down.
 * Debounced: skips if a sync completed within the last 5 minutes.
 * Safe to call repeatedly (all operations are idempotent upserts).
 *
 * @param {boolean} force  Skip the debounce and sync regardless of last sync time.
 * @returns {Promise<{success:boolean, pushed:number, pulled:number, error?:string}>}
 */
async function autoSync(force = false) {
  const token = await getAuthToken();
  if (!token) return { success: false, error: 'Not logged in' };

  // Debounce: don't auto-sync more than once every 5 minutes unless forced
  if (!force) {
    const { gbpLastAutoSync } = await new Promise(resolve =>
      chrome.storage.local.get(['gbpLastAutoSync'], resolve)
    );
    const FIVE_MIN = 5 * 60 * 1000;
    if (gbpLastAutoSync && (Date.now() - gbpLastAutoSync) < FIVE_MIN) {
      console.log('[GBP BG] autoSync skipped — synced recently');
      return { success: true, pushed: 0, pulled: 0, skipped: true };
    }
  }

  await GBPStorage.open();
  const pushResult = await pushAllToServer();
  // force=true → full pull (since=0) so we compare ALL records, not just recent ones
  const pullResult = await pullAllBusinesses(force);

  // Record timestamp so the debounce works next time
  await new Promise(resolve =>
    chrome.storage.local.set({ gbpLastAutoSync: Date.now() }, resolve)
  );

  const pushed = pushResult.saved   || 0;
  const pulled = pullResult.merged  || 0;
  console.log(`[GBP BG] autoSync complete — pushed=${pushed} pulled=${pulled}`);
  return { success: true, pushed, pulled };
}

/**
 * Push ALL local data to the server using the /api/sync-bulk endpoint.
 * Reads every business + metric from local IndexedDB and uploads them.
 * This is used once to seed the server with data that was collected before
 * cloud sync was set up, or after a server database wipe.
 *
 * @returns {Promise<{success:boolean, saved:number, skipped:number, businesses:number, error?:string}>}
 */
async function pushAllToServer() {
  const token = await getAuthToken();
  if (!token) return { success: false, error: 'Not logged in' };

  try {
    const exportData = await GBPStorage.exportAll();
    const businesses = exportData.businesses || [];
    const allMetrics = exportData.metrics   || [];

    if (!businesses.length) return { success: true, saved: 0, skipped: 0, businesses: 0 };

    let totalSaved   = 0;
    let totalSkipped = 0;

    for (const biz of businesses) {
      const bizMetrics = allMetrics.filter(m => m.businessId === biz.id);
      if (!bizMetrics.length) continue;

      try {
        const resp = await fetch(`${SERVER_URL}/api/sync-bulk`, {
          method:  'POST',
          headers: {
            'Content-Type':  'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({
            locationCode: biz.id,
            businessName: biz.name,
            metrics:      bizMetrics,
          }),
        });

        if (!resp.ok) {
          const text = await resp.text().catch(() => resp.statusText);
          console.warn(`[GBP BG] pushAll: HTTP ${resp.status} for ${biz.id}:`, text);
          continue;
        }

        const data = await resp.json();
        totalSaved   += data.saved   || 0;
        totalSkipped += data.skipped || 0;
        console.log(`[GBP BG] pushAll: ${biz.name || biz.id} → saved=${data.saved} skipped=${data.skipped}`);

      } catch (bizErr) {
        console.warn(`[GBP BG] pushAll: error for ${biz.id}:`, bizErr.message);
      }
    }

    return { success: true, saved: totalSaved, skipped: totalSkipped, businesses: businesses.length };

  } catch (err) {
    console.warn('[GBP BG] pushAllToServer failed:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Pull ALL businesses for the current user from the server.
 * First fetches the list of businesses via GET /api/businesses,
 * then calls pullFromServer() for each one.
 *
 * @returns {Promise<{success:boolean, merged:number, businesses:number, error?:string}>}
 */
/**
 * @param {boolean} full  When true, each business pulls ALL records (since=0),
 *                        ignoring the lastPull timestamp cache. Use this for
 *                        force-sync and sign-in scenarios.
 */
async function pullAllBusinesses(full = false) {
  const token = await getAuthToken();
  if (!token) return { success: false, error: 'Not logged in' };

  try {
    const resp = await fetch(`${SERVER_URL}/api/businesses`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => resp.statusText);
      return { success: false, error: `HTTP ${resp.status}: ${text}` };
    }

    const { businesses } = await resp.json();
    let totalMerged = 0;

    for (const biz of (businesses || [])) {
      // Server returns { id, name, lastUpdated } — 'id' is the location_code
      await GBPStorage.saveBusiness({ id: biz.id, name: biz.name });

      const result = await pullFromServer(biz.id, full);
      if (result.success) totalMerged += result.merged;
    }

    console.log(`[GBP BG] pullAllBusinesses: ${(businesses || []).length} biz, ${totalMerged} merged (full=${full})`);
    return { success: true, merged: totalMerged, businesses: (businesses || []).length };

  } catch (err) {
    console.warn('[GBP BG] pullAllBusinesses failed:', err.message);
    return { success: false, error: err.message };
  }
}

/** Extract non-core fields from a metric object to pass as "extra". */
function buildExtraFields(metric) {
  const CORE = new Set([
    'id','businessId','metricType','year','month',
    'total','daily','yoyPercent','derived','collectedAt','syncedAt',
  ]);
  const extra = {};
  for (const [k, v] of Object.entries(metric)) {
    if (!CORE.has(k) && v !== undefined && v !== null) extra[k] = v;
  }
  return extra;
}

/**
 * Sign in with Google using launchWebAuthFlow so the user can pick any account,
 * not just the browser's default. prompt=select_account forces the account chooser.
 */
async function authGoogleLogin() {
  return new Promise(resolve => {
    const redirectUri = chrome.identity.getRedirectURL();
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', GOOGLE_CLIENT_ID);
    authUrl.searchParams.set('response_type', 'token');
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('scope', 'email profile');
    authUrl.searchParams.set('prompt', 'select_account');

    chrome.identity.launchWebAuthFlow(
      { url: authUrl.toString(), interactive: true },
      async responseUrl => {
        if (chrome.runtime.lastError || !responseUrl) {
          resolve({ success: false, error: chrome.runtime.lastError?.message || 'Cancelled' });
          return;
        }
        // Extract access_token from the redirect URL fragment
        const hash = new URL(responseUrl).hash.slice(1);
        const params = new URLSearchParams(hash);
        const accessToken = params.get('access_token');
        if (!accessToken) {
          resolve({ success: false, error: 'No access token returned' });
          return;
        }
        try {
          const resp = await fetch(`${SERVER_URL}/api/auth/google`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ accessToken }),
          });
          const data = await resp.json();
          if (!resp.ok) { resolve({ success: false, error: data.error || `HTTP ${resp.status}` }); return; }
          await saveAuthSession(data.token, data.user);
          // Also connect the Postgres backend with the same Google token so
          // review sync works (best-effort — never blocks the primary login).
          connectBackend(accessToken)
            .then(r => { if (!r.ok) console.warn('[GBP BG] Backend connect skipped:', r.error); })
            .catch(() => {});
          resolve({ success: true, user: data.user });
        } catch (err) {
          resolve({ success: false, error: err.message });
        }
      }
    );
  });
}

/**
 * Register a new user account on the server.
 */
async function authRegister(email, password, name) {
  try {
    const resp = await fetch(`${SERVER_URL}/api/auth/register`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email, password, name }),
    });
    const data = await resp.json();
    if (!resp.ok) return { success: false, error: data.error || `HTTP ${resp.status}` };
    await saveAuthSession(data.token, data.user);
    return { success: true, user: data.user };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Log in with email + password.
 */
async function authLogin(email, password) {
  try {
    const resp = await fetch(`${SERVER_URL}/api/auth/login`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email, password }),
    });
    const data = await resp.json();
    if (!resp.ok) return { success: false, error: data.error || `HTTP ${resp.status}` };
    await saveAuthSession(data.token, data.user);
    return { success: true, user: data.user };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ── Message handlers ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // ── Open dashboard ────────────────────────────────────────────────────────
  if (msg.action === 'openDashboard') {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
    return;
  }

  // ── Save a single metric record (called from content script iframe) ────────
  if (msg.action === 'saveMetricData') {
    const m = msg.metric;

    GBPStorage.open()
      // Fold any records stored under the GBP local id into the canonical CID
      // row — one business must not split into metrics-only + reviews-only rows.
      .then(() => GBPStorage.migrateBusinessData(msg.business?.aliasId, msg.business?.id))
      .then(() => GBPStorage.saveBusiness({ id: msg.business.id, name: msg.business.name }))
      .then(() => GBPStorage.saveMetric(
        m.businessId, m.metricType,
        m.year, m.month,
        m.total, m.daily, m.yoyPercent,
        m.extra || {}
      ))
      .then(async () => {
        // ── Auto-derive prior year value from YoY% ───────────────────────
        if (m.yoyPercent != null && m.total > 0) {
          const prevYear = m.year - 1;
          const existing = await GBPStorage.getMetric(m.businessId, m.metricType, prevYear, m.month);
          if (!existing || existing.derived) {
            const prevTotal = Math.round(m.total / (1 + m.yoyPercent / 100));
            if (prevTotal > 0) {
              await GBPStorage.saveMetric(
                m.businessId, m.metricType,
                prevYear, m.month,
                prevTotal, [], null,
                { derived: true, derivedFrom: { year: m.year, month: m.month, yoyPercent: m.yoyPercent } }
              );
              console.log(`[GBP BG] Derived ${m.metricType} ${prevYear}-${m.month}: ${prevTotal}`);

              // Also push the derived record to the server
              syncMetricToServer(m.businessId, msg.business?.name || m.businessId, {
                businessId: m.businessId,
                metricType: m.metricType,
                year:       prevYear,
                month:      m.month,
                total:      prevTotal,
                daily:      [],
                yoyPercent: null,
                derived:    true,
                derivedFrom: { year: m.year, month: m.month, yoyPercent: m.yoyPercent },
                collectedAt: Date.now(),
              }).catch(() => {});

              // Also push the derived record to the Postgres backend
              // (fire-and-forget, gated by the kill switch — see
              // syncMetricsToBackend; never fails the local save).
              syncMetricsToBackend(msg.business, [{
                businessId: m.businessId,
                metricType: m.metricType,
                year:       prevYear,
                month:      m.month,
                total:      prevTotal,
                daily:      [],
                yoyPercent: null,
                derived:    true,
                collectedAt: Date.now(),
              }]).catch(() => {});
            }
          }
        }
      })
      .then(() => {
        // ── Push the real record to the sync server (fire-and-forget) ────
        const metricForServer = {
          businessId:  m.businessId,
          metricType:  m.metricType,
          year:        m.year,
          month:       m.month,
          total:       m.total,
          daily:       m.daily,
          yoyPercent:  m.yoyPercent,
          derived:     false,
          collectedAt: Date.now(),
          ...(m.extra || {}),
        };
        syncMetricToServer(
          m.businessId,
          msg.business?.name || m.businessId,
          metricForServer
        ).catch(() => {});   // never fail the local save because of server issues

        // ── Also push the real record to the Postgres backend ────────────
        // v2: enqueue to the durable outbox and immediately hydrate, so this
        // business ends up with its reviews too — the scrape button chose what
        // to read off Google, not what the dashboard is allowed to show.
        // v1 (flag off): unchanged fire-and-forget.
        syncV2Enabled().then(on => {
          if (!on) {
            syncMetricsToBackend(msg.business, [metricForServer]).catch(() => {});
            return;
          }
          const dedupeKey = `metrics:${m.businessId}:${m.metricType}:${m.year}-${m.month}`;
          GBPStorage.enqueueSync('metrics', m.businessId, dedupeKey, {
            business: msg.business,
            metrics:  [metricForServer],
          })
            .then(() => drainSyncQueue())
            .then(() => hydrateBusiness(msg.business?.id || m.businessId))
            .catch(e => console.warn('[GBP BG] v2 metric sync failed:', e.message));
        });
      })
      .then(() => sendResponse({
        success: true,
        saved: { year: m.year, month: m.month, type: m.metricType, total: m.total }
      }))
      .catch(e => {
        console.error('[GBP BG] saveMetricData error:', e);
        sendResponse({ success: false, reason: e.message });
      });
    return true;
  }

  // ── Save scraped review snapshot + individual reviews ─────────────────────
  if (msg.action === 'saveReviewData') {
    const { business, snapshot, reviews } = msg;
    const businessId = business?.id;

    GBPStorage.open()
      // Fold local-id records into the canonical CID row (see saveMetricData)
      .then(() => GBPStorage.migrateBusinessData(business?.aliasId, businessId))
      .then(() => business ? GBPStorage.saveBusiness({ id: business.id, name: business.name }) : null)
      .then(() => snapshot ? GBPStorage.saveReviewSnapshot(businessId, snapshot) : null)
      .then(() => (Array.isArray(reviews) && reviews.length)
        ? GBPStorage.saveReviews(businessId, reviews) : 0)
      .then(() => GBPStorage.getReviews(businessId))
      .then((allReviews) => {
        // v2: durable outbox + immediate hydrate, so a review scrape also pulls
        // this business's performance history down. v1: fire-and-forget.
        syncV2Enabled().then(on => {
          if (!on) {
            syncReviewToBackend(business, snapshot, reviews, msg.isOwn !== false).catch(() => {});
            return;
          }
          GBPStorage.enqueueSync('intel', businessId, `intel:${businessId}`, {
            business, snapshot, reviews, isOwn: msg.isOwn !== false,
          })
            .then(() => drainSyncQueue())
            .then(() => hydrateBusiness(businessId))
            .catch(e => console.warn('[GBP BG] v2 review sync failed:', e.message));
        });
        sendResponse({
          success: true,
          saved: {
            totalReviews: snapshot?.totalReviews ?? null,
            avgRating:    snapshot?.avgRating ?? null,
            reviewsSaved: allReviews.length,
          },
        });
      })
      .catch(e => {
        console.error('[GBP BG] saveReviewData error:', e);
        sendResponse({ success: false, reason: e.message });
      });
    return true;
  }

  // ── Open a place's reviews in a new tab flagged for auto-scrape ───────────
  if (msg.action === 'openReviewTab') {
    if (msg.url) chrome.tabs.create({ url: msg.url, active: false });
    sendResponse({ success: true });
    return true;
  }

  // ── v2: pull a business's FULL server state (metrics + reviews together) ──
  if (msg.action === 'hydrateBusiness') {
    GBPStorage.open()
      .then(() => hydrateBusiness(msg.businessId, !!msg.full))
      .then(result => sendResponse(result))
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  // ── v2: outbox depth / last error, for an honest sync indicator ───────────
  if (msg.action === 'getSyncQueueStatus') {
    GBPStorage.open()
      .then(() => GBPStorage.getSyncQueueStatus())
      .then(status => sendResponse({ success: true, status }))
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  // ── v2: force a drain now (dashboard "Retry sync") ───────────────────────
  if (msg.action === 'drainSyncQueue') {
    GBPStorage.open()
      .then(() => drainSyncQueue())
      .then(result => sendResponse({ success: true, ...result }))
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  // ── v2: read/flip the kill switch without a reinstall ────────────────────
  if (msg.action === 'getSyncV2') {
    syncV2Enabled().then(enabled => sendResponse({ success: true, enabled }));
    return true;
  }
  if (msg.action === 'setSyncV2') {
    chrome.storage.local.set({ gbpSyncV2: !!msg.enabled }, () => {
      console.log(`[GBP BG] Sync v2 ${msg.enabled ? 'ENABLED' : 'DISABLED'}`);
      sendResponse({ success: true, enabled: !!msg.enabled });
    });
    return true;
  }

  // ── Pull review snapshots + reviews for a business from the server ────────
  if (msg.action === 'pullReviews') {
    GBPStorage.open()
      .then(() => pullReviewsFromServer(msg.businessId))
      .then(result => sendResponse(result))
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  // ── Pull data from server for a specific business ─────────────────────────
  if (msg.action === 'pullFromServer') {
    GBPStorage.open()
      .then(() => pullFromServer(msg.businessId))
      .then(result => sendResponse(result))
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  // ── Bidirectional auto-sync (push + pull) ────────────────────────────────
  if (msg.action === 'autoSync') {
    GBPStorage.open()
      .then(() => autoSync(msg.force === true))
      .then(result => sendResponse(result))
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  // ── Push ALL local data up to the server ─────────────────────────────────
  if (msg.action === 'pushAllToServer') {
    GBPStorage.open()
      .then(() => pushAllToServer())
      .then(result => sendResponse(result))
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  // ── Push ALL local metrics to the Postgres backend (manual trigger only —
  //    see pushAllMetricsToBackend(); not wired into autoSync yet) ──────────
  if (msg.action === 'pushAllMetricsToBackend') {
    GBPStorage.open()
      .then(() => pushAllMetricsToBackend())
      .then(result => sendResponse(result))
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  // ── Pull ALL businesses + their data from the server ──────────────────────
  if (msg.action === 'pullAllBusinesses') {
    GBPStorage.open()
      .then(() => pullAllBusinesses())
      .then(result => sendResponse(result))
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  // ── Auth: Google OAuth sign-in ────────────────────────────────────────────
  if (msg.action === 'authGoogleLogin') {
    authGoogleLogin()
      .then(result => sendResponse(result))
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  // ── Auth: register new account ────────────────────────────────────────────
  if (msg.action === 'authRegister') {
    authRegister(msg.email, msg.password, msg.name || '')
      .then(result => sendResponse(result))
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  // ── Auth: log in ──────────────────────────────────────────────────────────
  if (msg.action === 'authLogin') {
    authLogin(msg.email, msg.password)
      .then(result => sendResponse(result))
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  // ── Auth: get current user ────────────────────────────────────────────────
  if (msg.action === 'getAuthUser') {
    chrome.storage.local.get(['gbpUser'], r => sendResponse({ user: r.gbpUser || null }));
    return true;
  }

  // ── Get latest collected month for a specific business ─────────────────────
  if (msg.action === 'getLatestMonth') {
    GBPStorage.open()
      // Migrate BEFORE querying, or months stored under the local id look
      // missing and the scraper re-fetches everything from scratch.
      .then(() => GBPStorage.migrateBusinessData(msg.aliasId, msg.businessId))
      .then(() => GBPStorage.getOldestAndNewest(msg.businessId))
      .then(range => sendResponse({ latest: range?.newest || null }))
      .catch(() => sendResponse({ latest: null }));
    return true;
  }

  // ── Get storage stats (for the floating panel info label) ─────────────────
  if (msg.action === 'getStorageStats') {
    GBPStorage.open()
      .then(() => GBPStorage.getStats())
      .then(stats => sendResponse({ success: true, stats }))
      .catch(e => {
        console.error('[GBP BG] getStorageStats error:', e);
        sendResponse({ success: false, stats: { totalBusinesses: 0, totalRecords: 0 } });
      });
    return true;
  }

  // ── Export all data as JSON ───────────────────────────────────────────────
  if (msg.action === 'exportAll') {
    GBPStorage.open()
      .then(() => GBPStorage.exportAll())
      .then(data => sendResponse({ success: true, data }))
      .catch(e => sendResponse({ success: false, reason: e.message }));
    return true;
  }

  // ── Import data from JSON backup ──────────────────────────────────────────
  if (msg.action === 'importAll') {
    GBPStorage.open()
      .then(() => GBPStorage.importAll(msg.data))
      .then(() => sendResponse({ success: true }))
      .catch(e => sendResponse({ success: false, reason: e.message }));
    return true;
  }

  // ── AI Reply Copilot: list un-replied reviews for a business ──────────────
  if (msg.action === 'aiListUnrepliedReviews') {
    aiListUnrepliedReviews(msg.businessId)
      .then(result => sendResponse(result))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  // ── AI Reply Copilot: bulk-draft replies for un-replied reviews ───────────
  if (msg.action === 'aiBulkDraft') {
    aiBulkDraft(msg.businessId, msg.scrapedReviewIds || [], msg.model)
      .then(result => sendResponse(result))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  // ── AI Reply Copilot: monthly usage / cost-cap summary ────────────────────
  if (msg.action === 'aiUsage') {
    aiUsage()
      .then(result => sendResponse(result))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
});

// On first install, open the dashboard
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
  }
});

// On browser startup, silently sync in the background (debounced to once per 5 min)
chrome.runtime.onStartup.addListener(() => {
  GBPStorage.open()
    .then(() => autoSync(false))
    .then(r => {
      if (!r.skipped) console.log('[GBP BG] Startup auto-sync:', r);
    })
    .catch(e => console.warn('[GBP BG] Startup auto-sync failed:', e.message));
});
