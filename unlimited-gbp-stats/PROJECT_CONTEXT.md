# PROJECT_CONTEXT — Unlimited GBP Stats

> **Last updated:** 2026-04-27  
> Use this file to resume work after moving the project to a new machine/session.

---

## 1. Architecture — Zix AI v3 / Unlimited GBP Stats

This is a **Chrome Extension (Manifest V3)** that lets digital marketers collect Google Business Profile performance data beyond Google's 6-month limit, store unlimited history locally, compare any date ranges, and share professional reports with clients.

### File map

| File | Role |
|------|------|
| `manifest.json` | MV3 manifest — permissions, content scripts, service worker |
| `background.js` | Service worker — all IndexedDB writes + **cloud server sync** |
| `storage.js` | IndexedDB wrapper (`GBPStorage`) — shared by dashboard + background |
| `content.js` | Content script injected into GBP pages — scrapes performance data, shows floating panel |
| `content.css` | Styles for the floating collector panel |
| `dashboard.html/js/css` | Full analytics dashboard — charts, comparison, insights, report generator |
| `popup.html/js` | Extension popup — quick stats + business list |
| `server/server.js` | **NEW** Node.js + Express + SQLite sync server |
| `server/package.json` | Server dependencies (express, better-sqlite3, cors, dotenv) |
| `server/.env.example` | Template for server environment config |

### Data flow

```
GBP Performance Page (Google)
        │  content.js scrapes DOM
        ▼
background.js  ──────► IndexedDB (local, extension origin)
        │
        └──────────► POST /api/sync  ──► server/server.js ──► SQLite (server)
                          (fire & forget, silent on failure)

Dashboard open:
  GET /api/business/:locationCode?since=<lastPull>
        │
        └── merge new records into local IndexedDB ──► re-render dashboard
```

### Business identification

The **Google numeric location code** (e.g. `12314840327329864086`) is extracted from the GBP URL patterns:
- `/local/business/{CODE}/`  
- `/dashboard/l/{CODE}/`  

This same code is used as the primary key in both local IndexedDB **and** the sync server.  
It is the code visible in URLs on `https://business.google.com/locations`.

---

## 2. Tasks just finished (2026-04-27)

### ✅ Report Generator
- Added a blue **"Report"** button to the dashboard topbar
- On click → downloads a self-contained `.html` file (light-themed, printable as PDF)
- Report sections: Executive Summary (6 metric cards), Interaction Trend (SVG chart), Performance Funnel, Platform & Device Breakdown, Top Search Terms, AI Insights, Monthly Data Table
- Tip in footer: "File → Print → Save as PDF"

### ✅ Client–Server Sync System
- Created `server/server.js` — full REST API with SQLite storage
  - `GET  /health` — no auth, used for connection test
  - `POST /api/sync` — save one metric record
  - `POST /api/sync-bulk` — save many records at once
  - `GET  /api/business/:locationCode` — pull all (or delta) data for a business
  - `GET  /api/businesses` — list all businesses on server
- Updated `background.js`:
  - After every `saveMetricData` → fire-and-forget `POST /api/sync`
  - New message handlers: `pullFromServer`, `testServerConnection`, `getServerConfig`, `saveServerConfig`
- Added **☁ Cloud Sync** button + modal to `dashboard.html/css/js`:
  - Server URL + API key fields
  - Show/hide key toggle
  - "Test Connection" button (hits `/health`)
  - "Pull All from Server" button (merges delta data into local DB)
  - Auto-pull silently on every business select (if server configured)
- Updated `manifest.json`: added `"https://*/*"` and `"http://localhost/*"` to `host_permissions` so the background worker can reach any self-hosted server

---

## 3. Next steps / bugs to tackle

### Pending features
- [ ] **`business.google.com/locations` scraper** — auto-capture all location codes when user visits the locations list page (content.js addition)
- [ ] **Bulk upload** — "Push all local data to server" button in the Cloud Sync modal (calls `POST /api/sync-bulk` for each business)
- [ ] **Multi-user / agency mode** — server supports multiple marketers, each with their own API key and business namespace
- [ ] **Server push notifications** — webhook/email when new data is synced
- [ ] **Auto-sync on schedule** — background service worker alarm every 24h

### Known rough edges
- `doPullFromServer` in dashboard.js calls `loadMetricData()` + `renderCoverageGrid()` after pull — but does not re-trigger comparison data reload if compare mode is active
- The `updateCloudButton('unconfigured')` call hits a case not handled in `updateCloudButton()` — falls through to the `else` branch (shows "Cloud Sync"), which is fine but could be explicit
- `extractSearchTerms()` in content.js: "See more" click detection may break if Google updates class names (monitor `.HEmY3c`)
- Date picker month detection uses `.HEmY3c` — same fragility concern

---

## 4. Key decisions made

### UI decisions
- **Dark theme only** — dashboard uses `#1a1a2e` base; the downloadable HTML report uses a **light theme** for client-facing sharing
- **Report is a .html file**, not PDF — avoids server-side rendering; user prints to PDF via browser
- **Cloud Sync is optional** — all local functionality works without a server; the sync button is clearly secondary in the topbar
- **Auto-pull is silent** — no toast when pulling on business select (only shows count if > 0 records merged); full-pull shows toasts
- **SVG charts rendered inline** — no chart library dependency; pure SVG string generation in both dashboard and report

### Architecture decisions
- **Background service worker as storage bridge** — content scripts can't access extension-origin IndexedDB; all writes go through `chrome.runtime.sendMessage → background.js`
- **Fire-and-forget server sync** — local save NEVER blocked by server availability; server failures are logged silently
- **Google location code = primary key everywhere** — same numeric ID used in IndexedDB, server SQLite, and API URLs; no manual ID mapping needed
- **SQLite on server** — simple, zero-dependency, self-contained; easy to back up (single `.sqlite` file); no Postgres/MySQL setup required
- **`?since=timestamp` delta pull** — avoids re-downloading thousands of records on every dashboard open; only new records since last pull are fetched
- **Derived data (YoY back-calculation)** — when Google shows "+114% vs last year", the prior year's value is calculated and stored with `derived: true`; real data always wins over derived on conflict

### MCP tool decisions
- No MCP tools used in the extension itself — all Chrome APIs only
- Server is plain Node.js; can be deployed without any cloud SDK

---

## 5. Setup reminders for new machine

### Extension
1. Open `chrome://extensions` → Enable Developer mode
2. Click "Load unpacked" → select the `unlimited-gbp-stats/` folder
3. Visit `https://business.google.com/` → open Performance → use the floating panel

### Sync Server (optional)
```bash
cd unlimited-gbp-stats/server
npm install
cp .env.example .env
# Edit .env: set API_KEY and PORT
npm start
```
Then in the dashboard → click **☁ Cloud Sync** → enter `http://localhost:3000` + your API key → Save.

### Deploy server (Railway / Render)
- Push `server/` folder as a Node.js service
- Set env vars: `API_KEY`, `PORT`, `DB_PATH=/data/gbp_data.sqlite`
- Point the dashboard Cloud Sync URL to your deployed URL
