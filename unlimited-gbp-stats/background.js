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

importScripts('storage.js');

// Pre-warm the DB connection on startup
GBPStorage.open().catch(e => console.error('[GBP BG] Storage init error:', e));

// ── Hardcoded server URL — change this to your deployed server ────────────────
const SERVER_URL = 'http://gbp.zixify.zixai.in:3005'; // GBP Stats Server (Hetzner VPS)

// ── Google OAuth client ID ────────────────────────────────────────────────────
// Create one at https://console.cloud.google.com → APIs & Services → Credentials
// Type: Web application, Redirect URI: https://<extensionId>.chromiumapp.org/
const GOOGLE_CLIENT_ID = '512083455568-4o7052vjg67pl21vojekgrs0qcta4a1n.apps.googleusercontent.com';

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

/**
 * Pull all data for a business from the server and merge into local IndexedDB.
 * Only requests records newer than the last successful pull (using ?since=).
 *
 * @param {string} businessId
 * @returns {Promise<{success:boolean, merged:number, error?:string}>}
 */
async function pullFromServer(businessId) {
  const token = await getAuthToken();
  if (!token) return { success: false, error: 'Not logged in' };

  const lastPull = await new Promise(resolve =>
    chrome.storage.local.get(['gbpLastPull'], r => resolve(r.gbpLastPull || {}))
  );
  const since = lastPull[businessId] || 0;

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

    // Merge each metric into local IndexedDB
    let merged = 0;
    for (const m of (metrics || [])) {
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

    console.log(`[GBP BG] Pulled ${merged} records from server for ${businessId}`);
    return { success: true, merged };

  } catch (err) {
    console.warn('[GBP BG] Pull from server failed:', err.message);
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
 * Sign in with Google using chrome.identity.getAuthToken (no redirect URI needed).
 * The manifest oauth2.client_id must match the Chrome App OAuth client.
 */
async function authGoogleLogin() {
  return new Promise(resolve => {
    chrome.identity.getAuthToken({ interactive: true }, async accessToken => {
      if (chrome.runtime.lastError || !accessToken) {
        resolve({ success: false, error: chrome.runtime.lastError?.message || 'Cancelled' });
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
        resolve({ success: true, user: data.user });
      } catch (err) {
        resolve({ success: false, error: err.message });
      }
    });
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
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') })
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  // ── Cloud sync: server config (hardcoded — no user setup needed) ──────────
  if (msg.action === 'getServerConfig') {
    sendResponse({ config: { serverUrl: SERVER_URL } });
    return;
  }

  if (msg.action === 'saveServerConfig') {
    // Config is hardcoded; nothing to persist.
    sendResponse({ success: true });
    return;
  }

  if (msg.action === 'testServerConnection') {
    fetch(`${SERVER_URL}/health`)
      .then(r => r.json())
      .then(data => sendResponse({
        ok: true,
        version: data.version || '1.0',
        businesses: data.businesses ?? null,
        records: data.records ?? null,
      }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  // ── Save a single metric record (called from content script iframe) ────────
  if (msg.action === 'saveMetricData') {
    const m = msg.metric;

    GBPStorage.open()
      .then(() => GBPStorage.saveBusiness(msg.business))
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

  // ── Pull data from server for a specific business ─────────────────────────
  if (msg.action === 'pullFromServer') {
    GBPStorage.open()
      .then(() => pullFromServer(msg.businessId))
      .then(result => sendResponse(result))
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  // ── Auth: Google sign-in / sign-up ───────────────────────────────────────
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
});

// On first install, open the dashboard
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
  }
});
