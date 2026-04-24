# Unlimited Google Business Stats — Chrome Extension

> A Chrome MV3 extension that breaks Google Business Profile's 6-month analytics wall.  
> Collects, stores, and visualises **unlimited historical performance data** across all your GBP businesses.

---

## Table of Contents
1. [What It Does](#what-it-does)
2. [Architecture Overview](#architecture-overview)
3. [File-by-File Breakdown](#file-by-file-breakdown)
4. [Data Flow](#data-flow)
5. [Key Technical Decisions](#key-technical-decisions)
6. [Dashboard Features](#dashboard-features)
7. [Extension Panel (Content Script)](#extension-panel-content-script)
8. [Known Issues / Gotchas](#known-issues--gotchas)
9. [Pending / TODO](#pending--todo)
10. [How to Install (Developer Mode)](#how-to-install-developer-mode)
11. [How to Use](#how-to-use)

---

## What It Does

Google Business Profile only shows the last 6 months of performance data. This extension:

- **Auto-captures** metrics every time you visit your GBP Performance page
- **Stores unlimited months** of data in IndexedDB (browser local storage — no server needed)
- **Back-calculates prior-year data** automatically using the Year-over-Year % that Google displays
- **Dashboard** with charts, month comparisons, coverage grid, AI insights, top search terms, performance funnel
- **Multi-business** — tracks all your GBP profiles in one place
- **Export / Import** JSON backup so you can move data between machines

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│  CHROME EXTENSION (MV3)                                              │
│                                                                      │
│  ┌──────────────┐    sendMessage     ┌─────────────────────────┐    │
│  │  content.js  │ ─────────────────► │   background.js         │    │
│  │  (injected   │                    │   (service worker)      │    │
│  │  into GBP    │ ◄───────────────── │                         │    │
│  │  pages)      │    response        │   GBPStorage (IndexedDB)│    │
│  └──────────────┘                    └─────────────────────────┘    │
│          │                                       ▲                   │
│   postMessage                                    │ direct access     │
│   relay for iframe                               │                   │
│          ▼                                 ┌─────┴───────────┐      │
│  ┌───────────────┐                         │  dashboard.html  │      │
│  │  GBP iframe   │                         │  dashboard.js    │      │
│  │  (performance │                         │  dashboard.css   │      │
│  │   tab iframe) │                         └─────────────────┘      │
│  └───────────────┘                                                   │
│                                                                      │
│  popup.html / popup.js  — extension toolbar popup (quick stats)      │
└─────────────────────────────────────────────────────────────────────┘
```

### CRITICAL: Two Different Origins

- **Content script** runs under the *web page origin* (`business.google.com`)
- **Dashboard / popup** run under the *extension origin* (`chrome-extension://...`)
- **IndexedDB databases are per-origin** — they cannot share a database across origins
- **Solution**: ALL IndexedDB reads/writes are done in `background.js` (service worker, extension origin). Content script sends `chrome.runtime.sendMessage()` for every save; dashboard calls `chrome.runtime.sendMessage()` for every read.

---

## File-by-File Breakdown

### `manifest.json`
Chrome MV3 manifest. Key settings:
- `all_frames: true` — content script runs in main GBP page AND in the performance stats iframe
- Host permissions for `business.google.com` and `*.google.com`
- Background service worker: `background.js`

### `storage.js`
Shared IndexedDB wrapper (`GBPStorage` object). Works in both:
- Extension pages (dashboard, popup) via direct import
- Service worker via `importScripts('storage.js')` — exports to `globalThis.GBPStorage`

**Database: `gbp_stats_db` v3**  
Tables (object stores):
| Store | Key | Purpose |
|-------|-----|---------|
| `businesses` | `id` (string) | Business name, Google ID, created date |
| `metrics` | `[businessId, metricType, year, month]` | All metric data |

**Metric types stored:**
- `overview` — total interactions (calls + chats + bookings + directions + website clicks)
- `calls` — phone call clicks
- `chat` — chat message clicks
- `bookings` — booking clicks
- `directions` — direction requests
- `website` — website clicks

Each metric record has:
```js
{
  businessId, metricType, year, month,
  total,       // number: total for the month
  daily,       // array: day-by-day breakdown (may be empty for derived records)
  yoyPercent,  // null or number: year-over-year % Google shows
  derived,     // boolean: true if back-calculated, not directly scraped
  derivedFrom, // {year, month, yoyPercent} — source of back-calculation
  // extra fields for overview:
  searchImpressions,  // "Searches showed your Business Profile"
  profileViews,       // "People viewed your Business Profile"
  searchTerms,        // array of {term, count} top search queries
}
```

### `background.js`
Service worker — the storage bridge. Handles these `chrome.runtime.onMessage` actions:

| Action | Purpose |
|--------|---------|
| `openDashboard` | Opens `dashboard.html` in new tab |
| `saveMetricData` | Saves one metric record + auto-derives prior-year data |
| `getLatestMonth` | Returns newest saved month for a business |
| `getStorageStats` | Returns total businesses + record counts |
| `exportAll` | Dumps all data as JSON |
| `importAll` | Loads JSON backup into IndexedDB |

**Auto-derive logic (in `saveMetricData`):**  
When Google shows "↑114.6% vs Feb 2025" on a Feb 2026 metric, we back-calculate:  
```
prevTotal = Math.round(total / (1 + yoyPercent / 100))
```  
This is saved automatically as a `derived: true` record for Feb 2025 — *only if no real record exists for that month yet.*

### `content.js`
The heavy lifter. Injected into every GBP page frame.

**Main responsibilities:**
1. **Detect** when user is on the GBP Performance page
2. **Inject floating panel** (drag-handle, status display, fetch buttons)
3. **Navigate months** — opens the date picker, clicks each month, waits for data
4. **Extract metrics** from the DOM using text-node walkers and selectors
5. **Send data** to background worker via `chrome.runtime.sendMessage`

**Key functions:**

| Function | What it does |
|----------|-------------|
| `injectPanel()` | Creates the floating draggable panel UI |
| `saveCurrentData()` | Reads the currently displayed month's data and saves it |
| `fetchAll()` | Loops through all available months (date picker), saves each |
| `fetchMissing()` | Same but skips months already in DB (smart update) |
| `openDatePickerAndGetMonths()` | Opens date picker, scrolls to load all months, returns list |
| `extractSummaryMetrics()` | DOM text-walker to find "Searches showed" / "People viewed" values |
| `extractSearchTerms()` | 3-strategy extraction of top search queries from Overview tab |
| `isValidSearchTerm(text)` | Filters out UI labels, dates, percentages, platform names |

**Iframe communication:**  
GBP loads performance stats in an iframe. The parent content script and iframe content script communicate via:
```js
window.postMessage({ _tag: 'GBP_EXT', ... }, '*')
```

**Date picker fix:**  
Month buttons are detached from DOM during re-render (container.innerHTML reset). Added `e.stopPropagation()` on all dynamically created buttons to prevent the outside-click handler from triggering when the button is removed mid-click.

### `content.css`
Styles for the floating panel injected into GBP pages. Dark theme to match Google's UI.

### `dashboard.html`
The main analytics dashboard. Sections:
- **Header** — business selector, sync button, date range picker
- **Stats cards** — key metrics with trend indicators
- **Line chart** — multi-month trend (solid = real data, dashed = estimated)
- **Coverage grid** — visual month-by-month heatmap (green = collected, yellow = estimated, dark = no data)
- **Compare card** — side-by-side comparison (previous year left, selected period right)
- **Performance funnel** — Searches → Profile Views → Interactions funnel
- **Data table** — full monthly breakdown with daily drill-down
- **AI Business Insights** — rule-based analysis panel
- **Discovery section** — platform breakdown + top search terms

### `dashboard.js`
All dashboard logic (~2000+ lines). Key systems:

**Date range:**
- Custom date range picker with click-drag support
- Preset: Last 3 / 6 / 12 months, Year to Date, All Time
- Range is stored in `selectedRange = { startYear, startMonth, endYear, endMonth }`
- Current incomplete month is always excluded from AI insights

**Charts:**
- SVG-based line chart drawn in `drawLineChart()`
- `derivedFlags[]` array tracks which data points are estimated
- Dashed segments + diamond points for estimated (derived) data
- Solid segments + circle points for real data

**Compare card:**
- 3 modes: "vs Same Period Last Year", "vs Previous Period", "Custom Month"
- Shows specific missing months with instructions when no comparison data
- Old year always on left, new year on right

**Coverage grid:**
- `derived-data` CSS class = yellow dashed cell
- `has-data` CSS class = green cell
- `no-data` CSS class = dark cell

**AI Insights:**
- Rule-based (no external API)
- Analyses trends, seasonality, best/worst months
- Excludes current incomplete month
- Detects consistent growth, decline patterns, anomalies

**Business management:**
- Add / edit / rename / delete businesses from dashboard
- Modal dialog for business CRUD operations

### `popup.html` / `popup.js`
Extension toolbar popup. Shows:
- Total businesses tracked
- Total records stored
- List of businesses with click-to-open-dashboard
- Export / Import JSON backup buttons

---

## Data Flow

### Collecting Data (content script → IndexedDB)

```
User visits GBP Performance page
        ↓
content.js detects URL pattern
        ↓
Floating panel injected
        ↓
User clicks "Fetch All Months" or "Update Latest"
        ↓
openDatePickerAndGetMonths() → list of available months
        ↓
For each month:
  1. Click month in date picker
  2. Wait for iframe to load new data
  3. extractSummaryMetrics() → searchImpressions, profileViews
  4. Extract interaction totals from metric cards
  5. Extract daily breakdown from chart
  6. extractSearchTerms() → top queries
  7. sendMessage('saveMetricData', metric) → background.js
  8. background.js saves + auto-derives prior-year record
  9. Panel shows "✅ Saved! overview · Mar 2026 · 160 interactions"
        ↓
After all months:
Panel shows "✅ Update Done! Saved X new records"
```

### Viewing Data (dashboard → IndexedDB)

```
Dashboard opens
        ↓
Loads all businesses from IndexedDB (via background.js)
        ↓
User selects business + date range
        ↓
dashboard.js queries metrics for that range
        ↓
Renders: line chart, coverage grid, compare card,
         funnel, data table, AI insights, discovery
```

---

## Key Technical Decisions

### Why IndexedDB (not chrome.storage)?
`chrome.storage.local` has a 10MB limit. IndexedDB is effectively unlimited — good for years of daily data across many businesses.

### Why route everything through background.js?
Content scripts run under the web page origin, not the extension origin. Two different origins = two different IndexedDB databases. The background service worker is always on the extension origin, so it's the single source of truth.

### Why back-calculate prior year?
Google shows YoY% comparison on every metric card. This lets us derive previous year values mathematically. Every new month you collect automatically fills in the corresponding prior-year month for free — so you start building historical data from day one, not just 12 months after you install the extension.

### Why `stopPropagation()` on date picker buttons?
When a month button is clicked, the container re-renders (innerHTML reset), which detaches the button from the DOM. An "outside click" listener then checks `wrap.contains(event.target)` — but the detached button is no longer inside `wrap`, so the picker closes before the click registers. `stopPropagation()` prevents the outside-click listener from seeing the event at all.

---

## Dashboard Features

| Feature | Status |
|---------|--------|
| Multi-business selector | ✅ Done |
| Custom date range picker | ✅ Done |
| Line chart (real + estimated) | ✅ Done |
| Coverage grid (green/yellow/dark) | ✅ Done |
| Stats cards with YoY% | ✅ Done |
| Compare card (prev year left, current right) | ✅ Done |
| "vs Same Period Last Year" mode | ✅ Done |
| "vs Previous Period" mode | ✅ Done |
| Custom month comparison | ✅ Done |
| Performance Funnel (Searches→Views→Actions) | ✅ Done |
| Data table with daily drill-down | ✅ Done |
| AI Business Insights (rule-based) | ✅ Done |
| Discovery: top search terms | ✅ Done |
| Discovery: platform breakdown | ✅ Done |
| Add/Edit/Delete businesses | ✅ Done |
| Sync instructions modal | ✅ Done |
| Export / Import JSON | ✅ Done |
| Estimated data visual badges | ✅ Done |
| Missing-data hint in compare card | ✅ Done |

---

## Extension Panel (Content Script)

The floating panel injected on GBP Performance pages:

| Button | Action |
|--------|--------|
| 📊 Open Dashboard | Opens `dashboard.html` |
| ⬇️ Fetch All Months | Downloads all available months (up to 18 from Google) |
| 🔄 Update Latest | Only fetches months not yet in DB (smart incremental) |

Status display shows:
- Current business name + last saved date
- Real-time progress during fetch ("Fetching Mar 2026…")
- Final message: "✅ Update Done! Saved X new records"

---

## Known Issues / Gotchas

1. **"Fetch Everything" vs "Update Latest"**  
   For comparison data (e.g., "vs Same Period Last Year") to work, you must run "Fetch All Months" at least once. "Update Latest" only gets months newer than what's already stored.

2. **Search terms extraction reliability**  
   Google's search terms section uses heavily dynamic JSX/React rendering. The extractor uses 3 strategies + a blacklist to avoid capturing UI labels as search terms. May still miss terms if Google changes their DOM structure.

3. **Derived data accuracy**  
   Back-calculated prior-year values are only as accurate as Google's displayed YoY%. Google rounds their percentages, so derived values may be off by a few percent.

4. **Service worker sleep**  
   Chrome MV3 service workers can go idle. The DB connection is re-opened on every message, so this shouldn't cause data loss, but may add ~50ms latency on first save after idle.

5. **Current month exclusion from AI**  
   The current (incomplete) month is excluded from AI insights trends. If you're viewing data in the last week of a month, insights will reflect up to the previous complete month.

---

## Pending / TODO

- [ ] **Verify search terms extraction** works correctly after the latest rewrite (blacklist + 3-strategy approach)
- [ ] **Visual testing** — load extension in browser, run Fetch All on a real business, check dashboard
- [ ] **Chart smoothing** — option for smooth bezier curves vs straight lines
- [ ] **Export to CSV** — currently only JSON export; CSV would be useful for spreadsheets
- [ ] **Email/scheduled reports** — weekly digest of key metrics
- [ ] **Multiple metric type charts** — currently shows one metric at a time; overlay option would help
- [ ] **Goal tracking** — set monthly targets and show progress
- [ ] **Competitor comparison** — placeholder idea; not technically feasible without a different data source
- [ ] **Chrome Web Store submission** — needs privacy policy, screenshots, store listing

---

## How to Install (Developer Mode)

1. Clone this repo:
   ```bash
   git clone https://github.com/SubrataJZ/unlimited-gbp-stats.git
   cd unlimited-gbp-stats
   ```

2. Open Chrome → `chrome://extensions`

3. Enable **Developer mode** (top-right toggle)

4. Click **Load unpacked** → select the cloned folder

5. Pin the extension from the puzzle-piece icon in the toolbar

---

## How to Use

### First Time Setup

1. Click the extension icon → **Go to Google Business Profile**
2. Navigate to **Performance** (or search "performance" in GBP Manager)
3. The floating panel appears on the page
4. Click **Fetch All Months** — this downloads up to 18 months of data
5. Click **Open Dashboard** to see all your data

### Ongoing Updates

- Every time you visit the GBP Performance page, click **Update Latest** (only fetches new months)
- Or click **Fetch All Months** to refresh everything

### Moving Data to Another PC

1. Open extension popup → **Export Data** → saves a `.json` file
2. On the new PC: install extension → open popup → **Import Data** → select the `.json` file

### Dashboard Navigation

- Use the **business selector** (top-left) to switch between profiles
- Use the **date range picker** to zoom into any time period
- **Compare card** supports: vs Same Period Last Year / vs Previous Period / Custom Month
- Click any cell in the **coverage grid** to jump to that month's data
- **Data table** rows are expandable to show daily breakdowns

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Extension framework | Chrome MV3 |
| Storage | IndexedDB (via custom `GBPStorage` wrapper) |
| Charts | Hand-rolled SVG (no external chart library) |
| Styling | Plain CSS (dark theme, CSS variables) |
| Scraping | DOM text-node walkers, MutationObserver, real click simulation |
| AI Insights | Pure JavaScript rule engine (no external API) |
| Background | Chrome Service Worker |

---

## Contributing / Continuing Development

This project was built iteratively using Claude AI (Anthropic). The full session history and technical context is documented in this README. When continuing development:

1. Read this README fully first
2. The most important architectural constraint: **ALL IndexedDB access via background.js messages**
3. Content script ↔ background communication uses `chrome.runtime.sendMessage()`
4. Dashboard ↔ background also uses `chrome.runtime.sendMessage()`
5. Never call `GBPStorage.*` directly from content.js

### Session Context (for Claude AI continuation)
If continuing with Claude AI, provide this summary:
- Extension tracks GBP performance metrics beyond Google's 6-month limit
- MV3 extension: content.js (scraping) → background.js (storage bridge) → IndexedDB
- Dashboard at dashboard.html reads data via background.js messages
- YoY back-calculation creates derived records for prior year automatically
- Search terms extraction uses blacklist + 3-strategy DOM approach
- Date picker bug fixed with stopPropagation() on dynamically created buttons
- Compare card: old year always LEFT, new year always RIGHT
- Derived/estimated data shown with dashed lines + diamond points + yellow "est." badge

---

*Built with Claude AI — Anthropic*
