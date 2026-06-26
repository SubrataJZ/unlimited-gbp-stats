/**
 * Content Script — injected into ALL frames on google.com / business.google.com
 *
 * Two modes:
 *   IFRAME MODE  — runs inside the GBP Performance iframe
 *                  (https://www.google.com/local/business/.../promote/performance)
 *                  Has direct DOM access to tabs, date picker, data table.
 *                  Listens for postMessage commands from the parent frame.
 *
 *   MAIN MODE    — runs in the outer page (search results / business.google.com)
 *                  Shows the floating "GBP Stats Collector" panel.
 *                  Relays user button clicks into the performance iframe.
 */

(() => {
  'use strict';

  const EXT_TAG = 'gbp-unlimited-stats';

  // ── Detect context ──────────────────────────────────────────────────────────
  const IS_IFRAME = window !== window.top;
  const IS_PERFORMANCE_IFRAME = IS_IFRAME && (
    window.location.href.includes('/promote/performance') ||
    (window.location.href.includes('/local/business/') && window.location.href.includes('performance'))
  );
  const IS_DIRECT_PERFORMANCE = !IS_IFRAME && window.location.href.includes('/performance');

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ── Business ID extraction (handles multiple URL patterns) ──────────────────
  // Shared helper: extract a decimal CID from any URL string.
  // Tries ?cid= / ?ludcid= param first, then !1s0x...:0x<hex> feature-id.
  // Regexes directly on the raw string — tolerant of relative URLs.
  // Returns decimal CID string or null.
  function extractCidFromUrl(url) {
    if (!url) return null;
    try {
      const cidParam = url.match(/[?&#](?:lud)?cid=(\d{6,})/i);
      if (cidParam) return cidParam[1];
      const fidHex = url.match(/!1s0x[0-9a-f]+:0x([0-9a-f]+)/i);
      if (fidHex) {
        try { return BigInt('0x' + fidHex[1]).toString(); } catch (e) { /* fall through */ }
      }
    } catch (e) { /* defensive */ }
    return null;
  }

  // Best-effort DOM scan for a CID when on a #mpd search panel page.
  // Checks place links and data-fid attributes; never throws.
  function findCidInDom() {
    try {
      // Try the first /maps/place/ anchor that contains a CID
      const anchors = document.querySelectorAll('a[href*="/maps/place/"]');
      for (const a of anchors) {
        const cid = extractCidFromUrl(a.href);
        if (cid) return cid;
      }
      // Try data-fid="0x<hex>:0x<hex>"
      const fidEl = document.querySelector('[data-fid]');
      if (fidEl) {
        const fid = fidEl.getAttribute('data-fid') || '';
        const m = fid.match(/:0x([0-9a-f]+)/i);
        if (m) {
          try { return BigInt('0x' + m[1]).toString(); } catch (e) { /* fall through */ }
        }
      }
    } catch (e) { /* defensive */ }
    return null;
  }

  function extractBusinessId() {
    // Pattern: /local/business/12314840327329864086/
    const localMatch = window.location.href.match(/\/local\/business\/(\d{10,})/);
    if (localMatch) return localMatch[1];
    // Pattern: /l/12314840327329864086
    const lMatch = window.location.href.match(/\/l\/(\d{10,})/);
    if (lMatch) return lMatch[1];
    // Search "all reviews" panel: #mpd=~12314840327329864086/customers/reviews
    // Phase B: try DOM CID recovery first, fall back to local-id from URL
    const mpdMatch = window.location.href.match(/#mpd=~?(\d{10,})/);
    if (mpdMatch) {
      const domCid = findCidInDom();
      return domCid || mpdMatch[1];
    }
    // Maps place-detail URLs: cid= param or feature-id (!1s0x<hex>:0x<CIDhex>)
    // Return the decimal CID to match this function's numeric-id contract
    const cidFromUrl = extractCidFromUrl(window.location.href);
    if (cidFromUrl) return cidFromUrl;
    // From data-p attributes
    const dataPEl = document.querySelector('[data-p*="12"]');
    if (dataPEl) {
      const m = dataPEl.getAttribute('data-p')?.match(/"(\d{15,25})"/);
      if (m) return m[1];
    }
    // From jslog attribute on c-wiz
    const cwiz = document.querySelector('c-wiz[jslog]');
    if (cwiz) {
      const m = cwiz.getAttribute('jslog')?.match(/"(\d{15,25})"/);
      if (m) return m[1];
    }
    return null;
  }

  // Business name passed from the main frame via postMessage (most reliable source)
  let _parentBusinessName = null;

  /**
   * Extract the business name from the current page.
   *
   * Tries sources in priority order:
   *   1. Name received from parent frame via postMessage  (iframe mode — most reliable)
   *   2. GBP-specific DOM selectors                       (both modes)
   *   3. Generic headings                                 (fallback)
   *   4. document.title parsing                           (last resort)
   */
  function extractBusinessName() {
    // ── 1. Parent-supplied name (set by main frame when sending commands) ──
    if (_parentBusinessName) return _parentBusinessName;

    // ── 2. GBP-specific selectors (in order of reliability) ──────────────
    const GBP_SELECTORS = [
      // business.google.com — profile header / breadcrumb
      '[data-item-id] h1',
      '.k7uisc',
      '[jsname="r4nke"]',
      '[data-merchant-name]',
      // Knowledge panel on Google Search / Maps
      '[data-attrid="title"]',
      '.qrShPb .kno-ecr-pt',
      '.SPZz6b h2',
      '.uMdZh span',
      // GBP drawer (Maps panel)
      '[jscontroller] h1',
      '[jscontroller] h2',
      // Generic last-resort heading
      'h1',
    ];

    const REJECT = new Set([
      'performance', 'google', 'google business profile',
      'google maps', 'overview', 'calls', 'website clicks',
      'directions', 'bookings', 'chat clicks', 'menu', 'offers',
    ]);

    for (const sel of GBP_SELECTORS) {
      const text = document.querySelector(sel)?.textContent?.trim();
      if (!text || text.length < 2 || text.length > 120) continue;
      if (REJECT.has(text.toLowerCase())) continue;
      return text;
    }

    // ── 3. document.title — split on common separators ────────────────────
    const titleParts = document.title.split(/\s*[-–|·]\s*/);
    for (const part of titleParts) {
      const t = part.trim();
      if (!t || t.length < 2 || t.length > 80) continue;
      if (REJECT.has(t.toLowerCase())) continue;
      if (/^(google|performance|overview)$/i.test(t)) continue;
      return t;
    }

    return 'Unknown Business';
  }

  // ── Tab mapping ─────────────────────────────────────────────────────────────
  const TAB_IDS_MAP = {
    'performance-tab-1':  'overview',
    'performance-tab-2':  'calls',
    'performance-tab-11': 'chat_clicks',
    'performance-tab-4':  'bookings',
    'performance-tab-5':  'directions',
    'performance-tab-6':  'website_clicks',
  };

  const TAB_TEXT_MAP = {
    'overview': 'overview', 'calls': 'calls',
    'chat clicks': 'chat_clicks', 'bookings': 'bookings',
    'directions': 'directions', 'website clicks': 'website_clicks',
  };

  function extractActiveTab() {
    const active = document.querySelector('[role="tab"][aria-selected="true"]');
    if (active) {
      if (TAB_IDS_MAP[active.id]) return TAB_IDS_MAP[active.id];
      return TAB_TEXT_MAP[active.textContent.trim().toLowerCase()] || null;
    }
    return null;
  }

  function extractDateRange() {
    // From the label button text e.g. "Mar 2026–Mar 2026"
    const label = document.querySelector('[jsname="M1BSlb"]');
    if (label) {
      const months = {Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12};
      const matches = [...label.textContent.matchAll(/([A-Z][a-z]+)\s+(\d{4})/g)];
      if (matches.length >= 1) {
        return {
          startMonth: months[matches[0][1]], startYear: parseInt(matches[0][2]),
          endMonth:   months[matches[matches.length-1][1]], endYear: parseInt(matches[matches.length-1][2]),
        };
      }
    }
    // From data-p: [[2026,3],[2026,3]]
    for (const el of document.querySelectorAll('[data-p]')) {
      const m = el.getAttribute('data-p')?.match(/\[\[(\d{4}),(\d{1,2})\],\[(\d{4}),(\d{1,2})\]\]/);
      if (m) return { startYear:+m[1], startMonth:+m[2], endYear:+m[3], endMonth:+m[4] };
    }
    return null;
  }

  function extractDailyData() {
    const table = document.querySelector('table[jsname="KRBEF"]');
    if (!table) return null;
    const daily = [];
    for (const row of table.querySelectorAll('tbody tr')) {
      const cells = row.querySelectorAll('td');
      if (cells.length >= 2) daily.push(parseInt(cells[1].textContent.trim().replace(/,/g, '')) || 0);
    }
    return daily.length ? { daily, total: daily.reduce((a,b)=>a+b,0) } : null;
  }

  function extractFromSVG() {
    const pts = document.querySelectorAll('.pKrx3d-JNdkSc');
    if (!pts.length) return null;
    const daily = [...pts].map(p => parseInt((p.querySelector('.pKrx3d-V67aGc')?.textContent || '0').replace(/,/g, '')) || 0);
    return { daily, total: daily.reduce((a,b)=>a+b,0) };
  }

  function extractTotalAndYoY() {
    const raw = document.querySelector('.mjluEf')?.textContent?.replace(/[,\s]/g, '') || '0';
    const total = parseInt(raw) || 0;
    const yoyText = document.querySelector('.Od3gu')?.textContent.trim()||'';
    const yoyMatch = yoyText.match(/([+-]?\d+\.?\d*)%/);
    return { total, yoyPercent: yoyMatch ? parseFloat(yoyMatch[1]) : null };
  }

  // ── Search impressions & profile views (Overview summary cards) ─────────
  // These are the two big-number summary cards shown below the main chart
  // on the Overview tab:
  //   "Searches showed your Business Profile in the search results" → searchImpressions
  //   "People viewed your Business Profile"                         → profileViews
  //
  // Strategy: walk all leaf text nodes looking for those label strings,
  // then look ±15 nearby nodes for an adjacent pure-number value.
  function extractSummaryMetrics() {
    const result = {};

    // (partial) label strings we accept, lowercased
    const patterns = [
      { keys: ['searches showed your business', 'search impressions', 'searches showed your'], field: 'searchImpressions' },
      { keys: ['people viewed your business',   'business profile views',  'viewed your business'],  field: 'profileViews'       },
    ];

    const leaves = [];
    const walk = (node) => {
      if (node.nodeType === 3 && node.textContent.trim()) leaves.push(node);
      else if (node.nodeType === 1) node.childNodes.forEach(walk);
    };
    walk(document.body);

    for (let i = 0; i < leaves.length; i++) {
      const text = leaves[i].textContent.trim().toLowerCase();
      for (const { keys, field } of patterns) {
        if (result[field]) continue;
        if (!keys.some(k => text.includes(k))) continue;

        // Matched the label — scan nearby leaf nodes for a standalone number
        for (let j = Math.max(0, i - 5); j < Math.min(leaves.length, i + 15); j++) {
          if (j === i) continue;
          const raw = leaves[j].textContent.trim();
          // Accept "12,345" or "12345" (no letters, at least 1 digit, no %)
          if (/^[\d,]+$/.test(raw) && raw.replace(/,/g, '').length >= 1) {
            const v = parseInt(raw.replace(/,/g, ''));
            if (v > 0) { result[field] = v; break; }
          }
        }
      }
    }

    return Object.keys(result).length > 0 ? result : null;
  }

  // ── Platform & device breakdown (donut chart legend) ──────────────────────
  function extractPlatformBreakdown() {
    const bd = { searchMobile: 0, searchDesktop: 0, mapsMobile: 0, mapsDesktop: 0 };

    // Map of lowercase label text → breakdown key
    const keyMap = {
      'google search – mobile':  'searchMobile',
      'google search - mobile':  'searchMobile',
      'google search \u2013 mobile': 'searchMobile',
      'google search – desktop': 'searchDesktop',
      'google search - desktop': 'searchDesktop',
      'google search \u2013 desktop': 'searchDesktop',
      'google maps – mobile':    'mapsMobile',
      'google maps - mobile':    'mapsMobile',
      'google maps \u2013 mobile': 'mapsMobile',
      'google maps – desktop':   'mapsDesktop',
      'google maps - desktop':   'mapsDesktop',
      'google maps \u2013 desktop': 'mapsDesktop',
    };

    // Collect all leaf text nodes
    const leaves = [];
    const walk = (node) => {
      if (node.nodeType === 3 && node.textContent.trim()) {
        leaves.push(node);
      } else if (node.nodeType === 1) {
        node.childNodes.forEach(walk);
      }
    };
    walk(document.body);

    for (let i = 0; i < leaves.length; i++) {
      const text = leaves[i].textContent.trim().toLowerCase();
      const key = keyMap[text];
      if (!key) continue;

      // Search nearby text nodes (±8) for a number like "4,407" or "4,407 · 74%"
      for (let j = Math.max(0, i - 8); j < Math.min(leaves.length, i + 8); j++) {
        const t = leaves[j].textContent.trim();
        const m = t.match(/^([\d,]+)\s*[·•\-–]?\s*\d*%?\s*$/);
        if (m) {
          const v = parseInt(m[1].replace(/,/g, ''));
          if (v > 0 && v !== bd[key]) { bd[key] = v; break; }
        }
      }
    }

    const total = Object.values(bd).reduce((s, v) => s + v, 0);
    return total > 0 ? bd : null;
  }

  // ── Known non-search-term strings to reject ─────────────────────────────────
  const SEARCH_TERM_BLACKLIST = new Set([
    'learn more','see more','see less','close','overview','calls','directions',
    'bookings','website clicks','chat clicks','website','performance','profile',
    'business profile interactions','business profile views',
    'people viewed your business profile',
    'searches showed your business profile in the search results',
    'searches showed your business profile',
    'platform and devices that people used to find your profile',
    'how people discovered your business profile',
    'how people found you on google',
    'searches breakdown','top searches',
    'google search – mobile','google search – desktop',
    'google search - mobile','google search - desktop',
    'google maps – mobile','google maps – desktop',
    'google maps - mobile','google maps - desktop',
  ]);

  function isValidSearchTerm(text) {
    if (!text || text.length < 2 || text.length > 80) return false;
    const lower = text.toLowerCase().trim();
    // Reject known UI labels
    if (SEARCH_TERM_BLACKLIST.has(lower)) return false;
    // Reject pure numbers
    if (/^[\d,]+$/.test(text)) return false;
    // Reject date patterns like "10 Apr", "1 April", "April 2025"
    if (/^\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(text)) return false;
    if (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{4}$/i.test(text)) return false;
    // Reject % strings
    if (/^[+-]?\d+\.?\d*%$/.test(text)) return false;
    // Reject strings that start with Google/Platform keywords
    if (/^(google\s+(search|maps)|platform|device)/i.test(text)) return false;
    return true;
  }

  // ── Search terms list (click "See more", scroll to section, extract) ────────
  async function extractSearchTerms() {
    // Step 1: Scroll to bottom to trigger lazy rendering of search terms section
    const scrollable = document.scrollingElement || document.documentElement || document.body;
    scrollable.scrollTop = scrollable.scrollHeight;
    await sleep(700);

    // Step 2: Find the "See more" button — it lives inside the search terms section.
    // Capture its nearest meaningful ancestor BEFORE clicking so we can search within it.
    const seeMoreBtn = [...document.querySelectorAll('button, [role="button"]')]
      .find(el => /^see more$/i.test(el.textContent.trim()));

    let searchContainer = null;
    if (seeMoreBtn) {
      // Walk up to find a container that already has a few sibling items (the initial 5 terms)
      let el = seeMoreBtn.parentElement;
      for (let d = 0; d < 8; d++) {
        if (!el) break;
        // A container with at least 3 direct children is likely the terms list wrapper
        if (el.querySelectorAll('li, tr, [role="row"], [role="listitem"]').length >= 2) {
          searchContainer = el;
          break;
        }
        el = el.parentElement;
      }
      // If no list rows found yet, just grab a parent a few levels up
      if (!searchContainer) {
        searchContainer = seeMoreBtn.parentElement?.parentElement?.parentElement || seeMoreBtn.parentElement;
      }
      realClick(seeMoreBtn);
      await sleep(2000); // wait for expanded list to fully render
    }

    const terms = [];

    // ── Strategy 1: extract from the captured container (most accurate) ──────
    if (searchContainer) {
      const rows = searchContainer.querySelectorAll('li, tr, [role="row"], [role="listitem"]');
      for (const row of rows) {
        const leaves = [...row.querySelectorAll('*')]
          .filter(el => el.childElementCount === 0 && el.textContent.trim().length > 0);
        if (leaves.length < 2) continue;
        const term  = leaves[0].textContent.trim();
        const last  = leaves[leaves.length - 1].textContent.trim().replace(/,/g, '');
        const count = parseInt(last);
        if (isValidSearchTerm(term) && !isNaN(count) && count > 0) {
          terms.push({ term, count });
        }
      }
    }

    // ── Strategy 2: find the searches section heading, walk its tree ──────────
    if (!terms.length) {
      const headingKeywords = [
        'searches breakdown', 'top searches', 'searches that showed',
        'searches for your business', 'search queries',
      ];
      const allLeaves = [...document.querySelectorAll('*')]
        .filter(el => el.childElementCount === 0 && el.textContent.trim().length < 60);
      const heading = allLeaves.find(el =>
        headingKeywords.some(kw => el.textContent.trim().toLowerCase().includes(kw))
      );
      if (heading) {
        let container = heading.parentElement;
        for (let d = 0; d < 8; d++) {
          if (!container) break;
          const rows = container.querySelectorAll('li, tr, [role="row"], [role="listitem"]');
          if (rows.length >= 2) {
            for (const row of rows) {
              const leaves = [...row.querySelectorAll('*')]
                .filter(el => el.childElementCount === 0 && el.textContent.trim().length > 0);
              if (leaves.length < 2) continue;
              const term  = leaves[0].textContent.trim();
              const last  = leaves[leaves.length - 1].textContent.trim().replace(/,/g, '');
              const count = parseInt(last);
              if (isValidSearchTerm(term) && !isNaN(count) && count > 0) {
                terms.push({ term, count });
              }
            }
            if (terms.length) break;
          }
          container = container.parentElement;
        }
      }
    }

    // ── Strategy 3: scan leaf-node pairs ONLY below the fold / near bottom ────
    // Only triggers if both above strategies fail. Much stricter than before:
    // requires the term to pass isValidSearchTerm AND the count to be isolated
    // (i.e. the count element's text is purely numeric, nothing else).
    if (!terms.length) {
      const allLeafEls = [...document.querySelectorAll('*')]
        .filter(el => el.childElementCount === 0 && el.textContent.trim().length > 0);
      for (let i = 0; i < allLeafEls.length - 1; i++) {
        const termEl  = allLeafEls[i];
        const countEl = allLeafEls[i + 1];
        const term     = termEl.textContent.trim();
        const countRaw = countEl.textContent.trim().replace(/,/g, '');
        const count    = parseInt(countRaw);
        // The count element must contain ONLY digits (possibly with commas)
        if (!isValidSearchTerm(term)) continue;
        if (!/^[\d,]+$/.test(countEl.textContent.trim())) continue;
        if (!isNaN(count) && count > 0 && count < 500000) {
          terms.push({ term, count });
          i++;
        }
      }
    }

    // Scroll back to top so the rest of the page looks normal
    scrollable.scrollTop = 0;

    // Deduplicate and sort
    const seen = new Set();
    const cleaned = terms.filter(t => {
      const k = t.term.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    console.log('[GBP] extractSearchTerms: found', cleaned.length, 'terms');
    return cleaned.sort((a, b) => b.count - a.count).slice(0, 50);
  }

  function extractCurrentPageData() {
    const tableData = extractDailyData();
    const svgData   = extractFromSVG();
    const { total, yoyPercent } = extractTotalAndYoY();
    const daily = tableData?.daily.length ? tableData.daily : (svgData?.daily || []);
    return {
      businessId:   extractBusinessId(),
      businessName: extractBusinessName(),
      metricType:   extractActiveTab(),
      dateRange:    extractDateRange(),
      daily,
      total: total || daily.reduce((a,b)=>a+b,0),
      yoyPercent,
    };
  }

  async function saveCurrentData() {
    const d = extractCurrentPageData();
    if (!d.businessId || !d.metricType || !d.dateRange || !d.daily.length)
      return { success: false, reason: `Missing: ${!d.businessId?'businessId ':''} ${!d.metricType?'metricType ':''} ${!d.dateRange?'dateRange ':''} ${!d.daily.length?'daily data':''}`.trim(), data: d };

    const { startYear, startMonth, endYear, endMonth } = d.dateRange;
    if (startYear !== endYear || startMonth !== endMonth)
      return { success: false, reason: 'Multi-month view — select a single month', data: d };

    // For the Overview tab: capture all supplemental data.
    // extractSearchTerms() may click "See more" so we await it here.
    const extra = {};
    if (d.metricType === 'overview') {
      // Platform & device breakdown (donut chart)
      const bd = extractPlatformBreakdown();
      if (bd) extra.breakdown = bd;

      // Search terms list (with "See more" expansion)
      const terms = await extractSearchTerms();
      if (terms.length) extra.searchTerms = terms;

      // Summary cards: "Searches showed your Business Profile" + "People viewed your Business Profile"
      const summary = extractSummaryMetrics();
      if (summary) {
        if (summary.searchImpressions) extra.searchImpressions = summary.searchImpressions;
        if (summary.profileViews)      extra.profileViews      = summary.profileViews;
      }
      console.log('[GBP] Overview extras captured:', { breakdown: !!bd, searchTerms: terms.length, summary });
    }

    // Route through background service worker so data is saved under the
    // extension origin — the same origin the dashboard reads from.
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({
        action: 'saveMetricData',
        business: { id: d.businessId, name: d.businessName },
        metric: {
          businessId: d.businessId,
          metricType: d.metricType,
          year:       startYear,
          month:      startMonth,
          total:      d.total,
          daily:      d.daily,
          yoyPercent: d.yoyPercent,
          extra
        }
      }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ success: false, reason: chrome.runtime.lastError.message });
        } else if (response && response.success) {
          resolve({ success: true, saved: response.saved });
        } else {
          resolve(response || { success: false, reason: 'No response from background' });
        }
      });
    });
  }

  // ── Click helper — works with Google's jsaction framework ──────────────────
  function realClick(el) {
    if (!el) return;
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles:true, cancelable:true }));
    el.dispatchEvent(new MouseEvent('mouseup',   { bubbles:true, cancelable:true }));
    el.dispatchEvent(new MouseEvent('click',     { bubbles:true, cancelable:true }));
  }

  // ── Date picker helpers ─────────────────────────────────────────────────────
  async function openDatePickerAndGetMonths() {
    const btn = document.querySelector('[jsname="sneIrb"]');
    if (!btn) return [];
    realClick(btn);
    await sleep(1200);

    // Scroll the picker container to its top AND bottom so that any lazily-rendered
    // month buttons (virtual scrolling) get added to the DOM before we query them.
    const scrollCandidates = [
      document.querySelector('.sVKzOc'),
      document.querySelector('[jsname="wCkObf"]'),
      document.querySelector('[role="listbox"]'),
      document.querySelector('[role="menu"]'),
    ].filter(Boolean);

    for (const sc of scrollCandidates) {
      if (sc.scrollHeight > sc.clientHeight) {
        sc.scrollTop = sc.scrollHeight; // scroll to bottom
        await sleep(300);
        sc.scrollTop = 0;              // scroll back to top
        await sleep(200);
        break;
      }
    }

    let btns = [...document.querySelectorAll('.HEmY3c')];
    if (!btns.length) btns = [...document.querySelectorAll('.sVKzOc [role="listitem"] button')];
    if (!btns.length) btns = [...document.querySelectorAll('[aria-label*="202"] button, button[data-index]')];
    console.log('[GBP] Date picker found', btns.length, 'month buttons');
    return btns;
  }

  async function closeDatePicker() {
    const cancel = document.querySelector('[jsname="gQ2Xie"]');
    if (cancel) { realClick(cancel); await sleep(400); }
  }

  // ── Core fetch logic (runs inside iframe) ───────────────────────────────────
  async function autoFetchAll(progressCb) {
    const report = { saved: 0, errors: [], skipped: 0 };

    const tabs = [...document.querySelectorAll('[role="tab"]')].filter(t => {
      const txt = t.textContent.trim();
      return txt && txt.length < 30;
    });

    if (!tabs.length) {
      report.errors.push('No [role="tab"] elements found in iframe DOM');
      return report;
    }

    const sampleMonths = await openDatePickerAndGetMonths();
    await closeDatePicker();
    const monthCount = sampleMonths.length;

    if (!monthCount) {
      report.errors.push('Date picker opened but no month buttons found (.HEmY3c)');
      return report;
    }

    progressCb?.(`Found ${tabs.length} tabs, ${monthCount} months`, 0, tabs.length * monthCount);
    let step = 0;

    for (const tab of tabs) {
      const tabName = tab.textContent.trim();
      progressCb?.(`Tab: ${tabName}`, step, tabs.length * monthCount);
      realClick(tab);
      await sleep(1800);

      for (let mi = 0; mi < monthCount; mi++) {
        step++;
        const monthBtns = await openDatePickerAndGetMonths();
        if (mi >= monthBtns.length) { await closeDatePicker(); continue; }

        const mb = monthBtns[mi];
        const label = mb.getAttribute('aria-label') || mb.textContent.trim();
        progressCb?.(`${tabName} → ${label}`, step, tabs.length * monthCount);

        realClick(mb);
        await sleep(400);

        const applyBtn = document.querySelector('[jsname="NA8k0d"]');
        if (!applyBtn) { await closeDatePicker(); continue; }
        realClick(applyBtn);
        await sleep(2800);

        try {
          const result = await saveCurrentData();
          if (result.success) {
            report.saved++;
            progressCb?.(`✓ ${label}: ${result.saved.total}`, step, tabs.length * monthCount);
          } else {
            report.skipped++;
            console.log('[GBP] Skipped:', result.reason, result.data);
          }
        } catch(e) {
          report.errors.push(`${tabName}/${label}: ${e.message}`);
        }
      }
    }

    progressCb?.(`Done! Saved ${report.saved}`, step, step);
    return report;
  }

  async function fetchCurrentTab(progressCb) {
    const report = { saved: 0, errors: [], skipped: 0 };
    const months = await openDatePickerAndGetMonths();
    await closeDatePicker();
    if (!months.length) { report.errors.push('No month buttons found'); return report; }

    for (let mi = 0; mi < months.length; mi++) {
      const btns = await openDatePickerAndGetMonths();
      if (mi >= btns.length) { await closeDatePicker(); continue; }
      const mb = btns[mi];
      const label = mb.getAttribute('aria-label') || mb.textContent.trim();
      progressCb?.(`→ ${label}`, mi+1, months.length);
      realClick(mb);
      await sleep(400);
      const apply = document.querySelector('[jsname="NA8k0d"]');
      if (!apply) { await closeDatePicker(); continue; }
      realClick(apply);
      await sleep(2800);
      try {
        const r = await saveCurrentData();
        r.success ? report.saved++ : report.skipped++;
      } catch(e) { report.errors.push(e.message); }
    }
    return report;
  }

  // ── Parse a month button label like "March 2026" → {year, month} ───────────
  function parseMonthLabel(label) {
    const months = { january:1, february:2, march:3, april:4, may:5, june:6,
                     july:7, august:8, september:9, october:10, november:11, december:12,
                     jan:1, feb:2, mar:3, apr:4, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
    const m = label?.toLowerCase().match(/([a-z]+)\s+(\d{4})/);
    if (!m) return null;
    const mo = months[m[1]];
    return mo ? { month: mo, year: parseInt(m[2]) } : null;
  }

  // ── Fetch only the months that are newer than what is already stored ────────
  async function fetchLatestData(progressCb) {
    const report = { saved: 0, errors: [], skipped: 0 };

    const businessId = extractBusinessId();
    if (!businessId) { report.errors.push('Could not detect business ID'); return report; }

    // Ask background for the latest stored month for this business
    const latest = await new Promise(resolve =>
      chrome.runtime.sendMessage({ action: 'getLatestMonth', businessId }, r => resolve(r?.latest || null))
    );

    // Get all available months from the date picker
    const allMonthBtns = await openDatePickerAndGetMonths();
    await closeDatePicker();

    if (!allMonthBtns.length) { report.errors.push('No month buttons found in date picker'); return report; }

    // Determine which months need fetching
    let btnsToFetch = allMonthBtns;
    if (latest) {
      const latestVal = latest.year * 12 + latest.month;
      btnsToFetch = allMonthBtns.filter(btn => {
        const parsed = parseMonthLabel(btn.getAttribute('aria-label') || btn.textContent.trim());
        if (!parsed) return false;
        return (parsed.year * 12 + parsed.month) > latestVal;
      });
    }

    if (!btnsToFetch.length) {
      progressCb?.('✓ Already up to date!', 1, 1);
      return report;
    }

    // Get all metric tabs
    const tabs = [...document.querySelectorAll('[role="tab"]')].filter(t =>
      t.textContent.trim() && t.textContent.trim().length < 30
    );
    if (!tabs.length) { report.errors.push('No metric tabs found'); return report; }

    const latestLabels = btnsToFetch.map(b => b.getAttribute('aria-label') || b.textContent.trim());
    progressCb?.(`Fetching ${latestLabels.length} new month(s) across ${tabs.length} tabs`, 0, tabs.length * latestLabels.length);
    let step = 0;

    for (const tab of tabs) {
      const tabName = tab.textContent.trim();
      realClick(tab);
      await sleep(1800);

      for (const targetLabel of latestLabels) {
        step++;
        // Re-open picker each iteration
        const freshBtns = await openDatePickerAndGetMonths();
        const matchBtn = freshBtns.find(b =>
          (b.getAttribute('aria-label') || b.textContent.trim()) === targetLabel
        );
        if (!matchBtn) { await closeDatePicker(); continue; }

        progressCb?.(`${tabName} → ${targetLabel}`, step, tabs.length * latestLabels.length);
        realClick(matchBtn);
        await sleep(400);
        const applyBtn = document.querySelector('[jsname="NA8k0d"]');
        if (!applyBtn) { await closeDatePicker(); continue; }
        realClick(applyBtn);
        await sleep(2800);
        try {
          const r = await saveCurrentData();
          r.success ? report.saved++ : report.skipped++;
          if (r.success) progressCb?.(`✓ Saved ${targetLabel}`, step, tabs.length * latestLabels.length);
        } catch(e) { report.errors.push(`${tabName}/${targetLabel}: ${e.message}`); }
      }
    }

    progressCb?.(`Done! Saved ${report.saved} new record(s)`, step, step);
    return report;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  REVIEW SCRAPING  (runs in the main frame — Maps / Search / business panel)
  // ══════════════════════════════════════════════════════════════════════════

  // Stable-ish id for an individual review when Google gives us no data-review-id.
  function hashReview(author, date, text) {
    const s = `${author}|${date}|${(text || '').slice(0, 120)}`;
    let h = 0;
    for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
    return 'h' + (h >>> 0).toString(36);
  }

  // Parse the leading star count from an aria-label like "5 stars" / "Rated 4.0".
  function parseStarLabel(label) {
    if (!label) return 0;
    const m = label.match(/([1-5](?:\.\d)?)\s*star/i) || label.match(/rated\s+([1-5](?:\.\d)?)/i);
    return m ? Math.round(parseFloat(m[1])) : 0;
  }

  // ── Resolve the document containing review cards ────────────────────────────
  // Maps renders cards in the top document; Search "all reviews" panel renders
  // them in a same-origin iframe. This helper finds the right document for both.
  const CARD_SEL = '.jftiEf, [data-review-id], [jscontroller][data-review-id], article.VaHEVc';
  const resolveReviewDoc = () => {
    if (document.querySelectorAll(CARD_SEL).length) return document;
    for (const f of document.querySelectorAll('iframe')) {
      let d;
      try { d = f.contentDocument; } catch (e) { continue; }
      if (d && d.querySelectorAll(CARD_SEL).length) return d;
    }
    return document;
  };


  // ── Snapshot: total reviews, average rating, 1–5 star distribution ──────────
  function extractReviewSnapshot(doc = resolveReviewDoc()) {
    const snap = { totalReviews: 0, avgRating: null, stars: {} };

    // Walk leaf text nodes once — reused for several heuristics.
    const leaves = [];
    const walk = (node) => {
      if (node.nodeType === 3 && node.textContent.trim()) leaves.push(node);
      else if (node.nodeType === 1) node.childNodes.forEach(walk);
    };
    walk(doc.body);

    // Total reviews — "1,234 reviews" / "(1,234)"
    for (const n of leaves) {
      const t = n.textContent.trim();
      let m = t.match(/^\(?\s*([\d,]+)\s*\)?\s+reviews?$/i) || t.match(/^([\d,]+)\s+reviews?$/i);
      if (m) { snap.totalReviews = parseInt(m[1].replace(/,/g, '')) || 0; break; }
    }
    // Fallback: a bare "(1,234)" right next to a rating
    if (!snap.totalReviews) {
      for (const n of leaves) {
        const m = n.textContent.trim().match(/^\(([\d,]{2,})\)$/);
        if (m) { snap.totalReviews = parseInt(m[1].replace(/,/g, '')) || 0; break; }
      }
    }

    // Average rating — a standalone number 0.0–5.0 (e.g. "4.5"), or from aria-label
    const ratingAria = doc.querySelector('[aria-label*="stars" i], [aria-label*="rated" i]');
    if (ratingAria) {
      const m = (ratingAria.getAttribute('aria-label') || '').match(/([0-5](?:\.\d)?)/);
      if (m) snap.avgRating = parseFloat(m[1]);
    }
    if (snap.avgRating == null) {
      for (const n of leaves) {
        const t = n.textContent.trim();
        if (/^[0-5]\.\d$/.test(t)) { snap.avgRating = parseFloat(t); break; }
      }
    }

    // Star distribution — histogram rows with aria-labels like
    // "5 stars, 1,234 reviews" or table rows. Try aria-labels first.
    for (const el of doc.querySelectorAll('[aria-label]')) {
      const m = el.getAttribute('aria-label').match(/([1-5])\s*stars?,?\s*([\d,]+)\s*reviews?/i);
      if (m) snap.stars[m[1]] = parseInt(m[2].replace(/,/g, '')) || 0;
    }

    const hasData = snap.totalReviews > 0 || snap.avgRating != null;
    return hasData ? snap : null;
  }

  // ── Convert relative date strings ("2 weeks ago") to YYYY-MM-DD ────────────
  function parseRelativeReviewDate(relStr, now = new Date()) {
    if (!relStr) return null;
    const s = relStr.trim();
    // Format from LOCAL date components (not toISOString, which shifts to UTC and
    // rolls the calendar day back/forward in non-UTC timezones).
    const ymd = (d) =>
      d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

    // Absolute: "June 2025" / "March 2024"
    const absMonth = s.match(/^([a-z]+)\s+(\d{4})$/i);
    if (absMonth) {
      const MONTHS = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
      const mo = MONTHS[absMonth[1].slice(0,3).toLowerCase()];
      if (mo !== undefined) return ymd(new Date(parseInt(absMonth[2]), mo, 1));
    }

    // Absolute: "March 12, 2024"
    const absDay = s.match(/^[a-z]+ \d{1,2},? \d{4}$/i);
    if (absDay) {
      const d = new Date(s);
      if (!isNaN(d)) return ymd(d);
    }

    // Relative: "N unit(s) ago"
    const rel = s.match(/^(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/i);
    if (rel) {
      const n = parseInt(rel[1]);
      const d = new Date(now);
      switch (rel[2].toLowerCase()) {
        case 'second': d.setSeconds(d.getSeconds() - n); break;
        case 'minute': d.setMinutes(d.getMinutes() - n); break;
        case 'hour':   d.setHours(d.getHours() - n); break;
        case 'day':    d.setDate(d.getDate() - n); break;
        case 'week':   d.setDate(d.getDate() - n * 7); break;
        case 'month':  d.setMonth(d.getMonth() - n); break;
        case 'year':   d.setFullYear(d.getFullYear() - n); break;
      }
      return ymd(d);
    }

    // "a week/month/year ago"
    const aRel = s.match(/^a\s+(week|month|year)\s+ago$/i);
    if (aRel) {
      const d = new Date(now);
      switch (aRel[1].toLowerCase()) {
        case 'week':  d.setDate(d.getDate() - 7); break;
        case 'month': d.setMonth(d.getMonth() - 1); break;
        case 'year':  d.setFullYear(d.getFullYear() - 1); break;
      }
      return ymd(d);
    }

    // Absolute: "7 Feb 2023" / "16 Nov 2024"  (Day Month Year)
    const dmy = s.match(/^(\d{1,2})\s+([a-z]+)\s+(\d{4})$/i);
    if (dmy) {
      const MONTHS = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
      const mo = MONTHS[dmy[2].slice(0,3).toLowerCase()];
      if (mo !== undefined) return ymd(new Date(parseInt(dmy[3]), mo, parseInt(dmy[1])));
    }

    return null;
  }

  // ── Individual review cards (scrolls the reviews list to lazy-load more) ─────
  // maxScrolls=80: each scroll loads ~10 reviews; "More reviews" pagination clicks
  // load the next batch (~100 reviews each) when scrolling alone stalls.
  // Covers up to maxReviews=1500 reviews before stopping (safety cap for businesses
  // with thousands of reviews). The no-growth streak exits early for small sets.
  // Trade-off: up to ~120s for very large sets vs. ~8s for ~80 reviews.

  // Wait until Google's loading spinner disappears (or timeout). Prevents the stall
  // detector from triggering mid-fetch — the main cause of premature termination on
  // the Search "all reviews" modal where each batch takes longer to load.
  async function waitForSpinner(doc, timeoutMs = 5000) {
    const SPINNER_SEL = [
      '.qjESne',               // Maps / Search modal spinner
      '.oBAxrc',               // alternate Maps spinner
      '[role="progressbar"]',
      '[aria-label="Loading"]',
      '[aria-label="Loading..."]',
      '.YbNNNb',
    ].join(', ');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try { if (!doc.querySelector(SPINNER_SEL)) return; } catch (e) { return; }
      await sleep(250);
    }
  }

  async function extractIndividualReviews(maxScrolls = 80, maxReviews = 1500) {
    const now = new Date();

    // Accumulator keyed by externalId. Harvested on every step because Google's
    // list is virtualized — cards are recycled out of the DOM as you scroll.
    const collected = new Map();

    // Re-resolve the review document on every harvest — "More reviews" clicks
    // can remount the iframe content, invalidating any cached doc reference.
    const harvestNow = () => {
      const d = resolveReviewDoc();
      for (const card of getReviewCards(d)) {
        const rev = extractReviewFromCard(card, now);
        if (rev && !collected.has(rev.externalId)) collected.set(rev.externalId, rev);
      }
      return d;
    };

    const randDelay = () => 1500 + Math.floor(Math.random() * 1000); // 1500–2500ms

    let doc = harvestNow();
    let lastSize = collected.size;
    let noGrowthStreak = 0;

    for (let s = 0; s < maxScrolls; s++) {
      if (collected.size >= maxReviews) break;

      // ── Primary scroll: scrollIntoView on the last card ──────────────────
      // Let the browser figure out which ancestor to scroll — bypasses Google's
      // nested div traps and works identically in Maps and the Search iframe.
      doc = resolveReviewDoc();
      const visible = getReviewCards(doc);
      if (visible.length) {
        const lastCard = visible[visible.length - 1];
        console.log(`[SCRAPER-DEBUG] step ${s}: scrollIntoView on last card`,
          lastCard.getAttribute('data-review-id') || lastCard.className.slice(0, 40));
        try {
          lastCard.scrollIntoView({ behavior: 'smooth', block: 'end' });
        } catch (e) { /* cross-origin guard */ }
      } else {
        // No cards visible — try scrolling the doc window directly as fallback
        console.log(`[SCRAPER-DEBUG] step ${s}: no cards visible, scrolling doc window`);
        try { doc.defaultView?.scrollTo(0, doc.body?.scrollHeight ?? 99999); } catch (e) {}
      }

      await sleep(randDelay());
      doc = harvestNow();
      let size = collected.size;
      console.log(`[SCRAPER-DEBUG] step ${s}: collected=${size} (was ${lastSize})`);

      if (size === lastSize) {
        // Stalled — wait for any in-flight spinner/fetch before declaring it
        await waitForSpinner(doc, 5000);
        doc = harvestNow();
        size = collected.size;

        if (size === lastSize) {
          // Still stalled — fire the "More reviews" pagination button
          console.log(`[SCRAPER-DEBUG] stall detected, attempting clickMoreReviews…`);
          const clicked = clickMoreReviews(doc);
          if (clicked) {
            await sleep(randDelay() + 1000); // extra budget for network fetch
            doc = resolveReviewDoc();        // doc may have remounted after click
            await waitForSpinner(doc, 6000);
            doc = harvestNow();
            size = collected.size;
            console.log(`[SCRAPER-DEBUG] post-click collected=${size}`);
          } else {
            console.log(`[SCRAPER-DEBUG] clickMoreReviews returned false — no button found`);
          }
        }

        if (size === lastSize) {
          noGrowthStreak++;
          console.log(`[SCRAPER-DEBUG] no-growth streak ${noGrowthStreak}/6`);
          if (noGrowthStreak >= 6) {
            console.log(`[SCRAPER-DEBUG] breaking — 6 consecutive stalls, final count=${collected.size}`);
            break;
          }
        } else {
          noGrowthStreak = 0;
        }
      } else {
        noGrowthStreak = 0;
      }
      lastSize = size;
    }

    harvestNow(); // final sweep for anything loaded after the last step
    console.log(`[SCRAPER-DEBUG] done — total collected=${collected.size}`);
    return [...collected.values()];
  }

  // Scrape reviews + snapshot, then persist via the background worker.
  async function collectReviews(progressCb) {
    const businessId = extractBusinessId();
    const businessName = extractBusinessName();
    if (!businessId) return { success: false, reason: 'Could not detect business ID on this page.' };

    const reviewDoc = resolveReviewDoc();

    progressCb?.('Reading review summary…', 0, 1);
    const snapshot = extractReviewSnapshot(reviewDoc);

    progressCb?.('Loading individual reviews…', 0, 1);
    let reviews = [];
    try { reviews = await extractIndividualReviews(); } catch (e) { console.warn('[GBP] review scrape:', e); }

    if (!snapshot && !reviews.length)
      return { success: false, reason: 'No review data found. Open the business’s Reviews on Google Maps, then try again.' };

    // Backfill star distribution from scraped cards if the histogram was missing.
    if (snapshot && Object.keys(snapshot.stars).length === 0 && reviews.length) {
      const dist = {};
      for (const r of reviews) if (r.rating >= 1 && r.rating <= 5) dist[r.rating] = (dist[r.rating] || 0) + 1;
      snapshot.stars = dist;
    }

    return new Promise((resolve) => {
      chrome.runtime.sendMessage({
        action: 'saveReviewData',
        business: { id: businessId, name: businessName },
        snapshot,
        reviews,
      }, (response) => {
        if (chrome.runtime.lastError) resolve({ success: false, reason: chrome.runtime.lastError.message });
        else resolve(response || { success: false, reason: 'No response from background' });
      });
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  IFRAME MODE — listen for commands from parent, execute fetch, report back
  // ══════════════════════════════════════════════════════════════════════════
  if (IS_PERFORMANCE_IFRAME) {
    console.log('[GBP] Iframe mode: Performance iframe detected');

    window.addEventListener('message', async (e) => {
      if (!e.data || e.data._tag !== EXT_TAG) return;
      const { action } = e.data;

      // Store business name supplied by the main frame — used by extractBusinessName()
      if (e.data.businessName) _parentBusinessName = e.data.businessName;

      const send = (type, payload) =>
        window.parent.postMessage({ _tag: EXT_TAG, type, ...payload }, '*');

      try {
        if (action === 'ping') {
          send('pong', {});
        } else if (action === 'saveCurrent') {
          const result = await saveCurrentData();
          send('saveResult', { result });
        } else if (action === 'fetchTab') {
          const report = await fetchCurrentTab((msg, cur, tot) =>
            send('progress', { msg, cur, tot })
          );
          send('done', { report });
        } else if (action === 'fetchAll') {
          const report = await autoFetchAll((msg, cur, tot) =>
            send('progress', { msg, cur, tot })
          );
          send('done', { report });
        } else if (action === 'fetchLatest') {
          const report = await fetchLatestData((msg, cur, tot) =>
            send('progress', { msg, cur, tot })
          );
          send('done', { report });
        }
      } catch(err) {
        console.error('[GBP] Message handler error:', err);
        send('error', { message: err.message });
      }
    });
    return; // don't inject panel UI inside iframe
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  MAIN FRAME MODE — show panel, relay commands to performance iframe
  // ══════════════════════════════════════════════════════════════════════════

  // ── Find the performance iframe ─────────────────────────────────────────
  function getPerformanceIframe() {
    return [...document.querySelectorAll('iframe')].find(f =>
      f.src && f.src.includes('performance') && f.src.includes('business')
    );
  }

  function sendToIframe(action, extra = {}) {
    const iframe = getPerformanceIframe();
    if (!iframe) return false;
    // Always pass the business name extracted from the main-frame DOM.
    // The main frame has much richer access (full page) than the iframe.
    const businessName = extractBusinessName();
    iframe.contentWindow.postMessage({ _tag: EXT_TAG, action, businessName, ...extra }, '*');
    return true;
  }

  // ── Inject floating panel ───────────────────────────────────────────────
  function injectPanel() {
    if (document.getElementById('gbp-stats-panel')) return;
    const panel = document.createElement('div');
    panel.id = 'gbp-stats-panel';
    panel.innerHTML = `
      <div class="gbp-stats-header">
        <svg width="18" height="18" viewBox="0 0 128 128"><rect width="128" height="128" rx="16" fill="#1a1a2e"/><polyline points="20,90 40,70 55,80 75,40 95,55 110,30" fill="none" stroke="#8ab4f8" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span>GBP Stats Collector</span>
        <button id="gbp-toggle">−</button>
      </div>
      <div id="gbp-body">
        <div id="gbp-info" style="font-size:11px;margin-bottom:8px;line-height:1.6">Searching for Performance panel...</div>
        <div class="gbp-stats-actions">
          <button id="gbp-update-latest">🔄 Update Latest Data</button>
          <button id="gbp-save-current">Save Current View</button>
          <button id="gbp-fetch-tab">Fetch All Months (Tab)</button>
          <button id="gbp-fetch-all">⭐ Fetch Everything</button>
          <button id="gbp-fetch-reviews">⭐ Fetch Reviews</button>
        </div>
        <div id="gbp-progress" style="display:none;margin-top:8px">
          <div class="gbp-progress-bar"><div class="gbp-progress-fill" id="gbp-progress-fill"></div></div>
          <div id="gbp-progress-text" style="font-size:10px;color:#999;margin-top:3px"></div>
        </div>
        <div id="gbp-result" style="display:none;margin-top:8px;padding:8px;background:#252536;border-radius:6px;font-size:11px"></div>
        <div class="gbp-stats-footer">
          <button id="gbp-open-dashboard">Open Dashboard</button>
        </div>
        <div style="text-align:center;padding:4px 0 2px;font-size:9px;color:#fff;letter-spacing:0.3px">
          v${chrome.runtime.getManifest().version} &nbsp;&middot;&nbsp; <span style="background:linear-gradient(90deg,#8ab4f8,#a78bfa);-webkit-background-clip:text;-webkit-text-fill-color:transparent;font-weight:700">ZixAI</span>
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    // Toggle
    document.getElementById('gbp-toggle').onclick = () => {
      const b = document.getElementById('gbp-body');
      const tog = document.getElementById('gbp-toggle');
      b.style.display = b.style.display === 'none' ? '' : 'none';
      tog.textContent = b.style.display === 'none' ? '+' : '−';
    };

    // Update latest (only new months since last fetch)
    document.getElementById('gbp-update-latest').onclick = () => {
      showProgress(true);
      setResult('', '');
      disableButtons(true);
      if (!sendToIframe('fetchLatest')) {
        showProgress(false);
        disableButtons(false);
        setResult('', '⚠ Performance iframe not found. Make sure you are on the Performance page.');
      }
    };

    // Save current
    document.getElementById('gbp-save-current').onclick = () => {
      setResult('Saving...', '');
      if (!sendToIframe('saveCurrent')) setResult('', '⚠ Performance iframe not found yet. Wait a moment and try again.');
    };

    // Fetch tab
    document.getElementById('gbp-fetch-tab').onclick = () => {
      showProgress(true);
      setResult('', '');
      disableButtons(true);
      if (!sendToIframe('fetchTab')) {
        showProgress(false);
        disableButtons(false);
        setResult('', '⚠ Performance iframe not found. Make sure you are on the Performance page.');
      }
    };

    // Fetch everything
    document.getElementById('gbp-fetch-all').onclick = () => {
      showProgress(true);
      setResult('', '');
      disableButtons(true);
      if (!sendToIframe('fetchAll')) {
        showProgress(false);
        disableButtons(false);
        setResult('', '⚠ Performance iframe not found. Make sure you are on the Performance page.');
      }
    };

    // Fetch reviews — scrapes review snapshot + individual reviews (main frame)
    document.getElementById('gbp-fetch-reviews').onclick = async () => {
      showProgress(true);
      setResult('', '');
      disableButtons(true);
      try {
        const result = await collectReviews((msg, cur, tot) => {
          const fill = document.getElementById('gbp-progress-fill');
          const text = document.getElementById('gbp-progress-text');
          if (fill) fill.style.width = (tot > 0 ? Math.round((cur / tot) * 100) : 30) + '%';
          if (text) text.textContent = msg;
        });
        if (result.success) {
          const s = result.saved || {};
          setResult('', `
            <div style="font-size:13px;font-weight:700;color:#81c995;margin-bottom:4px">✅ Reviews captured!</div>
            <div style="font-size:12px;color:#e0e0e0">${s.totalReviews != null ? `<strong>${s.totalReviews}</strong> on Google` : ''}${s.avgRating != null ? ` · ★ ${s.avgRating}` : ''}</div>
            <div style="font-size:11px;color:#aaa;margin-top:2px"><strong>${s.reviewsSaved || 0}</strong> reviews stored locally</div>
          `);
        } else {
          setResult('', `<span style="color:#fdd663">⚠ ${result.reason}</span>`);
        }
      } catch (e) {
        setResult('', `<span style="color:#fdd663">⚠ ${e.message}</span>`);
      } finally {
        showProgress(false);
        disableButtons(false);
        checkIframeAndUpdateInfo();
      }
    };

    // Open dashboard
    document.getElementById('gbp-open-dashboard').onclick = () => {
      chrome.runtime.sendMessage({ action: 'openDashboard' });
    };

    // Check iframe availability and update info label
    checkIframeAndUpdateInfo();
  }

  function checkIframeAndUpdateInfo() {
    const infoEl = document.getElementById('gbp-info');
    if (!infoEl) return;
    const iframe = getPerformanceIframe();
    if (iframe) {
      // Ask the background worker for stats — it uses the extension-origin DB
      chrome.runtime.sendMessage({ action: 'getStorageStats' }, (response) => {
        const stats = response?.stats || { totalBusinesses: 0, totalRecords: 0 };
        infoEl.innerHTML = `<span style="color:#81c995">✓ Performance panel found</span><br>
          <span style="color:#aaa">Stored: ${stats.totalBusinesses} businesses, ${stats.totalRecords} records</span>`;
      });
    } else if (isReviewablePage()) {
      infoEl.innerHTML = `<span style="color:#81c995">✓ Reviews page detected</span><br>
        <span style="color:#aaa">Click "Fetch Reviews" to capture review data</span>`;
      setTimeout(checkIframeAndUpdateInfo, 3000);
    } else {
      infoEl.innerHTML = `<span style="color:#fdd663">⏳ Waiting for Performance panel...</span><br>
        <span style="color:#aaa">Open Performance tab in GBP first</span>`;
      setTimeout(checkIframeAndUpdateInfo, 2000);
    }
  }

  function disableButtons(v) {
    ['gbp-update-latest','gbp-save-current','gbp-fetch-tab','gbp-fetch-all','gbp-fetch-reviews'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.disabled = v;
    });
  }

  function showProgress(v) {
    const el = document.getElementById('gbp-progress');
    if (el) el.style.display = v ? '' : 'none';
    if (!v && document.getElementById('gbp-progress-fill'))
      document.getElementById('gbp-progress-fill').style.width = '0%';
  }

  function setResult(msg, html) {
    const el = document.getElementById('gbp-result');
    if (!el) return;
    el.style.display = '';
    el.innerHTML = html || `<span style="color:#e0e0e0">${msg}</span>`;
  }

  // ── Listen for messages back from iframe ─────────────────────────────────
  window.addEventListener('message', (e) => {
    if (!e.data || e.data._tag !== EXT_TAG) return;
    const { type } = e.data;

    if (type === 'progress') {
      const { msg, cur, tot } = e.data;
      const pct = tot > 0 ? Math.round((cur/tot)*100) : 0;
      const fill = document.getElementById('gbp-progress-fill');
      const text = document.getElementById('gbp-progress-text');
      if (fill) fill.style.width = pct + '%';
      if (text) text.textContent = msg;

    } else if (type === 'done') {
      showProgress(false);
      disableButtons(false);
      const { report } = e.data;
      const errHtml = report.errors.map(err =>
        `<div style="color:#fdd663;font-size:10px;margin-top:2px">• ${err}</div>`
      ).join('');
      const skippedHtml = report.skipped
        ? `<div style="color:#aaa;font-size:10px;margin-top:2px">${report.skipped} skipped (already up to date)</div>`
        : '';
      setResult('', `
        <div style="font-size:13px;font-weight:700;color:#81c995;margin-bottom:4px">✅ Update Done!</div>
        <div style="font-size:12px;color:#e0e0e0">Saved <strong>${report.saved}</strong> new record${report.saved !== 1 ? 's' : ''}</div>
        ${skippedHtml}
        ${errHtml}
        <div style="font-size:10px;color:#666;margin-top:6px">Open the dashboard to see your updated data</div>
      `);
      checkIframeAndUpdateInfo();

    } else if (type === 'saveResult') {
      const { result } = e.data;
      if (result.success) {
        const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const label = `${MONTH_NAMES[result.saved.month-1]} ${result.saved.year}`;
        setResult('', `
          <div style="font-size:13px;font-weight:700;color:#81c995;margin-bottom:4px">✅ Saved!</div>
          <div style="font-size:12px;color:#e0e0e0">${result.saved.type} · ${label} · <strong>${result.saved.total}</strong> interactions</div>
        `);
      } else {
        setResult('', `<span style="color:#fdd663">⚠ ${result.reason}</span>`);
      }
      checkIframeAndUpdateInfo();
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  PER-LISTING BUTTONS  (inject under each GBP card in Maps/Search results)
  // ══════════════════════════════════════════════════════════════════════════
  // Defensive, class-light: a "card" is detected by the rating+review-count
  // pattern that every GBP result shows (e.g. "4.5 (1,390)"). Heavy logging so
  // selector drift is easy to diagnose from the page console.

  const GBP_ACTIONS_CLASS = 'gbp-zx-actions';
  const GBP_DONE_ATTR     = 'data-gbp-zx';

  function slugifyName(name) {
    return 'gbpx-' + (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  }

  // Pull {name, rating, count, placeUrl} out of a result card, with fallbacks.
  function extractCardData(card) {
    const text = card.innerText || '';

    // rating + count — "4.5(1,390)" / "4.5 \n (1,390)" / "4.5 stars 1,390 reviews"
    let rating = null, count = null;
    const rc = text.match(/([0-5](?:\.\d)?)\s*\(?\s*([\d,]{1,9})\s*\)?\s*(?:reviews?)?/i);
    const ratingMatch = text.match(/\b([0-5]\.\d)\b/);
    if (ratingMatch) rating = parseFloat(ratingMatch[1]);
    const countMatch = text.match(/\(([\d,]{1,9})\)/) || text.match(/([\d,]{2,9})\s+reviews?/i);
    if (countMatch) count = parseInt(countMatch[1].replace(/,/g, ''));
    if (rating == null && rc) rating = parseFloat(rc[1]);
    if (count == null && rc) count = parseInt(rc[2].replace(/,/g, ''));

    // name — heading-like element, else aria-label of the place link, else 1st line
    let name = '';
    const nameEl = card.querySelector(
      '.qBF1Pd, .fontHeadlineSmall, [role="heading"], a[aria-label]'
    );
    if (nameEl) name = (nameEl.getAttribute('aria-label') || nameEl.textContent || '').trim();
    if (!name || name.length < 2) {
      const firstLine = text.split('\n').map(s => s.trim()).filter(Boolean)[0];
      if (firstLine) name = firstLine;
    }

    // place / review link
    const link = card.querySelector('a[href*="/maps/place/"]') ||
                 card.querySelector('a[href*="/maps/"]') ||
                 (card.matches?.('a[href]') ? card : null);
    const placeUrl = link ? link.href : null;

    return { name: name.slice(0, 120), rating, count, placeUrl };
  }

  // Candidate card containers — try known wrappers, then a generic heuristic.
  function findListingCards() {
    const cards = new Set();

    // Known Maps result wrappers / place links
    document.querySelectorAll('div.Nv2PK, [role="article"], a.hfpxzc').forEach(el => {
      const card = el.closest('div.Nv2PK') || el.closest('[role="article"]') || el;
      if (card) cards.add(card);
    });

    // Generic fallback: any element holding a "(1,234)" near a rating, walked up
    // to a reasonably-sized container that also has a link.
    if (cards.size === 0) {
      const leaves = [...document.querySelectorAll('span, div')].filter(
        el => el.childElementCount === 0 && /\(\d[\d,]*\)/.test(el.textContent || '')
      );
      for (const leaf of leaves) {
        let el = leaf;
        for (let d = 0; d < 6 && el; d++) {
          if (el.querySelector?.('a[href*="/maps/"], a[href]') &&
              (el.innerText || '').length < 400) { cards.add(el); break; }
          el = el.parentElement;
        }
      }
    }
    return [...cards];
  }

  function injectListingButtons() {
    const cards = findListingCards();
    let injected = 0;
    for (const card of cards) {
      if (card.getAttribute(GBP_DONE_ATTR)) continue;
      const data = extractCardData(card);
      // Only inject where we can identify a business with review data
      if (!data.name || (data.count == null && data.rating == null)) continue;
      card.setAttribute(GBP_DONE_ATTR, '1');

      const bar = document.createElement('div');
      bar.className = GBP_ACTIONS_CLASS;
      bar.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin:6px 0 2px;padding:4px 0';
      bar.innerHTML = `
        <button type="button" class="gbp-zx-btn gbp-zx-review" style="${BTN_CSS}">⭐ Review</button>
        <button type="button" class="gbp-zx-btn gbp-zx-open" style="${BTN_CSS}">🔗 Open reviews</button>
      `;
      bar.querySelector('.gbp-zx-review').addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        onListingReviewClick(card, e.currentTarget);
      });
      bar.querySelector('.gbp-zx-open').addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        const d = extractCardData(card);
        if (d.placeUrl) openReviewTab(d.placeUrl, d.name);
      });

      // Place the bar safely: never inside an <a> (would nest interactive els
      // and risk triggering navigation) — insert right after it instead.
      if (card.tagName === 'A') card.insertAdjacentElement('afterend', bar);
      else card.appendChild(bar);
      injected++;
    }
    if (injected) console.log(`[GBP] Injected listing buttons on ${injected} card(s)`);
  }

  const BTN_CSS = 'font:600 11px system-ui;cursor:pointer;border:1px solid #c98a3a;background:#fff3e0;color:#a85a00;border-radius:6px;padding:3px 8px;line-height:1.4';

  // Capture the snapshot visible in the card and send it; then best-effort open
  // the review link in a new tab to scrape individual reviews.
  function onListingReviewClick(card, btn) {
    const d = extractCardData(card);
    console.log('[GBP] Listing review click:', d);
    if (!d.name) { flashBtn(btn, '⚠ no name'); return; }

    const cid = extractCidFromUrl(d.placeUrl);
    const businessId = cid || slugifyName(d.name);
    const snapshot = {
      totalReviews: d.count || 0,
      avgRating:    d.rating != null ? d.rating : null,
      stars:        {},
    };

    chrome.runtime.sendMessage({
      action: 'saveReviewData',
      business: { id: businessId, name: d.name },
      isOwn: false,                 // listing in results → treat as tracked/competitor
      snapshot,
      reviews: [],
    }, (resp) => {
      if (chrome.runtime.lastError) { flashBtn(btn, '⚠ err'); return; }
      flashBtn(btn, resp && resp.success ? `✓ ${d.count ?? ''}★${d.rating ?? ''}` : '⚠');
    });

    // Best-effort: open the place's reviews to scrape individual reviews
    if (d.placeUrl) openReviewTab(d.placeUrl, d.name);
  }

  function flashBtn(btn, label) {
    if (!btn) return;
    const orig = btn.textContent;
    btn.textContent = label;
    setTimeout(() => { btn.textContent = orig; }, 2500);
  }

  // Ask the background worker to open the place URL in a new tab flagged for
  // auto-scrape. The content script on that tab (see auto-scrape hook in init)
  // detects the flag, scrapes reviews, and sends them.
  function openReviewTab(placeUrl, name) {
    try {
      const u = new URL(placeUrl, location.href);
      u.hash = 'gbpx-scrape=' + encodeURIComponent(name || '');
      chrome.runtime.sendMessage({ action: 'openReviewTab', url: u.toString() });
    } catch (e) { console.warn('[GBP] openReviewTab failed:', e); }
  }

  // Auto-scrape hook: if THIS page was opened with the #gbpx-scrape flag, wait
  // for the reviews panel and scrape individual reviews for that business.
  async function maybeAutoScrapeReviews() {
    const m = (location.hash || '').match(/gbpx-scrape=([^&]*)/);
    if (!m) return;
    const name = decodeURIComponent(m[1] || '');
    console.log('[GBP] Auto-scrape reviews flagged for:', name);
    // Let the place panel render, then try to open the reviews list
    await sleep(2500);
    await openReviewsPanel();
    const reviews = await extractIndividualReviews().catch(() => []);
    const snap = extractReviewSnapshot();
    if (!reviews.length && !snap) { console.log('[GBP] Auto-scrape: nothing found'); return; }
    chrome.runtime.sendMessage({
      action: 'saveReviewData',
      business: { id: extractBusinessId() || slugifyName(name), name },
      isOwn: false,
      snapshot: snap,
      reviews,
    }, () => console.log(`[GBP] Auto-scrape sent ${reviews.length} reviews for ${name}`));
  }

  // ── Distinct review-id counter (collapses over-matched CARD_SEL duplicates) ──
  function countDistinctReviews(doc) {
    const ids = new Set();
    doc.querySelectorAll('[data-review-id]').forEach(el => {
      const id = el.getAttribute('data-review-id');
      if (id) ids.add(id);
    });
    return ids.size || doc.querySelectorAll(CARD_SEL).length;
  }

  // ── Outermost review card getter (no over-matching nested [data-review-id]) ─
  // Prefer Google's own per-review id attribute — it is far more stable than the
  // CSS class names (.jftiEf etc.), which Google rotates frequently. Returns the
  // OUTERMOST data-review-id elements (excludes nested ones, which inflate counts
  // ~10x). Falls back to the known card classes only when no data-review-id at all
  // is present in the document.
  function getReviewCards(doc) {
    const byId = [...doc.querySelectorAll('[data-review-id]')]
      .filter(el => !el.parentElement?.closest('[data-review-id]'));
    if (byId.length) return byId;
    return [...doc.querySelectorAll('.jftiEf, article.VaHEVc')];
  }

  // ── Extract one review object from a card element (null if not a real review) ─
  // Selectors carry Maps + Search/GBP-panel variants with generic fallbacks.
  // Rating is read from an aria-label (robust to class rotation); the card is
  // kept if it has either a rating OR text.
  function extractReviewFromCard(card, now) {
    const author =
      card.querySelector('.d4r55, .PskQHd, [class*="title"]')?.textContent?.trim() ||
      card.getAttribute('aria-label') || '';

    const ratingEl = card.querySelector('[aria-label*="star" i], [role="img"][aria-label]');
    const rating = parseStarLabel(ratingEl?.getAttribute('aria-label') || '');

    const text = card.querySelector('.wiI7pd, .Fv38Af, .MyEned, [class*="reviewText"]')?.textContent?.trim() || '';

    const dateRaw = card.querySelector('.rsqaWe, .KEfuhb, .dehysf, [class*="date"]')?.textContent?.trim() || '';
    const reviewedAtISO = parseRelativeReviewDate(dateRaw, now);

    const contributorText = card.querySelector('.RfnDt, .WEBjve, [class*="contributor"]')?.textContent?.trim() || '';
    const countMatch = contributorText.match(/(\d+)\s+reviews?/i);
    const authorReviewCount = countMatch ? parseInt(countMatch[1]) : null;

    const isLocalGuide = /local guide/i.test(card.textContent);
    const hasPhoto = !!card.querySelector('img[src*="googleusercontent"], button[aria-label*="Photo" i]');

    const ownerResponded = !!(
      card.querySelector('.CDe7pd, [class*="ownerResponse"], [class*="owner-response"]') ||
      /response from the owner/i.test(card.textContent)
    );

    if (!rating && !text) return null;
    const externalId = card.getAttribute('data-review-id') || hashReview(author, dateRaw, text);

    return {
      externalId,
      rating,
      text: text.slice(0, 5000),
      author: author.slice(0, 200),
      authorReviewCount,
      isLocalGuide,
      hasPhoto,
      ownerResponded,
      reviewedAt: dateRaw,
      reviewedAtISO,
    };
  }

  // ── Scrollable-ancestor finder (cross-document / iframe safe) ─────────────
  function findScrollableAncestor(el) {
    if (!el) return null;
    const win = el.ownerDocument.defaultView || window;
    let node = el.parentElement;
    while (node && node !== document.body) {
      try {
        const st = win.getComputedStyle(node);
        if ((st.overflowY === 'auto' || st.overflowY === 'scroll') &&
            node.scrollHeight > node.clientHeight + 20) {
          return node;
        }
      } catch (e) { /* cross-origin frame — skip */ }
      node = node.parentElement;
    }
    return null;
  }

  // ── "More reviews" button clicker (pagination past the ~100-review lazy-load cap) ─
  // Uses a broad contains-match so "More reviews (1,434)", "Load more reviews",
  // "See all reviews" etc. all match regardless of surrounding text or count suffix.
  // Dispatches a full pointer+mouse synthetic event chain so Google's jsaction
  // framework registers the interaction even when .click() is swallowed.
  // Returns true if an element was found and fired, false otherwise. Never throws.
  function clickMoreReviews(doc) {
    try {
      const EXCLUDE_RE = /get more reviews|reply to reviews|write a review|share/i;

      // Walk ALL elements — the "More Reviews" text is often inside an
      // aria-hidden span (e.g. jsname="V67aGc") nested inside the real button.
      // We match on text content of any element, then climb to the nearest
      // interactive ancestor to fire the click there.
      const findMoreSpan = (searchDoc) => {
        try {
          return [...searchDoc.querySelectorAll('*')].find(el => {
            // Only look at leaf-ish nodes to avoid matching ancestor containers
            if (el.children.length > 3) return false;
            const txt = (el.textContent || '').trim().toLowerCase();
            return txt.includes('review') &&
                   (txt.includes('more') || txt.includes('all') || txt.includes('load')) &&
                   !EXCLUDE_RE.test(txt);
          });
        } catch (_) { return null; }
      };

      // Walk up from the matched span to find the real clickable ancestor
      const findClickTarget = (el) => {
        if (!el) return null;
        let node = el;
        while (node && node !== document.body) {
          const tag = node.tagName?.toLowerCase();
          if (tag === 'button' || tag === 'a') return node;
          const role = node.getAttribute('role');
          if (role === 'button' || role === 'link') return node;
          if (node.getAttribute('jsaction')) return node;
          node = node.parentElement;
        }
        return el; // fallback: click the span itself
      };

      let span = findMoreSpan(doc);
      if (!span && doc !== document) {
        try { span = findMoreSpan(document); } catch (_) {}
      }

      if (!span) {
        console.log('[SCRAPER-DEBUG] clickMoreReviews: no matching element found in DOM');
        return false;
      }

      const target = findClickTarget(span);
      console.log('[SCRAPER-DEBUG] clickMoreReviews: span text=',
        JSON.stringify((span.textContent || '').trim().slice(0, 80)),
        '→ clicking', target.tagName,
        target.getAttribute('jsaction')?.slice(0, 60) || target.className?.slice(0, 40));

      // Full synthetic event chain so Google's jsaction framework registers it
      const opts = { bubbles: true, cancelable: true, composed: true };
      target.dispatchEvent(new PointerEvent('pointerdown', opts));
      target.dispatchEvent(new MouseEvent('mousedown',     opts));
      target.dispatchEvent(new MouseEvent('mouseup',       opts));
      target.dispatchEvent(new MouseEvent('click',         opts));
      target.click(); // native .click() as final fallback
      return true;
    } catch (e) {
      console.warn('[GBP] clickMoreReviews:', e);
      return false;
    }
  }

  // Try to click into the Reviews tab/section of an open Maps place panel.
  async function openReviewsPanel() {
    try {
      // Match plain "Reviews" tab AND "More reviews (N)" place-panel link
      const btn = [...document.querySelectorAll('button, [role="tab"], a')]
        .find(el => /^(?:reviews?|more reviews)\b/i.test((el.getAttribute('aria-label') || el.textContent || '').trim()));
      if (!btn) return;

      const doc = resolveReviewDoc();
      const beforeCount = countDistinctReviews(doc);

      // Native click first (proved to work in live probe), then synthetic belt-and-suspenders
      btn.click();
      realClick(btn);
      await sleep(2000);

      // Verify the panel actually opened; retry once if not
      const afterCount = countDistinctReviews(resolveReviewDoc());
      if (afterCount <= beforeCount) {
        btn.click();
        realClick(btn);
        await sleep(2000);
      }
    } catch (e) {
      console.warn('[GBP] openReviewsPanel:', e);
    }
  }

  // ── Init: inject panel when performance page is detected ──────────────────
  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(()=>fn(...a), ms); }; }

  function isPerformancePage() {
    return window.location.href.includes('/performance') ||
           !!getPerformanceIframe() ||
           document.body?.innerText?.includes('Business Profile interactions') ||
           document.body?.innerText?.includes('Calls made from your') ||
           !!document.querySelector('[id*="performance-tab"]');
  }

  // A page where reviews can be scraped: a Maps place / business panel with a
  // detectable business id and a review count visible on the page.
  function isReviewablePage() {
    if (!extractBusinessId()) return false;
    const href = window.location.href;
    // Explicit reviews URL patterns (Search "all reviews" panel, GBP customers tab)
    if (/#mpd=/.test(href) || /\/customers\/reviews/.test(href)) return true;
    return /\breviews?\b/i.test(document.body?.innerText || '') &&
           (href.includes('/maps/') ||
            href.includes('business.google.com') ||
            !!document.querySelector('[aria-label*="stars" i], [data-review-id]'));
  }

  // Maps/Search results page where per-listing buttons make sense.
  function isResultsPage() {
    return /\/maps\/search\//.test(location.href) ||
           /\/maps\//.test(location.href) ||
           (/google\.[a-z.]+\/search/.test(location.href) && /\(\d[\d,]*\)/.test(document.body?.innerText || ''));
  }

  async function init() {
    const tryInject = () => {
      if ((isPerformancePage() || isReviewablePage()) && !document.getElementById('gbp-stats-panel')) {
        injectPanel();
      }
      // Per-listing buttons on Maps/Search results
      if (isResultsPage()) {
        try { injectListingButtons(); } catch (e) { console.warn('[GBP] injectListingButtons error:', e); }
      }
    };
    // Try at multiple intervals (GBP modal opens lazily)
    [800, 2000, 4000, 7000].forEach(ms => setTimeout(tryInject, ms));

    const debouncedCheck = debounce(tryInject, 500);
    new MutationObserver(debouncedCheck).observe(document.documentElement, { childList: true, subtree: true });

    // If this tab was opened by an "Open reviews"/Review click, auto-scrape.
    if (location.hash.includes('gbpx-scrape=')) {
      maybeAutoScrapeReviews().catch(e => console.warn('[GBP] auto-scrape error:', e));
    }
  }

  if (!IS_IFRAME || IS_DIRECT_PERFORMANCE) {
    init();
  }
})();
