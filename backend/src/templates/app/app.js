/* Web dashboard client — served by app.routes.ts at …/app/.
   Read-only view of GET ../api/app/overview. Auth: the httpOnly refresh cookie
   (set by the login page) is exchanged for an access token at ../api/auth/refresh;
   without it we send the user to the login page, which brings them back here.
   The pure helpers at the top are exported for tests (backend/tests). */
(function () {
  'use strict';

  var METRICS = [
    ['overview', 'Interactions'], ['calls', 'Calls'], ['directions', 'Directions'],
    ['website_clicks', 'Website clicks'], ['bookings', 'Bookings'], ['chat_clicks', 'Chat'],
  ];
  var RANGES = [[6, '6 months'], [12, '12 months'], [24, '24 months']];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // ── Pure helpers ─────────────────────────────────────────────────────────
  function ym(y, m) { return y * 12 + (m - 1); }
  function fromYm(v) { return { y: Math.floor(v / 12), m: (v % 12) + 1 }; }

  /** rows: [type, year, month, total, isEstimate] → Map "type|ym" → {v, est} */
  function indexMetrics(rows) {
    var idx = new Map();
    (rows || []).forEach(function (r) { idx.set(r[0] + '|' + ym(r[1], r[2]), { v: r[3], est: !!r[4] }); });
    return idx;
  }

  /** Newest month holding any value for this metric, or null. */
  function latestYm(rows, type) {
    var best = null;
    (rows || []).forEach(function (r) {
      if (r[0] === type && (best === null || ym(r[1], r[2]) > best)) best = ym(r[1], r[2]);
    });
    return best;
  }

  /** `months` consecutive months ending at endYm, each with the same month a year earlier. */
  function buildSeries(idx, type, endYm, months) {
    var out = [];
    for (var v = endYm - months + 1; v <= endYm; v++) {
      var cur = idx.get(type + '|' + v), prev = idx.get(type + '|' + (v - 12));
      var d = fromYm(v);
      out.push({
        y: d.y, m: d.m,
        v: cur ? cur.v : null, est: cur ? cur.est : false,
        prev: prev ? prev.v : null, prevEst: prev ? prev.est : false,
      });
    }
    return out;
  }

  /** % change, or null when there is no baseline to divide by. */
  function pct(now, before) {
    if (now == null || !before) return null;
    return ((now - before) / before) * 100;
  }

  /** Totals over months present in BOTH years, so a missing month can't fake a rise or a fall. */
  function compareTotals(series) {
    var now = 0, prev = 0, n = 0;
    series.forEach(function (p) { if (p.v != null && p.prev != null) { now += p.v; prev += p.prev; n++; } });
    var all = series.reduce(function (a, p) { return a + (p.v || 0); }, 0);
    return { total: all, now: now, prev: n ? prev : null, change: n ? pct(now, prev) : null, months: n };
  }

  var api = { ym: ym, fromYm: fromYm, indexMetrics: indexMetrics, latestYm: latestYm,
    buildSeries: buildSeries, pct: pct, compareTotals: compareTotals };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document === 'undefined') return;

  // ── UI ───────────────────────────────────────────────────────────────────
  var $ = function (id) { return document.getElementById(id); };
  var state = { token: null, businesses: [], biz: null, metric: 'overview', months: 12 };

  function status(msg) { $('status').textContent = msg; $('status').hidden = !msg; }
  function fmt(n) { return n == null ? '–' : Math.round(n).toLocaleString(); }
  function fmtPct(p) { return p == null ? '–' : (p > 0 ? '+' : '') + p.toFixed(1) + '%'; }
  function cls(p) { return p == null ? '' : p > 0 ? 'up' : p < 0 ? 'down' : ''; }
  function el(tag, text, className) {
    var e = document.createElement(tag);
    if (text != null) e.textContent = text; // textContent: review text is untrusted
    if (className) e.className = className;
    return e;
  }

  async function refreshToken() {
    try {
      var r = await fetch('../api/auth/refresh', { method: 'POST', credentials: 'include' });
      if (!r.ok) return null;
      return (await r.json()).accessToken || null;
    } catch (e) { return null; }
  }
  function toLogin() { location.replace('../auth/login?next=app'); }

  async function loadOverview() {
    var get = function () {
      return fetch('../api/app/overview', { headers: { Authorization: 'Bearer ' + state.token } });
    };
    var r = await get();
    if (r.status === 401) { state.token = await refreshToken(); if (!state.token) return null; r = await get(); }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return (await r.json()).businesses || [];
  }

  function tabs(container, items, current, onPick) {
    container.innerHTML = '';
    items.forEach(function (it) {
      var b = el('button', it[1]);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(it[0] === current));
      b.addEventListener('click', function () { onPick(it[0]); });
      container.appendChild(b);
    });
  }

  var SVG = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs) {
    var e = document.createElementNS(SVG, tag);
    Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    return e;
  }

  function drawChart(series) {
    var svg = $('chart');
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    // Draw at the real on-screen width so text stays legible on a phone
    // (a fixed 640-wide viewBox shrank 11px labels to ~6px at 375px wide).
    var W = Math.round(Math.max(300, Math.min(760, svg.getBoundingClientRect().width || 640)));
    var H = 240, L = 44, R = 12, T = 14, B = 28;
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    var vals = [];
    series.forEach(function (p) { if (p.v != null) vals.push(p.v); if (p.prev != null) vals.push(p.prev); });
    var max = Math.max.apply(null, vals.concat([1]));
    var x = function (i) { return L + (series.length > 1 ? i * (W - L - R) / (series.length - 1) : (W - L - R) / 2); };
    var y = function (v) { return T + (H - T - B) * (1 - v / max); };

    [0, 0.5, 1].forEach(function (f) {
      var v = max * f;
      svg.appendChild(svgEl('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: '#262a36' }));
      var t = svgEl('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end' });
      t.textContent = fmt(v);
      svg.appendChild(t);
    });

    function line(key, attrs) {
      var d = '';
      series.forEach(function (p, i) {
        if (p[key] == null) return;
        d += (d && series[i - 1] && series[i - 1][key] != null ? 'L' : 'M') + x(i) + ',' + y(p[key]);
      });
      if (d) svg.appendChild(svgEl('path', Object.assign({ d: d, fill: 'none' }, attrs)));
    }
    line('prev', { stroke: '#8b92a5', 'stroke-width': 2, 'stroke-dasharray': '6 4' });
    line('v', { stroke: '#4f8ef7', 'stroke-width': 2.5 });

    var step = Math.max(1, Math.ceil(series.length / Math.max(3, Math.floor(W / 80))));
    series.forEach(function (p, i) {
      if (p.v != null) {
        svg.appendChild(svgEl('circle', {
          cx: x(i), cy: y(p.v), r: 3.5,
          fill: p.est ? '#0f1117' : '#4f8ef7', stroke: '#4f8ef7', 'stroke-width': 2,
        }));
      }
      if (i % step === 0 || i === series.length - 1) {
        // Edge labels anchor inward so they aren't clipped by the viewBox.
        var anchor = i === 0 ? 'start' : i === series.length - 1 ? 'end' : 'middle';
        var t = svgEl('text', { x: x(i), y: H - 8, 'text-anchor': anchor });
        t.textContent = MONTHS[p.m - 1] + ' ' + String(p.y).slice(2);
        svg.appendChild(t);
      }
    });
  }

  function renderPerformance(b) {
    var idx = indexMetrics(b.metrics);
    var end = latestYm(b.metrics, state.metric);
    $('perf').hidden = end == null;
    $('noPerf').hidden = end != null;
    if (end == null) return;

    var series = buildSeries(idx, state.metric, end, state.months);
    var t = compareTotals(series);
    var first = series[0], last = series[series.length - 1];
    var period = MONTHS[first.m - 1] + ' ' + first.y + ' – ' + MONTHS[last.m - 1] + ' ' + last.y;
    $('kpiLabel').textContent = period;
    $('legendNow').textContent = period;
    $('kpiNow').textContent = fmt(t.total);
    $('kpiPrev').textContent = fmt(t.prev);
    $('kpiPct').textContent = fmtPct(t.change);
    $('kpiPct').className = 'value ' + cls(t.change);
    drawChart(series);

    var tbody = document.querySelector('#months tbody');
    tbody.innerHTML = '';
    series.slice().reverse().forEach(function (p) {
      var tr = el('tr');
      tr.appendChild(el('td', MONTHS[p.m - 1] + ' ' + p.y));
      tr.appendChild(el('td', fmt(p.v) + (p.est ? ' est.' : ''), p.est ? 'est' : ''));
      tr.appendChild(el('td', fmt(p.prev) + (p.prevEst ? ' est.' : ''), p.prevEst ? 'est' : ''));
      var c = pct(p.v, p.prev);
      tr.appendChild(el('td', fmtPct(c), cls(c)));
      tbody.appendChild(tr);
    });
  }

  function renderReviews(b) {
    $('rating').textContent = b.rating != null ? '★ ' + b.rating.toFixed(1) : 'No rating yet';
    $('ratingCount').textContent = b.totalReviews != null ? b.totalReviews.toLocaleString() + ' reviews on Google' : '';
    var ul = $('reviews');
    ul.innerHTML = '';
    if (!b.reviews.length) { ul.appendChild(el('li', 'No reviews collected yet — fetch them from Google Maps with the extension.', 'muted')); return; }
    b.reviews.forEach(function (r) {
      var li = el('li');
      var meta = el('div', null, 'meta');
      meta.appendChild(el('span', '★'.repeat(r.rating) + '☆'.repeat(5 - r.rating), 'stars'));
      meta.appendChild(document.createTextNode(r.author + (r.at ? ' · ' + new Date(r.at).toLocaleDateString() : '')));
      meta.appendChild(el('span', r.replied ? 'Replied' : 'No reply', 'tag ' + (r.replied ? 'ok' : 'no')));
      li.appendChild(meta);
      if (r.text) li.appendChild(el('div', r.text));
      ul.appendChild(li);
    });
  }

  function render() {
    var b = state.businesses.find(function (x) { return x.id === state.biz; }) || state.businesses[0];
    tabs($('metrics'), METRICS, state.metric, function (m) { state.metric = m; render(); });
    tabs($('ranges'), RANGES, state.months, function (n) { state.months = n; render(); });
    renderPerformance(b);
    renderReviews(b);
  }

  async function boot() {
    state.token = await refreshToken();
    if (!state.token) return toLogin();
    try {
      var list = await loadOverview();
      if (list === null) return toLogin();
      state.businesses = list;
    } catch (e) {
      return status('Could not load your data (' + e.message + '). Check your connection and reload.');
    }
    $('signOut').hidden = false;
    if (!state.businesses.length) {
      return status('No businesses yet. Capture your Google Business Profiles with the extension and they will appear here.');
    }
    var sel = $('biz');
    state.businesses.forEach(function (b) {
      var o = el('option', b.name + (b.isOwn ? '' : ' (competitor)'));
      o.value = b.id;
      sel.appendChild(o);
    });
    try { state.biz = localStorage.getItem('gbpBiz'); } catch (e) { /* storage blocked */ }
    if (!state.businesses.some(function (b) { return b.id === state.biz; })) state.biz = state.businesses[0].id;
    sel.value = state.biz;
    sel.addEventListener('change', function () {
      state.biz = sel.value;
      try { localStorage.setItem('gbpBiz', state.biz); } catch (e) { /* storage blocked */ }
      render();
    });
    status('');
    $('dash').hidden = false;
    render();
  }

  $('signOut').addEventListener('click', async function () {
    try {
      await fetch('../api/auth/logout', { method: 'POST', credentials: 'include',
        headers: { Authorization: 'Bearer ' + state.token } });
    } catch (e) { /* signing out locally anyway */ }
    toLogin();
  });

  var resizeTimer;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { if (!$('dash').hidden) render(); }, 150);
  });

  boot();
})();
