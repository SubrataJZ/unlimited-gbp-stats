# Changelog - Unlimited Google Business Stats Extension

All notable changes to this project will be documented in this file.

## [1.6.0] - 2026-06-15
- **New: Review tracking in the same extension.** One extension now crawls review data alongside performance metrics — no second tool needed.
  - **Fetch Reviews** button on the floating panel scrapes a dated snapshot (total reviews, average rating, 1–5 star distribution) plus individual review cards (author, rating, text, Local Guide / photo flags). The panel now also appears on Google Maps / business review pages, not just the Performance page.
  - Dashboard gains a **Performance / Reviews** view switcher. The Reviews view shows review-count trend, average-rating trend, star distribution, and a recent-reviews list.
  - Review data is stored locally (IndexedDB `gbp_unlimited_stats` upgraded v1→v2, additive — existing data untouched) and synced to the **Postgres backend** at `POST /api/ingest/intel` (read back via `GET /api/ingest/intel`), published at `https://gbp.zixify.zixai.in/backend`.
  - **Backend auto-connect:** signing in with Google now also connects the backend — it exchanges the Google token for a backend session (`POST /api/auth/google/extension`) and provisions a per-user `zx_` ingest key automatically. No manual key setup.

## [1.5.4] - 2026-06-14
- **Security: Harden sync-server JWT secret** — removed hardcoded fallback `change-this-secret-in-env`; server now throws and exits at boot if `JWT_SECRET` env var is missing or empty (sync server v1.1.2).
- **Security: Tighten extension host permissions** — removed over-broad `"https://*/*"` wildcard from `host_permissions` in manifest.json; kept all specific origins (`business.google.com`, `*.google.com`, `localhost`, `gbp.zixify.zixai.in`). This resolves a Chrome Web Store policy violation.

## [1.5.3] - 2026-06-14
- **Fixed: Year-over-Year (YoY) % comparison was inaccurate on the chart.** Three root causes:
  - `getMetricsForRange` returns a *sparse* array (missing months omitted), so the current series and the comparison series were paired by array index — any gap silently compared the wrong months. Comparison values are now aligned to each current month **by calendar** (same month one year earlier for YoY).
  - The green % label on the chart showed month-over-month change even in YoY compare mode. It now shows the exact % change vs the matching comparison month (same month last year) when comparison is active, and falls back to month-over-month only when no comparison is enabled.
  - The tooltip YoY lookup never matched (key `"2025-03"` vs label `"Mar 2025"`); the % is now computed directly from the aligned values.
- Comparison line now renders contiguous segments so a missing comparison month no longer drags the line to zero, and missing months show a `⊖ pending` indicator instead of a wrong %.

## [1.5.2] - 2026-06-14
- Fixed version text color in the floating panel footer (was dark `#444` on dark background and invisible) — now white

## [1.5.1] - 2026-06-14
- **Fixed: version number never updated in the UI.** All version displays were hardcoded `v1.1.0` and ignored the manifest. They now read dynamically from a single source of truth so a manifest bump propagates everywhere automatically:
  - popup header, dashboard topbar + footer + tab title → `chrome.runtime.getManifest().version`
  - content-script floating panel → `chrome.runtime.getManifest().version`
  - sync-server `/health` endpoint → reads `package.json` version (was hardcoded `2.1.0`)

## [1.5.0] - 2026-06-14
- Reworked Google sign-in to use `chrome.identity.launchWebAuthFlow` with `prompt=select_account` so users can pick any Google account (not just Chrome's default)
- Uses `chrome.identity.getRedirectURL()` for the redirect URI instead of a hand-built string
- Rotated Google OAuth client to a Web Application client: `512083455568-3caijv22kvq0g5n2i1oajg3bmergclpb` (kept in sync across manifest.json and background.js)
- Sync server URL now points to the domain `https://gbp.zixify.zixai.in` (via nginx) instead of a raw IP:port
- Added a pre-commit SemVer guard (`.githooks/pre-commit`) so version bumps + CHANGELOG updates are mechanically enforced

## [1.4.0] - 2026-06-14
- Added "Continue with Google" sign-in to the Cloud Sync modal (dashboard) for both Sign In and Register tabs
- Switched Google OAuth from `launchWebAuthFlow` to `chrome.identity.getAuthToken` (no redirect URI needed — fixes `redirect_uri_mismatch`)
- Added `oauth2` block and `identity` permission to manifest.json
- Restored locked OAuth client ID (`512083455568-4o7052vjg67pl21vojekgrs0qcta4a1n`) — the code had drifted to a wrong ID
- Server (`gbp-stats-sync-server` → v1.1.0): added `POST /api/auth/google` endpoint, `google_id` column with auto-migration, and Google user prepared statements
- Fixed gbp-server Dockerfile to use `npm install` instead of `npm ci` (no committed lockfile)

## [1.3.1] - 2026-06-12
- Fixed month-to-month growth percentage calculation accuracy
- Only show growth % when both current and previous months have real (non-estimated) data
- Show "⊖ pending" indicator in orange when year-over-year comparison data is missing
- Prevents inaccurate percentages from displaying when data is derived from comparison year

## [1.3.0] - 2026-06-12
- Added month-to-month percentage growth display on chart data points
- Growth percentages now show above each point (green for increases, red for decreases)
- Only displayed in multi-month view for clarity and relevance
- Helps visualize momentum and trends across selected period

## [1.2.0] - 2026-06-12
- Updated version to 1.2.0 (semantic versioning implemented)
- Locked OAuth2 client ID: `512083455568-4o7052vjg67pl21vojekgrs0qcta4a1n.apps.googleusercontent.com`
- Set up semantic versioning strategy (PATCH/MINOR/MAJOR)
- Established version logging system

## [1.1.0] - Previous
- Previous version (baseline)

---

### Version Format
- **PATCH** (1.x.Y): Bug fixes, security patches, non-breaking changes
- **MINOR** (1.X.0): New features, enhancements
- **MAJOR** (X.0.0): Breaking changes
