/**
 * Dashboard JS — Full analytics dashboard
 * Features: 12-month view, SVG charts, historical comparison, business switcher
 */

(() => {
  'use strict';

  const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const MONTH_FULL = ['January','February','March','April','May','June','July','August','September','October','November','December'];

  // ── State ──
  let state = {
    businessId: null,
    metricType: 'overview',
    startYear: null, startMonth: null,
    endYear: null, endMonth: null,
    dpStart: null, dpEnd: null, dpSelecting: false,
    // Comparison
    compareEnabled: false,
    compareMode: 'yoy',           // 'yoy' | 'prev' | 'custom'
    compareYear: null, compareMonth: null,  // for 'custom' mode
    // Cached data
    currentData: [],
    compareData: null,            // single metric (custom mode)
    comparePeriodData: [],        // array of metrics (yoy/prev modes)
    allMonths: [],
  };

  // ── Init ──
  document.addEventListener('DOMContentLoaded', async () => {
    await GBPStorage.open();
    bindEvents();
    await loadBusinesses();

    // Check URL params for pre-selected business
    const params = new URLSearchParams(window.location.search);
    const bizParam = params.get('business');
    if (bizParam) {
      document.getElementById('businessSelect').value = bizParam;
      await selectBusiness(bizParam);
    }
  });

  // ── Event Binding ──
  function bindEvents() {
    // Business switcher
    document.getElementById('businessSelect').addEventListener('change', (e) => {
      selectBusiness(e.target.value);
    });

    // Metric tabs
    document.getElementById('metricTabs').addEventListener('click', (e) => {
      const tab = e.target.closest('.metric-tab');
      if (!tab) return;
      document.querySelectorAll('.metric-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      state.metricType = tab.dataset.metric;
      loadMetricData();
    });

    // Date picker
    document.getElementById('datePickerBtn').addEventListener('click', toggleDatePicker);
    document.getElementById('dpCancel').addEventListener('click', closeDatePicker);
    document.getElementById('dpApply').addEventListener('click', applyDatePicker);

    // Close date picker on outside click
    document.addEventListener('click', (e) => {
      const wrap = document.querySelector('.date-picker-wrap');
      if (!wrap.contains(e.target)) closeDatePicker();
    });

    // Compare toggle
    document.getElementById('compareToggle').addEventListener('change', async (e) => {
      state.compareEnabled = e.target.checked;
      document.getElementById('compareModes').style.display = state.compareEnabled ? '' : 'none';
      document.getElementById('compareCard').style.display = state.compareEnabled ? '' : 'none';
      if (state.compareEnabled) {
        await loadComparePeriodData();
        updateCompareCard();
      } else {
        state.compareData = null;
        state.comparePeriodData = [];
      }
      renderChart();
    });

    // Compare mode buttons
    document.getElementById('compareModes').addEventListener('click', async (e) => {
      const btn = e.target.closest('.cmp-mode-btn');
      if (!btn) return;
      document.querySelectorAll('.cmp-mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.compareMode = btn.dataset.mode;
      // Show/hide custom month select
      const customWrap = document.getElementById('customMonthWrap');
      customWrap.style.display = state.compareMode === 'custom' ? '' : 'none';
      if (state.compareMode === 'custom') populateCompareSelect();
      await loadComparePeriodData();
      renderChart();
      updateCompareCard();
    });

    // Compare month select (custom mode)
    document.getElementById('compareMonth').addEventListener('change', async (e) => {
      const val = e.target.value;
      if (!val) return;
      const [y, m] = val.split('-').map(Number);
      state.compareYear = y;
      state.compareMonth = m;
      await loadComparePeriodData();
      renderChart();
      updateCompareCard();
    });

    // Sync button
    document.getElementById('syncBtn').addEventListener('click', onSyncClick);

    // Export / Import
    document.getElementById('exportBtn').addEventListener('click', exportData);
    document.getElementById('importBtn').addEventListener('click', () => {
      document.getElementById('importFile').click();
    });
    document.getElementById('importFile').addEventListener('change', importData);

    // Business management
    document.getElementById('addBizBtn').addEventListener('click', () => openBizModal(null));
    document.getElementById('editBizBtn').addEventListener('click', () => openBizModal(state.businessId));
    document.getElementById('bizModalClose').addEventListener('click', closeBizModal);
    document.getElementById('bizModalCancel').addEventListener('click', closeBizModal);
    document.getElementById('bizModalSave').addEventListener('click', saveBizModal);
    document.getElementById('bizDeleteBtn').addEventListener('click', deleteBizModal);
    document.getElementById('bizModal').addEventListener('click', (e) => {
      if (e.target === document.getElementById('bizModal')) closeBizModal();
    });

    // Date picker clear
    document.getElementById('dpClear').addEventListener('click', (e) => {
      e.stopPropagation();
      const now = new Date();
      state.dpStart = { year: now.getFullYear(), month: now.getMonth() + 1 };
      state.dpEnd = { year: now.getFullYear(), month: now.getMonth() + 1 };
      state.dpSelecting = false;
      renderDatePickerMonths();
      updateDpHint();
    });

    // Quick preset buttons
    document.getElementById('datePickerDropdown').querySelectorAll('.dp-preset-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const months = parseInt(btn.dataset.months);
        const now = new Date();
        const endY = now.getFullYear();
        const endM = now.getMonth() + 1;
        let startY = endY, startM = endM - (months - 1);
        while (startM <= 0) { startM += 12; startY--; }
        state.dpStart = { year: startY, month: startM };
        state.dpEnd = { year: endY, month: endM };
        state.dpSelecting = false;
        renderDatePickerMonths();
        updateDpHint();
      });
    });

    // Insights refresh
    document.getElementById('refreshInsightsBtn').addEventListener('click', generateInsights);
  }

  // ── Business Loading ──
  async function loadBusinesses() {
    const businesses = await GBPStorage.getAllBusinesses();
    const select = document.getElementById('businessSelect');
    // Clear existing options except the first
    while (select.options.length > 1) select.remove(1);

    for (const biz of businesses) {
      const opt = document.createElement('option');
      opt.value = biz.id;
      opt.textContent = biz.name || biz.id;
      select.appendChild(opt);
    }

    document.getElementById('editBizBtn').style.display = businesses.length ? '' : 'none';

    if (!businesses.length) {
      document.getElementById('emptyState').style.display = '';
      document.getElementById('dashboard').style.display = 'none';
    } else if (businesses.length === 1 && !state.businessId) {
      // Auto-select the only business
      document.getElementById('businessSelect').value = businesses[0].id;
      await selectBusiness(businesses[0].id);
    } else if (businesses.length > 1 && !state.businessId) {
      // Auto-select the most recently updated business
      const recent = businesses.sort((a,b) => (b.lastUpdated||0) - (a.lastUpdated||0))[0];
      document.getElementById('businessSelect').value = recent.id;
      await selectBusiness(recent.id);
    }
  }

  async function selectBusiness(businessId) {
    if (!businessId) {
      document.getElementById('dashboard').style.display = 'none';
      document.getElementById('emptyState').style.display = '';
      return;
    }

    state.businessId = businessId;
    document.getElementById('emptyState').style.display = 'none';
    document.getElementById('dashboard').style.display = '';

    // Determine available date range
    const range = await GBPStorage.getOldestAndNewest(businessId);
    if (range) {
      // Default: show last 12 months or all available data
      const now = new Date();
      state.endYear = now.getFullYear();
      state.endMonth = now.getMonth() + 1;
      // Go back 11 months for 12-month view
      let sy = state.endYear;
      let sm = state.endMonth - 11;
      if (sm <= 0) { sm += 12; sy--; }
      state.startYear = sy;
      state.startMonth = sm;
    } else {
      const now = new Date();
      state.endYear = now.getFullYear();
      state.endMonth = now.getMonth() + 1;
      state.startYear = state.endYear;
      state.startMonth = state.endMonth;
    }

    await loadMetricData();
    renderCoverageGrid();
    await checkSyncStatus();
    generateInsights();
    renderDiscoverySection();
  }

  // ── Metric Data Loading ──
  async function loadMetricData() {
    if (!state.businessId) return;

    state.allMonths = await GBPStorage.getAvailableMonths(state.businessId, state.metricType);

    // If current metric has no data at all, auto-switch to first metric that does
    if (!state.allMonths.length) {
      for (const mt of GBPStorage.METRIC_TYPES) {
        const months = await GBPStorage.getAvailableMonths(state.businessId, mt);
        if (months.length) {
          state.metricType = mt;
          state.allMonths = months;
          // Update active tab in UI
          document.querySelectorAll('.metric-tab').forEach(t => {
            t.classList.toggle('active', t.dataset.metric === mt);
          });
          break;
        }
      }
    }

    state.currentData = await GBPStorage.getMetricsForRange(
      state.businessId, state.metricType,
      state.startYear, state.startMonth,
      state.endYear, state.endMonth
    );

    updateDateLabel();
    updateStatsCard();
    renderChart();
    renderDataTable();
    renderCoverageGrid();

    if (state.compareEnabled) {
      if (state.compareMode === 'custom') populateCompareSelect();
      await loadComparePeriodData();
      updateCompareCard();
    }
    generateInsights();
    renderDiscoverySection();
  }

  // ── Unified compare data loader ──────────────────────────────────────────
  async function loadComparePeriodData() {
    state.compareData = null;
    state.comparePeriodData = [];
    if (!state.businessId || !state.compareEnabled) return;

    if (state.compareMode === 'custom') {
      if (!state.compareYear || !state.compareMonth) return;
      state.compareData = await GBPStorage.getMetric(
        state.businessId, state.metricType,
        state.compareYear, state.compareMonth
      );
      return;
    }

    // Compute comparison period start/end
    const { cStartY, cStartM, cEndY, cEndM } = getComparePeriodBounds();
    state.comparePeriodData = await GBPStorage.getMetricsForRange(
      state.businessId, state.metricType,
      cStartY, cStartM, cEndY, cEndM
    );
  }

  function getComparePeriodBounds() {
    const sVal = state.startYear * 12 + state.startMonth;
    const eVal = state.endYear * 12 + state.endMonth;
    const span = eVal - sVal; // months span (0 = single month)

    let cStartM, cStartY, cEndM, cEndY;

    if (state.compareMode === 'yoy') {
      // Same months, one year earlier
      cStartY = state.startYear - 1; cStartM = state.startMonth;
      cEndY   = state.endYear - 1;   cEndM   = state.endMonth;
    } else {
      // Previous period: shift back by (span + 1) months
      const shift = span + 1;
      let sm = state.startMonth - shift;
      let sy = state.startYear;
      while (sm <= 0) { sm += 12; sy--; }
      let em = state.endMonth - shift;
      let ey = state.endYear;
      while (em <= 0) { em += 12; ey--; }
      cStartY = sy; cStartM = sm;
      cEndY = ey;   cEndM = em;
    }
    return { cStartY, cStartM, cEndY, cEndM };
  }

  // ── Sync Status ──────────────────────────────────────────────────────────
  async function checkSyncStatus() {
    if (!state.businessId) return;
    const syncWrap = document.getElementById('syncWrap');
    const syncStatus = document.getElementById('syncStatus');
    syncWrap.style.display = '';

    const range = await GBPStorage.getOldestAndNewest(state.businessId);
    if (!range) {
      syncStatus.textContent = 'No data';
      syncStatus.className = 'sync-status outdated';
      return;
    }

    const now = new Date();
    const curY = now.getFullYear();
    const curM = now.getMonth() + 1;
    const newestVal = range.newest.year * 12 + range.newest.month;
    const curVal    = curY * 12 + curM;
    const behind    = curVal - newestVal;

    if (behind === 0) {
      syncStatus.textContent = '✓ Up to date';
      syncStatus.className = 'sync-status up-to-date';
    } else {
      const label = behind === 1 ? '1 month behind' : `${behind} months behind`;
      syncStatus.textContent = `⚠ ${label}`;
      syncStatus.className = 'sync-status outdated';
    }
  }

  function onSyncClick() {
    const btn = document.getElementById('syncBtn');
    btn.classList.add('spinning');
    setTimeout(() => btn.classList.remove('spinning'), 800);
    showSyncModal();
  }

  function showSyncModal() {
    // Reuse the business modal overlay with sync instructions
    const biz = document.querySelector(`#businessSelect option[value="${state.businessId}"]`);
    const bizName = biz ? biz.textContent.trim() : 'your business';

    const syncStatusEl = document.getElementById('syncStatus');
    const statusText = syncStatusEl ? syncStatusEl.textContent : '';

    // Build modal HTML and inject temporarily
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'syncHelpModal';
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <h3>How to Update Your Data</h3>
          <button class="modal-close" id="syncModalClose">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
          </button>
        </div>
        <div class="modal-body" style="gap:0">
          <div style="background:var(--bg-input);border-radius:8px;padding:12px 16px;margin-bottom:16px;font-size:13px;color:var(--text-secondary)">
            <strong style="color:var(--yellow)">${statusText}</strong>
            &nbsp;for <strong style="color:var(--text-primary)">${bizName}</strong>
          </div>
          <p style="font-size:13px;color:var(--text-secondary);margin-bottom:16px">
            Data is collected from the GBP Performance page. Follow these steps:
          </p>
          <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:20px">
            <div class="sync-step">
              <span class="sync-step-num">1</span>
              <div>
                <strong>Go to Google</strong> and search for <em>${bizName}</em> — or click the button below to open it.
              </div>
            </div>
            <div class="sync-step">
              <span class="sync-step-num">2</span>
              <div>
                Click <strong>Performance</strong> in the business panel to open the Performance view.
              </div>
            </div>
            <div class="sync-step">
              <span class="sync-step-num">3</span>
              <div>
                The <strong>GBP Stats Collector</strong> floating panel will appear.<br>
                • To fetch only <em>new</em> months: click <strong style="color:var(--accent)">🔄 Update Latest Data</strong><br>
                • To fetch <em>all history</em> (including last year for comparisons): click <strong style="color:var(--green)">⭐ Fetch Everything</strong>
              </div>
            </div>
            <div class="sync-step">
              <span class="sync-step-num">4</span>
              <div>
                When it finishes, come back here and click <strong>Refresh</strong> to see the updated data.
              </div>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="dp-btn dp-apply" id="syncOpenGbpBtn">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style="margin-right:6px"><path d="M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg>
            Open My Business on Google
          </button>
          <button class="dp-btn dp-cancel" id="syncRefreshBtn" style="margin-left:8px">Refresh Dashboard</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    document.getElementById('syncModalClose').onclick = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    document.getElementById('syncOpenGbpBtn').onclick = () => {
      const name = biz ? encodeURIComponent(biz.textContent.trim()) : '';
      chrome.tabs.create({
        url: name ? `https://www.google.com/search?q=${name}` : 'https://business.google.com/'
      });
      overlay.remove();
    };

    document.getElementById('syncRefreshBtn').onclick = async () => {
      overlay.remove();
      await checkSyncStatus();
      if (state.businessId) await selectBusiness(state.businessId);
    };
  }

  // ── Date Picker ──
  function toggleDatePicker(e) {
    e.stopPropagation();
    const dd = document.getElementById('datePickerDropdown');
    const btn = document.getElementById('datePickerBtn');
    const isOpen = dd.classList.contains('open');
    if (isOpen) {
      closeDatePicker();
    } else {
      dd.classList.add('open');
      btn.classList.add('open');
      state.dpStart = { year: state.startYear, month: state.startMonth };
      state.dpEnd = { year: state.endYear, month: state.endMonth };
      state.dpSelecting = false;
      renderDatePickerMonths();
      updateDpHint();
      // Scroll so the start month is visible
      setTimeout(() => {
        const container = document.getElementById('datePickerMonths');
        const sel = container.querySelector('.selected');
        if (sel) sel.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }, 50);
    }
  }

  function closeDatePicker() {
    document.getElementById('datePickerDropdown').classList.remove('open');
    document.getElementById('datePickerBtn').classList.remove('open');
  }

  function renderDatePickerMonths() {
    const container = document.getElementById('datePickerMonths');
    container.innerHTML = '';

    // Show months from the oldest available data to current month, or last 3 years
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;

    // Determine range to show
    let startY = currentYear - 2;
    if (state.allMonths.length) {
      const oldest = state.allMonths[0];
      startY = Math.min(startY, oldest.year);
    }

    const availSet = new Set(state.allMonths.map(m => `${m.year}-${m.month}`));

    for (let y = startY; y <= currentYear; y++) {
      // Year label
      const yearLabel = document.createElement('div');
      yearLabel.className = 'dp-year-label';
      yearLabel.textContent = y;
      container.appendChild(yearLabel);

      for (let m = 1; m <= 12; m++) {
        // Don't show future months
        if (y === currentYear && m > currentMonth) continue;

        const btn = document.createElement('button');
        btn.className = 'dp-month-btn';
        btn.textContent = `${MONTH_NAMES[m-1]} ${y}`;
        btn.dataset.year = y;
        btn.dataset.month = m;

        // Has data?
        if (availSet.has(`${y}-${m}`)) {
          btn.classList.add('has-data');
        } else {
          btn.classList.add('no-data');
        }

        // Selected range highlighting
        const dpS = state.dpStart;
        const dpE = state.dpEnd;
        const val = y * 12 + m;
        if (dpS && dpE) {
          const startVal = dpS.year * 12 + dpS.month;
          const endVal = dpE.year * 12 + dpE.month;
          if (val === startVal || val === endVal) {
            btn.classList.add('selected');
          } else if (val > startVal && val < endVal) {
            btn.classList.add('in-range');
          }
        } else if (dpS && !dpE) {
          // Mid-selection: only highlight the chosen start
          if (val === dpS.year * 12 + dpS.month) btn.classList.add('selected');
        }

        btn.addEventListener('click', (e) => { e.stopPropagation(); onDatePickerMonthClick(y, m); });
        container.appendChild(btn);
      }
    }
  }

  function onDatePickerMonthClick(year, month) {
    if (!state.dpSelecting) {
      // First click: set start, clear end
      state.dpStart = { year, month };
      state.dpEnd = null;
      state.dpSelecting = true;
    } else {
      // Second click: set end, ensure start <= end
      const clickVal = year * 12 + month;
      const startVal = state.dpStart.year * 12 + state.dpStart.month;
      if (clickVal < startVal) {
        state.dpEnd = state.dpStart;
        state.dpStart = { year, month };
      } else {
        state.dpEnd = { year, month };
      }
      state.dpSelecting = false;
    }
    renderDatePickerMonths();
    updateDpHint();
  }

  function updateDpHint() {
    const hint = document.getElementById('dpHint');
    if (!hint) return;
    if (!state.dpStart) {
      hint.innerHTML = 'Click a month to set <strong>start</strong>, click again to set <strong>end</strong>';
    } else if (state.dpSelecting) {
      const s = `${MONTH_NAMES[state.dpStart.month-1]} ${state.dpStart.year}`;
      hint.innerHTML = `Start: <strong style="color:var(--accent)">${s}</strong> — Now click the <strong>end</strong> month`;
    } else if (state.dpEnd) {
      const s = `${MONTH_NAMES[state.dpStart.month-1]} ${state.dpStart.year}`;
      const e = `${MONTH_NAMES[state.dpEnd.month-1]} ${state.dpEnd.year}`;
      const same = s === e;
      hint.innerHTML = same
        ? `Selected: <strong style="color:var(--accent)">${s}</strong>`
        : `Selected: <strong style="color:var(--accent)">${s}</strong> → <strong style="color:var(--accent)">${e}</strong>`;
    }
  }

  function applyDatePicker() {
    if (!state.dpStart) return;
    // If user only clicked once (no end), treat as single-month selection
    const end = state.dpEnd || state.dpStart;
    state.startYear  = state.dpStart.year;
    state.startMonth = state.dpStart.month;
    state.endYear    = end.year;
    state.endMonth   = end.month;
    state.dpSelecting = false;
    closeDatePicker();
    loadMetricData();
  }

  function updateDateLabel() {
    const label = document.getElementById('dateRangeLabel');
    const s = `${MONTH_NAMES[state.startMonth-1]} ${state.startYear}`;
    const e = `${MONTH_NAMES[state.endMonth-1]} ${state.endYear}`;
    label.textContent = (s === e) ? s : `${s} \u2013 ${e}`;
  }

  // ── Stats Card ──
  function updateStatsCard() {
    const total = state.currentData.reduce((sum, m) => sum + (m.total || 0), 0);
    document.getElementById('statTotal').textContent = total.toLocaleString();

    // Show "(estimated)" badge if any months in view are derived
    const anyDerived = state.currentData.some(m => m.derived);
    const desc = GBPStorage.METRIC_DESCRIPTIONS[state.metricType] || 'Interactions';
    document.getElementById('statDesc').innerHTML = anyDerived
      ? `${desc} <span class="derived-badge" title="Estimated from Year-over-Year % reported by Google">est.</span>`
      : desc;

    // Calculate YoY if we have single month selected and previous year data
    const yoyEl = document.getElementById('statYoY');
    if (state.startYear === state.endYear && state.startMonth === state.endMonth && state.currentData.length === 1) {
      const current = state.currentData[0];
      // Check if we stored yoyPercent from Google
      if (current.yoyPercent != null) {
        yoyEl.style.display = '';
        const sign = current.yoyPercent >= 0 ? '+' : '';
        document.getElementById('yoyPercent').textContent = `${sign}${current.yoyPercent}%`;
        document.getElementById('yoyLabel').textContent =
          `(vs ${MONTH_NAMES[state.startMonth-1]} ${state.startYear - 1})`;
        yoyEl.className = `stat-yoy ${current.yoyPercent >= 0 ? 'positive' : 'negative'}`;
      } else {
        // Try to compute manually from stored data
        computeManualYoY(total);
      }
    } else {
      yoyEl.style.display = 'none';
    }
  }

  async function computeManualYoY(currentTotal) {
    const yoyEl = document.getElementById('statYoY');
    const prevMetric = await GBPStorage.getMetric(
      state.businessId, state.metricType,
      state.startYear - 1, state.startMonth
    );
    if (prevMetric && prevMetric.total > 0) {
      const pct = ((currentTotal - prevMetric.total) / prevMetric.total * 100).toFixed(1);
      const sign = pct >= 0 ? '+' : '';
      yoyEl.style.display = '';
      document.getElementById('yoyPercent').textContent = `${sign}${pct}%`;
      document.getElementById('yoyLabel').textContent =
        `(vs ${MONTH_NAMES[state.startMonth-1]} ${state.startYear - 1})`;
      yoyEl.className = `stat-yoy ${pct >= 0 ? 'positive' : 'negative'}`;
    } else {
      yoyEl.style.display = 'none';
    }
  }

  // ── Compare Card ──
  function populateCompareSelect() {
    const select = document.getElementById('compareMonth');
    select.innerHTML = '<option value="">Choose month...</option>';

    for (const m of state.allMonths) {
      const opt = document.createElement('option');
      opt.value = `${m.year}-${m.month}`;
      opt.textContent = `${MONTH_NAMES[m.month-1]} ${m.year} (${m.total})`;
      select.appendChild(opt);
    }

    if (state.compareYear && state.compareMonth) {
      select.value = `${state.compareYear}-${state.compareMonth}`;
    }
  }

  function updateCompareCard() {
    if (!state.compareEnabled) return;

    const currentTotal = state.currentData.reduce((sum, m) => sum + (m.total || 0), 0);
    const same = state.startYear === state.endYear && state.startMonth === state.endMonth;
    const currentLabel = same
      ? `${MONTH_NAMES[state.startMonth-1]} ${state.startYear}`
      : `${MONTH_NAMES[state.startMonth-1]} '${String(state.startYear).slice(2)} – ${MONTH_NAMES[state.endMonth-1]} '${String(state.endYear).slice(2)}`;

    document.getElementById('compareLabel1').textContent = currentLabel;
    document.getElementById('compareValue1').textContent = currentTotal.toLocaleString();

    // Resolve compare total + label from active mode
    let compareTotal = null;
    let compareLabel = '—';

    if (state.compareMode === 'custom' && state.compareData) {
      compareTotal = state.compareData.total;
      compareLabel = `${MONTH_NAMES[state.compareData.month-1]} ${state.compareData.year}`;
    } else if (state.comparePeriodData.length) {
      compareTotal = state.comparePeriodData.reduce((s, m) => s + (m.total || 0), 0);
      const { cStartY, cStartM, cEndY, cEndM } = getComparePeriodBounds();
      const cSame = cStartY === cEndY && cStartM === cEndM;
      compareLabel = cSame
        ? `${MONTH_NAMES[cStartM-1]} ${cStartY}`
        : `${MONTH_NAMES[cStartM-1]} '${String(cStartY).slice(2)} – ${MONTH_NAMES[cEndM-1]} '${String(cEndY).slice(2)}`;
    }

    document.getElementById('compareLabel2').textContent = compareLabel;
    const periodLabelEl = document.getElementById('comparePeriodLabel');
    if (periodLabelEl) periodLabelEl.textContent = compareLabel;

    if (compareTotal !== null) {
      document.getElementById('compareValue2').textContent = compareTotal.toLocaleString();
      const pctEl = document.getElementById('comparePercent');
      if (compareTotal > 0) {
        const pct = ((currentTotal - compareTotal) / compareTotal * 100).toFixed(1);
        const sign = pct >= 0 ? '+' : '';
        pctEl.innerHTML = `<span class="${pct >= 0 ? 'positive' : 'negative'}">${sign}${pct}%</span>`;
      } else if (currentTotal > 0) {
        pctEl.innerHTML = '<span class="positive">New data</span>';
      } else {
        pctEl.innerHTML = '<span style="color:var(--text-muted)">No data</span>';
      }
    } else {
      document.getElementById('compareValue2').textContent = '—';
      const pctEl = document.getElementById('comparePercent');
      if (state.compareMode !== 'custom') {
        // Build list of missing month labels for the comparison period
        const { cStartY, cStartM, cEndY, cEndM } = getComparePeriodBounds();
        const missingMonths = buildMissingMonthList(cStartY, cStartM, cEndY, cEndM);
        pctEl.innerHTML = `
          <div class="missing-data-hint">
            <div class="missing-data-title">⚠ Not collected yet</div>
            <div class="missing-data-months">${missingMonths}</div>
            <div class="missing-data-tip">Go to GBP Performance and click<br><strong>⭐ Fetch Everything</strong> to get this history</div>
          </div>`;
      } else {
        pctEl.innerHTML = '<span style="color:var(--text-muted)">No data for selected month</span>';
      }
    }
  }

  // Build a compact label listing months that are missing from storage
  function buildMissingMonthList(startY, startM, endY, endM) {
    const missing = [];
    let y = startY, m = startM;
    while (y < endY || (y === endY && m <= endM)) {
      missing.push(`${MONTH_NAMES[m-1]} ${y}`);
      m++; if (m > 12) { m = 1; y++; }
    }
    if (missing.length === 0) return '';
    if (missing.length <= 3) return missing.join(', ');
    return `${missing[0]} – ${missing[missing.length-1]} (${missing.length} months)`;
  }

  // ── SVG Chart Rendering ──
  function renderChart() {
    const svg = document.getElementById('chart');
    const noData = document.getElementById('chartNoData');
    const container = document.getElementById('chartContainer');

    // Collect all daily values across selected months
    let dailyValues = [];
    let dayLabels = [];

    if (state.currentData.length === 0) {
      svg.style.display = 'none';
      noData.style.display = '';
      return;
    }
    svg.style.display = '';
    noData.style.display = 'none';

    // Single month: show daily breakdown if available, else show total as single bar
    if (state.currentData.length === 1) {
      const m = state.currentData[0];
      if (m.daily && m.daily.length > 0) {
        dailyValues = m.daily;
        dayLabels = dailyValues.map((_, i) => `${i + 1} ${MONTH_NAMES[m.month - 1]}`);
      } else if (m.total > 0) {
        // No daily breakdown — show total as a single point
        dailyValues = [m.total];
        dayLabels = [`${MONTH_NAMES[m.month - 1]} ${m.year}`];
      }
    } else {
      // Multi-month: show monthly totals
      for (const m of state.currentData) {
        dailyValues.push(m.total || 0);
        dayLabels.push(`${MONTH_NAMES[m.month - 1]} ${m.year}`);
      }
    }

    // Track which data points are derived (for dashed segment rendering)
    const derivedFlags = state.currentData.length === 1
      ? (state.currentData[0].derived ? [true] : [false])
      : state.currentData.map(m => !!m.derived);

    if (!dailyValues.length) {
      svg.style.display = 'none';
      noData.style.display = 'flex';
      noData.innerHTML = `<div>
        <div style="font-size:18px;margin-bottom:8px">No data for this period</div>
        <div style="font-size:13px;color:#666">Try selecting a different metric tab or month from the coverage grid below</div>
      </div>`;
      return;
    }

    // Compare data for overlay
    let compareValues = null;
    let compareLabels = null;

    if (state.compareEnabled) {
      if (state.compareMode === 'custom' && state.compareData) {
        // Single-month custom: overlay daily or just the total
        if (state.currentData.length === 1) {
          compareValues = state.compareData.daily || [state.compareData.total];
          compareLabels = compareValues.map((_, i) =>
            `${i + 1} ${MONTH_NAMES[state.compareData.month - 1]} ${state.compareData.year}`
          );
        } else {
          // For a multi-month range vs a single custom month, show custom total as flat line
          compareValues = state.currentData.map(() => state.compareData.total);
          compareLabels = state.currentData.map(() =>
            `${MONTH_NAMES[state.compareData.month - 1]} ${state.compareData.year}`
          );
        }
      } else if (state.comparePeriodData.length) {
        // Period comparison (yoy or prev): monthly totals
        if (state.currentData.length === 1 && state.comparePeriodData.length === 1) {
          // Both single months — show daily overlay
          compareValues = state.comparePeriodData[0].daily || [state.comparePeriodData[0].total];
          const cm = state.comparePeriodData[0];
          compareLabels = compareValues.map((_, i) =>
            `${i + 1} ${MONTH_NAMES[cm.month - 1]} ${cm.year}`
          );
        } else {
          // Multi-month: monthly totals
          compareValues = state.comparePeriodData.map(m => m.total || 0);
          compareLabels = state.comparePeriodData.map(m =>
            `${MONTH_NAMES[m.month - 1]} ${m.year}`
          );
        }
      }
    }

    drawLineChart(svg, dailyValues, dayLabels, compareValues, compareLabels, derivedFlags);
  }

  function drawLineChart(svg, values, labels, compareValues, compareLabels, derivedFlags) {
    const W = 1100;
    const H = 300;
    const PAD = { top: 40, right: 20, bottom: 40, left: 50 };
    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;

    // Compute scales
    let allVals = [...values];
    if (compareValues) allVals = allVals.concat(compareValues);
    const maxVal = Math.max(...allVals, 1);
    // Nice max for y-axis
    const niceMax = niceNumber(maxVal);
    const yTicks = computeYTicks(niceMax);

    const xStep = values.length > 1 ? plotW / (values.length - 1) : plotW;
    const toX = (i) => PAD.left + (values.length > 1 ? i * xStep : plotW / 2);
    const toY = (v) => PAD.top + plotH - (v / niceMax) * plotH;

    // Set attributes on the existing SVG element (avoids outerHTML detach bug)
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

    let html = '';

    // Y-axis grid lines and labels
    for (const tick of yTicks) {
      const y = toY(tick);
      html += `<line class="grid-line" x1="${PAD.left}" x2="${W - PAD.right}" y1="${y}" y2="${y}"/>`;
      // Background pill for label
      const labelText = tick.toString();
      const textW = labelText.length * 7 + 14;
      html += `<rect class="y-label-bg" x="${PAD.left - 4}" y="${y - 12}" width="${textW}" height="24" rx="12"/>`;
      html += `<text class="y-label" x="${PAD.left + 4}" y="${y + 4}">${tick}</text>`;
    }

    // X-axis labels
    const xLabelInterval = Math.max(1, Math.floor(values.length / 8));
    for (let i = 0; i < values.length; i++) {
      if (i === 0 || i === values.length - 1 || i % xLabelInterval === 0) {
        const x = toX(i);
        const anchor = i === 0 ? 'start' : i === values.length - 1 ? 'end' : 'middle';
        html += `<text class="axis-label" x="${x}" y="${H - 8}" text-anchor="${anchor}">${labels[i]}</text>`;
        // Vertical dashed grid line
        html += `<line class="grid-line" x1="${x}" x2="${x}" y1="${PAD.top}" y2="${PAD.top + plotH}" style="stroke-dasharray: 3,3"/>`;
      }
    }

    // Bottom axis line
    html += `<line class="axis-line" x1="${PAD.left}" x2="${W - PAD.right}" y1="${toY(0)}" y2="${toY(0)}"/>`;

    // ── Compare area + line (draw first, behind main) ──
    if (compareValues && compareValues.length) {
      const cLen = Math.min(compareValues.length, values.length);
      // Area
      let areaPath = `M${toX(0)},${toY(compareValues[0])}`;
      for (let i = 1; i < cLen; i++) areaPath += `L${toX(i)},${toY(compareValues[i])}`;
      areaPath += `L${toX(cLen-1)},${toY(0)}L${toX(0)},${toY(0)}Z`;
      html += `<path class="compare-area" d="${areaPath}"/>`;

      // Line
      let linePath = `M${toX(0)},${toY(compareValues[0])}`;
      for (let i = 1; i < cLen; i++) linePath += `L${toX(i)},${toY(compareValues[i])}`;
      html += `<path class="compare-line" d="${linePath}"/>`;

      // Points
      for (let i = 0; i < cLen; i++) {
        html += `<circle class="compare-point" cx="${toX(i)}" cy="${toY(compareValues[i])}" r="5">`;
        html += `<title>${compareLabels ? compareLabels[i] : ''}: ${compareValues[i]}</title></circle>`;
      }
    }

    // ── Main area fill (solid only over real data) ──
    // Draw one solid area shape under all points, then mask derived regions
    let areaPath = `M${toX(0)},${toY(values[0])}`;
    for (let i = 1; i < values.length; i++) areaPath += `L${toX(i)},${toY(values[i])}`;
    areaPath += `L${toX(values.length-1)},${toY(0)}L${toX(0)},${toY(0)}Z`;
    html += `<path class="chart-area" d="${areaPath}" opacity="0.5"/>`;

    // ── Main line: draw solid segments and dashed segments separately ──
    // Segment = consecutive run of real OR derived points
    let i = 0;
    while (i < values.length) {
      const isDer = derivedFlags && derivedFlags[i];
      let segPath = `M${toX(i)},${toY(values[i])}`;
      let j = i + 1;
      while (j < values.length && !!(derivedFlags && derivedFlags[j]) === isDer) {
        segPath += `L${toX(j)},${toY(values[j])}`;
        j++;
      }
      // Connect solid→dashed segments so there's no gap
      if (j < values.length) segPath += `L${toX(j)},${toY(values[j])}`;
      html += `<path class="${isDer ? 'chart-line-derived' : 'chart-line'}" d="${segPath}"/>`;
      i = j;
    }

    // ── Points: diamond for derived, circle for real ──
    for (let i = 0; i < values.length; i++) {
      const isDer = derivedFlags && derivedFlags[i];
      const cx = toX(i), cy = toY(values[i]);
      const tip = `${labels[i]}: ${values[i]}${isDer ? ' (estimated from YoY%)' : ''}`;
      if (isDer) {
        // Diamond shape for estimated points
        const r = 6;
        html += `<polygon class="chart-point-derived"
          points="${cx},${cy-r} ${cx+r},${cy} ${cx},${cy+r} ${cx-r},${cy}">
          <title>${tip}</title></polygon>`;
      } else {
        html += `<circle class="chart-point" cx="${cx}" cy="${cy}" r="6">
          <title>${tip}</title></circle>`;
      }
    }

    svg.innerHTML = html;
  }

  function niceNumber(val) {
    if (val <= 0) return 1;
    const exp = Math.floor(Math.log10(val));
    const frac = val / Math.pow(10, exp);
    let nice;
    if (frac <= 1) nice = 1;
    else if (frac <= 2) nice = 2;
    else if (frac <= 5) nice = 5;
    else nice = 10;
    return nice * Math.pow(10, exp);
  }

  function computeYTicks(max) {
    if (max <= 5) return Array.from({ length: max + 1 }, (_, i) => i);
    const step = niceNumber(max / 4);
    const ticks = [];
    for (let v = 0; v <= max; v += step) ticks.push(Math.round(v));
    if (ticks[ticks.length - 1] < max) ticks.push(Math.round(max));
    return ticks;
  }

  // ── Data Table ──
  function renderDataTable() {
    // Update headers
    const thead = document.querySelector('#dataTable thead tr');
    const metricLabel = GBPStorage.METRIC_LABELS[state.metricType] || 'Interactions';
    const isMultiMonth = state.currentData.length !== 1;
    thead.innerHTML = `<th>${isMultiMonth ? 'Month' : 'Day'}</th><th>${metricLabel}</th>`;

    const tbody = document.getElementById('dataTableBody');
    tbody.innerHTML = '';

    if (state.currentData.length === 1) {
      const m = state.currentData[0];
      if (m.derived) {
        // Derived months have no daily data — show a single total row with note
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${MONTH_FULL[m.month - 1]} ${m.year} <span class="derived-badge" title="Estimated from YoY%">est.</span></td>
          <td><span style="color:var(--text-secondary)">${m.total.toLocaleString()}</span>
            <span style="font-size:11px;color:var(--text-muted);margin-left:8px">Monthly total only — no daily breakdown available for estimated months</span>
          </td>`;
        tbody.appendChild(tr);
        return;
      }
      const daily = m.daily || [];
      const max = Math.max(...daily, 1);

      for (let i = 0; i < daily.length; i++) {
        const tr = document.createElement('tr');
        const pct = (daily[i] / max * 100).toFixed(0);
        tr.innerHTML = `
          <td>${i + 1} ${MONTH_FULL[m.month - 1]}</td>
          <td>
            <div style="display:flex;align-items:center;gap:10px">
              <span style="min-width:24px">${daily[i]}</span>
              <div class="td-bar" style="width:${pct}%;min-width:2px;max-width:200px"></div>
            </div>
          </td>`;
        tbody.appendChild(tr);
      }
    } else {
      // Monthly view
      const max = Math.max(...state.currentData.map(m => m.total || 0), 1);
      for (const m of state.currentData) {
        const tr = document.createElement('tr');
        const pct = ((m.total || 0) / max * 100).toFixed(0);
        const derivedNote = m.derived ? ` <span class="derived-badge" title="Estimated from YoY%">est.</span>` : '';
        tr.innerHTML = `
          <td>${MONTH_FULL[m.month - 1]} ${m.year}${derivedNote}</td>
          <td>
            <div style="display:flex;align-items:center;gap:10px">
              <span style="min-width:24px">${m.total || 0}</span>
              <div class="td-bar ${m.derived ? 'td-bar-derived' : ''}" style="width:${pct}%;min-width:2px;max-width:200px"></div>
            </div>
          </td>`;
        tbody.appendChild(tr);
      }
    }
  }

  // ── Coverage Grid ──
  async function renderCoverageGrid() {
    const grid = document.getElementById('coverageGrid');
    grid.innerHTML = '';

    if (!state.businessId) return;

    const allMetrics = await GBPStorage.getAllMetricsForBusiness(state.businessId);
    const availSet    = new Set(allMetrics.filter(m => !m.derived).map(m => `${m.year}-${m.month}`));
    const derivedSet  = new Set(allMetrics.filter(m =>  m.derived).map(m => `${m.year}-${m.month}`));

    // Show from oldest collected month to current month (minimum 24 months)
    const now = new Date();
    const curY = now.getFullYear();
    const curM = now.getMonth() + 1;

    let startY = curY, startM = curM - 23;
    while (startM <= 0) { startM += 12; startY--; }

    // Extend back to oldest data if we have older data
    if (allMetrics.length) {
      const sorted = allMetrics.slice().sort((a, b) => a.year - b.year || a.month - b.month);
      const oldest = sorted[0];
      if (oldest.year < startY || (oldest.year === startY && oldest.month < startM)) {
        startY = oldest.year;
        startM = oldest.month;
      }
    }

    // Build ordered list of months
    const cells = [];
    let cy = startY, cm = startM;
    while (cy < curY || (cy === curY && cm <= curM)) {
      cells.push({ year: cy, month: cm });
      cm++;
      if (cm > 12) { cm = 1; cy++; }
    }

    // Group by year for better readability — render year headers + months in 12-col grid per year
    const byYear = {};
    for (const cell of cells) {
      if (!byYear[cell.year]) byYear[cell.year] = [];
      byYear[cell.year].push(cell);
    }

    // Update grid to be auto-col per year
    grid.style.gridTemplateColumns = 'repeat(12, 1fr)';

    for (const [year, months] of Object.entries(byYear)) {
      // Year header spanning full row
      const yearDiv = document.createElement('div');
      yearDiv.style.cssText = 'grid-column:1/-1;font-size:11px;color:var(--text-muted);padding:6px 0 2px;font-weight:600';
      yearDiv.textContent = year;
      grid.appendChild(yearDiv);

      // Pad to start at correct column (Jan = col 1)
      const firstMonth = months[0].month;
      for (let pad = 1; pad < firstMonth; pad++) {
        const empty = document.createElement('div');
        grid.appendChild(empty);
      }

      for (const cell of months) {
        const key = `${cell.year}-${cell.month}`;
        const div = document.createElement('div');
        const hasReal    = availSet.has(key);
        const hasDerived = !hasReal && derivedSet.has(key);
        div.className = `cov-cell ${hasReal ? 'has-data' : hasDerived ? 'derived-data' : 'no-data'}`;

        const val = cell.year * 12 + cell.month;
        const startVal = state.startYear * 12 + state.startMonth;
        const endVal = state.endYear * 12 + state.endMonth;
        if (val >= startVal && val <= endVal) div.classList.add('current');

        div.innerHTML = `<span class="cov-month">${MONTH_NAMES[cell.month-1]}</span>`;
        div.title = `${MONTH_FULL[cell.month-1]} ${cell.year} — ${
          hasReal ? 'collected' : hasDerived ? 'estimated from YoY%' : 'no data'
        }`;

        div.addEventListener('click', () => {
          state.startYear = cell.year;
          state.startMonth = cell.month;
          state.endYear = cell.year;
          state.endMonth = cell.month;
          loadMetricData();
        });

        grid.appendChild(div);
      }
    }
  }

  // ── Platform Breakdown & Search Terms Display ────────────────────────────
  async function renderDiscoverySection() {
    const section = document.getElementById('discoverySection');
    if (!section) return;

    // Only shown when Overview tab is active
    if (state.metricType !== 'overview') { section.style.display = 'none'; return; }

    // Prefer most recent record in the currently selected range that has breakdown/searchTerms.
    // If none found in range, fall back to the most recent such record across all data.
    let record = [...state.currentData]
      .reverse()
      .find(m => m.breakdown || (m.searchTerms && m.searchTerms.length));

    if (!record && state.businessId) {
      // Try all stored overview records
      const allMetrics = await GBPStorage.getAllMetricsForBusiness(state.businessId);
      record = allMetrics
        .filter(m => m.metricType === 'overview' && (m.breakdown || (m.searchTerms && m.searchTerms.length)))
        .sort((a, b) => b.year - a.year || b.month - a.month)[0] || null;
    }

    if (!record) { section.style.display = 'none'; return; }
    section.style.display = '';

    // Label showing which month this data is from
    const recordLabel = `${MONTH_NAMES[record.month-1]} ${record.year}`;
    const inCurrentRange = state.currentData.some(m => m.year === record.year && m.month === record.month);
    const sourceNote = inCurrentRange ? '' : ` · latest: ${recordLabel}`;

    // ── Platform breakdown ──
    // Update platform card title note
    const platformCard = document.getElementById('platformCard');
    if (platformCard) {
      let noteEl = platformCard.querySelector('.discovery-note');
      if (!noteEl) {
        noteEl = document.createElement('span');
        noteEl.className = 'discovery-note';
        platformCard.querySelector('.discovery-title').appendChild(noteEl);
      }
      noteEl.textContent = `${recordLabel}${sourceNote || ''}`;
    }

    const platformWrap = document.getElementById('platformBreakdown');
    if (record.breakdown) {
      const bd = record.breakdown;
      const total = (bd.searchMobile||0) + (bd.searchDesktop||0) + (bd.mapsMobile||0) + (bd.mapsDesktop||0);
      const rows = [
        { label: 'Google Search – Mobile',  key: 'searchMobile',  color: '#f9a825' },
        { label: 'Google Search – Desktop', key: 'searchDesktop', color: '#8ab4f8' },
        { label: 'Google Maps – Mobile',    key: 'mapsMobile',    color: '#f28b82' },
        { label: 'Google Maps – Desktop',   key: 'mapsDesktop',   color: '#81c995' },
      ];
      platformWrap.innerHTML = rows.map(r => {
        const count = bd[r.key] || 0;
        const pct   = total > 0 ? ((count / total) * 100).toFixed(1) : '0';
        return `
          <div class="platform-row">
            <div class="platform-dot" style="background:${r.color}"></div>
            <div class="platform-label">${r.label}</div>
            <div class="platform-bar-wrap">
              <div class="platform-bar" style="width:${pct}%;background:${r.color}"></div>
            </div>
            <div class="platform-count">${count.toLocaleString()}</div>
            <div class="platform-pct">${pct}%</div>
          </div>`;
      }).join('');
    } else {
      platformWrap.innerHTML = '<div class="discovery-empty">No breakdown data yet — fetch the Overview tab to collect this.</div>';
    }

    // ── Performance Funnel: Searches → Views → Interactions ──
    const funnelCard  = document.getElementById('funnelCard');
    const funnelSteps = document.getElementById('funnelSteps');
    const funnelNote  = document.getElementById('funnelNote');
    const searches     = record.searchImpressions || 0;
    const views        = record.profileViews       || 0;
    const interactions = record.total              || 0;

    if (searches > 0 || views > 0) {
      funnelCard.style.display = '';
      funnelNote.textContent = `${recordLabel}${sourceNote || ''}`;

      const maxVal = Math.max(searches, views, interactions, 1);
      const steps = [
        { label: 'Searches showed your Business Profile', value: searches,     color: '#8ab4f8', icon: '🔍', desc: 'Total times your profile appeared in search results' },
        { label: 'People viewed your Business Profile',   value: views,        color: '#f9a825', icon: '👁️', desc: 'Searchers who opened and viewed your profile' },
        { label: 'Business Profile interactions',          value: interactions, color: '#81c995', icon: '🖱️', desc: 'People who called, visited website, got directions, etc.' },
      ];

      funnelSteps.innerHTML = steps.map((s, i) => {
        const pct  = maxVal > 0 ? ((s.value / maxVal) * 100).toFixed(0) : 0;
        const rate = i > 0 && steps[i-1].value > 0
          ? `${((s.value / steps[i-1].value) * 100).toFixed(1)}% conversion`
          : '';
        return `
          <div class="funnel-step">
            <div class="funnel-step-icon">${s.icon}</div>
            <div class="funnel-step-info">
              <div class="funnel-step-label">${s.label}</div>
              ${rate ? `<div class="funnel-step-rate">${rate}</div>` : ''}
            </div>
            <div class="funnel-step-bar-wrap">
              <div class="funnel-step-bar" style="width:${pct}%;background:${s.color}"></div>
            </div>
            <div class="funnel-step-value" style="color:${s.color}">${s.value > 0 ? s.value.toLocaleString() : '—'}</div>
          </div>`;
      }).join('');
    } else {
      funnelCard.style.display = 'none';
    }

    // ── Search terms ──
    const termsList = document.getElementById('searchTermsList');
    const termsNote = document.getElementById('searchTermsNote');
    if (record.searchTerms && record.searchTerms.length) {
      const terms = record.searchTerms;
      const maxCount = terms[0].count;
      termsNote.textContent = `${recordLabel} · ${terms.length} terms${sourceNote}`;
      termsList.innerHTML = terms.slice(0, 20).map((t, i) => `
        <div class="term-row">
          <div class="term-rank">${i + 1}</div>
          <div class="term-text">${t.term}</div>
          <div class="term-bar-wrap">
            <div class="term-bar" style="width:${(t.count / maxCount * 100).toFixed(1)}%"></div>
          </div>
          <div class="term-count">${t.count.toLocaleString()}</div>
        </div>`).join('');
    } else {
      termsNote.textContent = '';
      termsList.innerHTML = '<div class="discovery-empty">No search terms yet — fetch the Overview tab to collect this.</div>';
    }
  }

  // ── AI Insights Engine ───────────────────────────────────────────────────
  async function generateInsights() {
    const section = document.getElementById('insightsSection');
    const grid = document.getElementById('insightsGrid');
    if (!state.businessId) { section.style.display = 'none'; return; }

    const allMetrics = await GBPStorage.getAllMetricsForBusiness(state.businessId);
    if (!allMetrics.length) { section.style.display = 'none'; return; }

    section.style.display = '';
    grid.innerHTML = '<div class="insights-empty">Analysing your data…</div>';

    // Small async pause so the UI renders first
    await new Promise(r => setTimeout(r, 30));

    const insights = [];

    // ── Exclude the current (incomplete) month from all analysis ──
    // If today is April 15, April's data is only half-collected and will
    // make every trend, average, and comparison look artificially low.
    const _now = new Date();
    const _curYear  = _now.getFullYear();
    const _curMonth = _now.getMonth() + 1;
    const isCurrentMonth = (m) => m.year === _curYear && m.month === _curMonth;

    const completedMetrics = allMetrics.filter(m => !isCurrentMonth(m));

    // Helper: metrics for a specific type sorted oldest→newest (completed months only)
    const byType = (type) => completedMetrics
      .filter(m => m.metricType === type)
      .sort((a, b) => a.year - b.year || a.month - b.month);

    // Helper: linear regression slope (returns avg monthly change)
    const slope = (arr) => {
      if (arr.length < 2) return 0;
      const n = arr.length;
      const meanX = (n - 1) / 2;
      const meanY = arr.reduce((s, v) => s + v, 0) / n;
      let num = 0, den = 0;
      arr.forEach((v, i) => { num += (i - meanX) * (v - meanY); den += (i - meanX) ** 2; });
      return den ? num / den : 0;
    };

    // ── 1. Trend for the currently viewed metric ──
    const currentM = byType(state.metricType);
    if (currentM.length >= 3) {
      const recent = currentM.slice(-Math.min(6, currentM.length));
      const vals = recent.map(m => m.total);
      const s = slope(vals);
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      const slopePct = avg > 0 ? ((s / avg) * 100).toFixed(1) : '0';
      const label = GBPStorage.METRIC_LABELS[state.metricType];

      if (Math.abs(s) > 0.3) {
        insights.push({
          type: s > 0 ? 'positive' : 'warning',
          icon: s > 0 ? '📈' : '📉',
          title: s > 0 ? `${label} Growing` : `${label} Declining`,
          body: s > 0
            ? `Up ~${Math.abs(slopePct)}% per month over the last ${recent.length} months. Keep the momentum going with fresh posts and photos.`
            : `Down ~${Math.abs(slopePct)}% per month over the last ${recent.length} months. Review your profile completeness, recent reviews, and posting frequency.`
        });
      } else {
        insights.push({
          type: 'info', icon: '➡️',
          title: `${label} Stable`,
          body: `Relatively flat over the last ${recent.length} months (avg ${Math.round(avg).toLocaleString()}/month). Small improvements in photos or posts can nudge this upward.`
        });
      }
    }

    // ── 2. Month-over-month jump/drop ──
    const currentM2 = byType(state.metricType);
    if (currentM2.length >= 2) {
      const last = currentM2[currentM2.length - 1];
      const prev = currentM2[currentM2.length - 2];
      if (prev.total > 0) {
        const chg = ((last.total - prev.total) / prev.total * 100).toFixed(1);
        if (Math.abs(chg) >= 15) {
          insights.push({
            type: chg > 0 ? 'positive' : 'warning',
            icon: chg > 0 ? '🚀' : '🔻',
            title: `${Math.abs(chg)}% ${chg > 0 ? 'Rise' : 'Drop'} vs Last Month`,
            body: `${GBPStorage.METRIC_LABELS[state.metricType]} went from ${prev.total.toLocaleString()} (${MONTH_NAMES[prev.month-1]}) to ${last.total.toLocaleString()} (${MONTH_NAMES[last.month-1]}).`
              + (chg < 0 ? ' Check for profile changes, new competitors, or missing business hours.' : ' Great momentum — ask satisfied customers for a review now.')
          });
        }
      }
    }

    // ── 3. Best & worst months (need ≥6 data points) ──
    if (currentM.length >= 6) {
      const sorted = [...currentM].sort((a, b) => b.total - a.total);
      const best = sorted[0];
      const worst = sorted[sorted.length - 1];
      insights.push({
        type: 'info', icon: '🏆',
        title: `Best Month: ${MONTH_NAMES[best.month-1]} ${best.year}`,
        body: `Peak of ${best.total.toLocaleString()} ${GBPStorage.METRIC_LABELS[state.metricType].toLowerCase()}. Analyse what you posted or changed that month and repeat it.`
      });
      if (worst.total < best.total * 0.35) {
        insights.push({
          type: 'warning', icon: '⚠️',
          title: `Slowest: ${MONTH_NAMES[worst.month-1]} ${worst.year}`,
          body: `Only ${worst.total.toLocaleString()} — just ${Math.round(worst.total / best.total * 100)}% of your peak. Consider a seasonal promotion or ad campaign during this period.`
        });
      }
    }

    // ── 4. Seasonality (same month across years) ──
    const monthAvgMap = {};
    for (const m of currentM) {
      if (!monthAvgMap[m.month]) monthAvgMap[m.month] = [];
      monthAvgMap[m.month].push(m.total);
    }
    const monthAvgs = Object.entries(monthAvgMap)
      .map(([mo, vals]) => ({ month: +mo, avg: vals.reduce((s, v) => s + v, 0) / vals.length, count: vals.length }))
      .filter(x => x.count >= 2);          // need at least 2 years to call it seasonal
    if (monthAvgs.length >= 3) {
      const overallAvg = monthAvgs.reduce((s, x) => s + x.avg, 0) / monthAvgs.length;
      const peak = monthAvgs.sort((a, b) => b.avg - a.avg)[0];
      const slow = monthAvgs.sort((a, b) => a.avg - b.avg)[0];
      if (peak.avg > overallAvg * 1.25) {
        insights.push({
          type: 'info', icon: '📅',
          title: `Peak Season: ${MONTH_FULL[peak.month-1]}`,
          body: `Historically your strongest month across ${peak.count} years. Ramp up marketing 6–8 weeks before to capture early demand.`
        });
      }
      if (slow.avg < overallAvg * 0.75) {
        insights.push({
          type: 'info', icon: '🎯',
          title: `Slow Month Opportunity: ${MONTH_FULL[slow.month-1]}`,
          body: `Consistently the slowest month. A limited-time offer or Google post can drive traffic during this dip.`
        });
      }
    }

    // ── 5. Cross-metric intelligence ──
    const recent3 = (type) => {
      const ms = byType(type).slice(-3);
      return ms.reduce((s, m) => s + m.total, 0);
    };
    const hasType = (type) => byType(type).length > 0;

    // Chat clicks zero → suggest enabling messaging
    if (!hasType('chat_clicks') || recent3('chat_clicks') === 0) {
      insights.push({
        type: 'info', icon: '💬',
        title: 'Enable GBP Messaging',
        body: 'Zero chat clicks detected. Enable the "Messages" feature in your Google Business Profile to let customers text you directly — this often converts 3× better than website visits.'
      });
    }

    // Calls low vs website clicks (< 8% conversion)
    if (hasType('calls') && hasType('website_clicks')) {
      const calls = recent3('calls');
      const clicks = recent3('website_clicks');
      if (clicks > 15 && calls / clicks < 0.08) {
        insights.push({
          type: 'info', icon: '📞',
          title: 'Low Call-Through Rate',
          body: `Only ${Math.round(calls / clicks * 100)}% of website visitors call you. Make sure your phone number is large and prominent on your website and GBP listing.`
        });
      }
    }

    // Directions low vs overview (< 5%)
    if (hasType('directions') && hasType('overview')) {
      const dir = recent3('directions');
      const ov  = recent3('overview');
      if (ov > 30 && dir / ov < 0.05) {
        insights.push({
          type: 'info', icon: '📍',
          title: 'Few Directions Requests',
          body: `Directions are only ${Math.round(dir / ov * 100)}% of total interactions. Add more photos of your storefront and street view to help customers locate you easily.`
        });
      }
    }

    // Bookings zero → prompt
    if (hasType('bookings') && recent3('bookings') === 0) {
      insights.push({
        type: 'info', icon: '📅',
        title: 'Enable GBP Bookings',
        body: 'No bookings recorded via your profile. Connect a scheduling tool (like Calendly, Acuity, or native Reserve with Google) to let customers book directly from search results.'
      });
    }

    // ── 6. YoY summary (if we have data from last year) ──
    const cM = byType(state.metricType);
    if (cM.length > 0) {
      const latest = cM[cM.length - 1];
      const yoyMatch = cM.find(m => m.year === latest.year - 1 && m.month === latest.month);
      if (yoyMatch && yoyMatch.total > 0) {
        const yoyPct = ((latest.total - yoyMatch.total) / yoyMatch.total * 100).toFixed(1);
        insights.push({
          type: yoyPct >= 0 ? 'positive' : 'warning',
          icon: yoyPct >= 0 ? '🗓️' : '🗓️',
          title: `YoY: ${yoyPct >= 0 ? '+' : ''}${yoyPct}%`,
          body: `${MONTH_FULL[latest.month-1]} ${latest.year} (${latest.total.toLocaleString()}) vs ${MONTH_FULL[yoyMatch.month-1]} ${yoyMatch.year} (${yoyMatch.total.toLocaleString()}).`
            + (yoyPct >= 5 ? ' Solid year-on-year growth — keep investing in your profile.' : yoyPct < -10 ? ' Significant drop vs last year — prioritise review responses and new photos.' : '')
        });
      }
    }

    // ── 7. Search terms intelligence ──
    const overviewRecords = completedMetrics
      .filter(m => m.metricType === 'overview' && m.searchTerms && m.searchTerms.length)
      .sort((a, b) => a.year - b.year || a.month - b.month);

    if (overviewRecords.length > 0) {
      const latest = overviewRecords[overviewRecords.length - 1];
      const terms  = latest.searchTerms;

      // Top term
      if (terms.length > 0) {
        insights.push({
          type: 'info', icon: '🔍',
          title: `Top Search: "${terms[0].term}"`,
          body: `"${terms[0].term}" drove ${terms[0].count.toLocaleString()} impressions in ${MONTH_FULL[latest.month-1]} ${latest.year}. Make sure this exact phrase appears naturally in your business description and posts.`
        });
      }

      // Brand vs non-brand ratio
      const bizName = document.querySelector('#businessSelect option:checked')?.textContent?.toLowerCase() || '';
      const brandTerms = terms.filter(t => bizName && t.term.toLowerCase().includes(bizName.split(' ')[0]));
      const nonBrandTotal = terms.filter(t => !brandTerms.includes(t)).reduce((s, t) => s + t.count, 0);
      const brandTotal    = brandTerms.reduce((s, t) => s + t.count, 0);
      const totalSearches = terms.reduce((s, t) => s + t.count, 0);
      if (totalSearches > 50 && nonBrandTotal > brandTotal) {
        insights.push({
          type: 'positive', icon: '🌐',
          title: 'Strong Non-Brand Discovery',
          body: `${Math.round(nonBrandTotal / totalSearches * 100)}% of searches are non-brand (people finding you without knowing your name). This is valuable organic reach — optimise your profile for these category/service terms.`
        });
      }

      // Location-specific / geo-intent terms
      const locationTerms = terms.filter(t =>
        /near\s?me|nearby|closest|in\s+\w+|around\s+here|\blocal\b|\barea\b|\bdistrict\b|\bcity\b|\btown\b/i.test(t.term)
      );
      if (locationTerms.length > 0) {
        insights.push({
          type: 'info', icon: '📍',
          title: `${locationTerms.length} Geo-Intent Search Term${locationTerms.length > 1 ? 's' : ''}`,
          body: `Location-specific searches like "${locationTerms[0].term}" signal high purchase intent. Mention your neighbourhood, area, and landmarks in your business description and Google Posts to rank better for these.`
        });
      }

      // Terms trend (compare latest two months if available)
      if (overviewRecords.length >= 2) {
        const prev = overviewRecords[overviewRecords.length - 2];
        const prevTopTerm = prev.searchTerms?.[0]?.term;
        const currTopTerm = terms[0]?.term;
        if (prevTopTerm && currTopTerm && prevTopTerm !== currTopTerm) {
          insights.push({
            type: 'info', icon: '📊',
            title: 'Search Intent Shift',
            body: `Top search term changed from "${prevTopTerm}" (${MONTH_NAMES[prev.month-1]}) to "${currTopTerm}" (${MONTH_NAMES[latest.month-1]}). Track this shift — it may reflect seasonal demand or changing customer needs.`
          });
        }
      }
    }

    // ── 8. Search impressions & profile views funnel intelligence ──
    const latestFunnel = completedMetrics
      .filter(m => m.metricType === 'overview' && (m.searchImpressions || m.profileViews))
      .sort((a, b) => a.year - b.year || a.month - b.month)
      .pop();

    if (latestFunnel) {
      const imp  = latestFunnel.searchImpressions || 0;
      const vws  = latestFunnel.profileViews       || 0;
      const acts = latestFunnel.total              || 0;
      const mon  = `${MONTH_NAMES[latestFunnel.month-1]} ${latestFunnel.year}`;

      // View-through rate (views / impressions)
      if (imp > 0 && vws > 0) {
        const vtr = ((vws / imp) * 100).toFixed(1);
        if (parseFloat(vtr) < 5) {
          insights.push({
            type: 'warning', icon: '👁️',
            title: `Low Profile Click-Through: ${vtr}%`,
            body: `In ${mon}, only ${vtr}% of searches that showed your profile led to a view (${vws.toLocaleString()} views from ${imp.toLocaleString()} impressions). Improve your first impression: use a high-quality cover photo, ensure your category and description are keyword-rich, and maintain a 4.5+ star rating.`
          });
        } else if (parseFloat(vtr) >= 15) {
          insights.push({
            type: 'positive', icon: '👁️',
            title: `Strong Click-Through Rate: ${vtr}%`,
            body: `${vtr}% of searches showing your profile resulted in a view — that's excellent. Your listing headline, photo, and rating are compelling. Keep your profile fresh to maintain this.`
          });
        }
      }

      // Action rate (interactions / views)
      if (vws > 0 && acts > 0) {
        const ar = ((acts / vws) * 100).toFixed(1);
        if (parseFloat(ar) < 3) {
          insights.push({
            type: 'warning', icon: '🖱️',
            title: `Low Profile Action Rate: ${ar}%`,
            body: `Only ${ar}% of people who viewed your profile took an action (call, directions, website click) in ${mon}. Consider adding a clear CTA in your description, enabling messaging, and ensuring your phone and address are correct.`
          });
        } else if (parseFloat(ar) >= 10) {
          insights.push({
            type: 'positive', icon: '🖱️',
            title: `High Action Rate: ${ar}%`,
            body: `${ar}% of profile viewers converted to an action in ${mon} — well above average. Your profile is doing a great job converting interest to customer intent.`
          });
        }
      }

      // Impression trend (if we have 2+ funnel records)
      const funnelHistory = completedMetrics
        .filter(m => m.metricType === 'overview' && m.searchImpressions > 0)
        .sort((a, b) => a.year - b.year || a.month - b.month);
      if (funnelHistory.length >= 2) {
        const prev = funnelHistory[funnelHistory.length - 2];
        const curr = funnelHistory[funnelHistory.length - 1];
        if (prev.searchImpressions > 0) {
          const chg = ((curr.searchImpressions - prev.searchImpressions) / prev.searchImpressions * 100).toFixed(1);
          if (Math.abs(chg) >= 20) {
            insights.push({
              type: parseFloat(chg) > 0 ? 'positive' : 'warning',
              icon: '🔍',
              title: `Search Impressions ${parseFloat(chg) > 0 ? '+' : ''}${chg}% Month-over-Month`,
              body: `Your profile appeared in ${curr.searchImpressions.toLocaleString()} searches in ${MONTH_NAMES[curr.month-1]} vs ${prev.searchImpressions.toLocaleString()} in ${MONTH_NAMES[prev.month-1]}.`
                + (parseFloat(chg) < 0 ? ' A drop in impressions usually means a ranking shift — check your category, attributes, and review velocity.' : ' More visibility is great — capitalise with updated posts and a reply to recent reviews.')
            });
          }
        }
      }
    }

    // ── 9. Platform breakdown intelligence ──
    const latestOverviewWithBd = completedMetrics
      .filter(m => m.metricType === 'overview' && m.breakdown)
      .sort((a, b) => a.year - b.year || a.month - b.month)
      .pop();

    if (latestOverviewWithBd) {
      const bd = latestOverviewWithBd.breakdown;
      const total = (bd.searchMobile||0) + (bd.searchDesktop||0) + (bd.mapsMobile||0) + (bd.mapsDesktop||0);
      if (total > 0) {
        const mobilePct = Math.round(((bd.searchMobile||0) + (bd.mapsMobile||0)) / total * 100);
        const mapsPct   = Math.round(((bd.mapsMobile||0)  + (bd.mapsDesktop||0)) / total * 100);

        if (mobilePct >= 70) {
          insights.push({
            type: 'info', icon: '📱',
            title: `${mobilePct}% Mobile Visitors`,
            body: `Most people find you on mobile. Ensure your business photos are portrait-friendly, your phone number is tap-to-call, and your website is fully mobile-optimised.`
          });
        }
        if (mapsPct >= 20) {
          insights.push({
            type: 'info', icon: '🗺️',
            title: `${mapsPct}% Found via Google Maps`,
            body: `Significant Maps traffic. Keep your address, opening hours, and photos up-to-date — Maps users are high-intent and often ready to visit in person.`
          });
        }
      }
    }

    renderInsights(insights);
  }

  function renderInsights(insights) {
    const grid = document.getElementById('insightsGrid');
    document.getElementById('insightsBadge').textContent = insights.length;

    if (!insights.length) {
      grid.innerHTML = '<div class="insights-empty">Not enough data yet for insights. Fetch more months to unlock analysis.</div>';
      return;
    }

    grid.innerHTML = insights.map(ins => `
      <div class="insight-card ${ins.type}">
        <div class="insight-card-head">
          <span class="insight-icon">${ins.icon}</span>
          <span class="insight-title">${ins.title}</span>
        </div>
        <div class="insight-body">${ins.body}</div>
      </div>
    `).join('');
  }

  // ── Business Modal ──
  let _editingBizId = null;

  function openBizModal(bizId) {
    _editingBizId = bizId;
    const modal = document.getElementById('bizModal');
    const title = document.getElementById('bizModalTitle');
    const nameInput = document.getElementById('bizNameInput');
    const idInput = document.getElementById('bizIdInput');
    const deleteBtn = document.getElementById('bizDeleteBtn');

    if (bizId) {
      // Edit mode
      title.textContent = 'Edit Business';
      const opt = document.querySelector(`#businessSelect option[value="${bizId}"]`);
      nameInput.value = opt ? opt.textContent : '';
      idInput.value = bizId;
      idInput.disabled = true;
      idInput.style.opacity = '0.5';
      deleteBtn.style.display = '';
    } else {
      // Add mode
      title.textContent = 'Add Business';
      nameInput.value = '';
      idInput.value = '';
      idInput.disabled = false;
      idInput.style.opacity = '1';
      deleteBtn.style.display = 'none';
    }

    modal.style.display = 'flex';
    setTimeout(() => nameInput.focus(), 50);
  }

  function closeBizModal() {
    document.getElementById('bizModal').style.display = 'none';
    _editingBizId = null;
  }

  async function saveBizModal() {
    const name = document.getElementById('bizNameInput').value.trim();
    const rawId = document.getElementById('bizIdInput').value.trim();

    if (!name) {
      document.getElementById('bizNameInput').focus();
      document.getElementById('bizNameInput').style.borderColor = 'var(--red)';
      setTimeout(() => document.getElementById('bizNameInput').style.borderColor = '', 1500);
      return;
    }

    const id = _editingBizId || rawId || `manual_${Date.now()}`;

    await GBPStorage.saveBusiness({ id, name });
    closeBizModal();
    await loadBusinesses();
    // Select and show the newly added/edited business
    document.getElementById('businessSelect').value = id;
    await selectBusiness(id);
    showToast(_editingBizId ? `Business renamed to "${name}"` : `Business "${name}" added`);
  }

  async function deleteBizModal() {
    const name = document.getElementById('bizNameInput').value.trim() || _editingBizId;
    const confirmed = confirm(`Delete "${name}" and ALL its collected data?\n\nThis cannot be undone.`);
    if (!confirmed) return;

    // Delete all metrics for this business
    const metrics = await GBPStorage.getAllMetricsForBusiness(_editingBizId);
    // We need to call deleteBusiness + remove metrics via background for safety
    // Dashboard is extension-origin so we can call GBPStorage directly
    const db = await GBPStorage.open();
    const tx = db.transaction(['businesses', 'metrics'], 'readwrite');
    tx.objectStore('businesses').delete(_editingBizId);
    for (const m of metrics) {
      tx.objectStore('metrics').delete(m.id);
    }
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });

    closeBizModal();
    state.businessId = null;
    await loadBusinesses();
    showToast(`"${name}" and its data deleted.`);
  }

  // ── Export / Import ──
  async function exportData() {
    try {
      const data = await GBPStorage.exportAll();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `gbp-stats-export-${new Date().toISOString().slice(0,10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast('Data exported successfully!');
    } catch (e) {
      showToast('Export failed: ' + e.message);
    }
  }

  async function importData(e) {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      await GBPStorage.importAll(data);
      showToast(`Imported ${data.businesses.length} businesses, ${data.metrics.length} records`);
      await loadBusinesses();
      if (state.businessId) await selectBusiness(state.businessId);
    } catch (err) {
      showToast('Import failed: ' + err.message);
    }
    e.target.value = '';
  }

  // ── Toast ──
  function showToast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 3500);
  }
})();
