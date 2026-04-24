/**
 * Background Service Worker
 * Acts as the storage bridge between content scripts (web page origin)
 * and extension pages like the dashboard (extension origin).
 *
 * ALL IndexedDB operations must go through here so that both the
 * content script (which saves data) and the dashboard (which reads data)
 * are using the SAME database under the extension origin.
 */

importScripts('storage.js');

// Pre-warm the DB connection on startup
GBPStorage.open().catch(e => console.error('[GBP BG] Storage init error:', e));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // ── Open dashboard ──────────────────────────────────────────────────────────
  if (msg.action === 'openDashboard') {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
    return;
  }

  // ── Save a single metric record (called from content script iframe) ─────────
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
        // ── Auto-derive prior year value from YoY% ─────────────────────────
        // Google shows e.g. "+114.6% vs Feb 2025" on Feb 2026.
        // Back-calculate: prevTotal = total / (1 + yoyPercent/100)
        // Only write if no real (non-derived) record already exists for that month.
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
                {
                  derived: true,
                  derivedFrom: { year: m.year, month: m.month, yoyPercent: m.yoyPercent }
                }
              );
              console.log(`[GBP BG] Derived ${m.metricType} ${prevYear}-${m.month}: ${prevTotal} (from ${m.year}-${m.month} yoy ${m.yoyPercent}%)`);
            }
          }
        }
      })
      .then(() => sendResponse({
        success: true,
        saved: {
          year: m.year, month: m.month,
          type: m.metricType, total: m.total
        }
      }))
      .catch(e => {
        console.error('[GBP BG] saveMetricData error:', e);
        sendResponse({ success: false, reason: e.message });
      });
    return true; // keep channel open for async response
  }

  // ── Get latest collected month for a specific business ─────────────────────
  if (msg.action === 'getLatestMonth') {
    GBPStorage.open()
      .then(() => GBPStorage.getOldestAndNewest(msg.businessId))
      .then(range => sendResponse({ latest: range?.newest || null }))
      .catch(() => sendResponse({ latest: null }));
    return true;
  }

  // ── Get storage stats (for the floating panel info label) ──────────────────
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

  // ── Export all data as JSON ─────────────────────────────────────────────────
  if (msg.action === 'exportAll') {
    GBPStorage.open()
      .then(() => GBPStorage.exportAll())
      .then(data => sendResponse({ success: true, data }))
      .catch(e => sendResponse({ success: false, reason: e.message }));
    return true;
  }

  // ── Import data from JSON backup ────────────────────────────────────────────
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
