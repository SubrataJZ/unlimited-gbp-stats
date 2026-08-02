# Changelog - Unlimited Google Business Stats Extension

All notable changes to this project will be documented in this file.

## [1.21.0] - 2026-08-02
- **New: the header month picker now drives the Reviews tab, not just Performance.** Selecting a period shows how many reviews arrived in it, the average rating *of those reviews* (labelled separately so it can't be mistaken for the lifetime average), and how both compare with the same period a year earlier. The "All reviews" list, its sorting and its pagination all follow the selected period too.
- **Note this changes what the reviews list shows by default**: the picker always has a period selected, so the list is now scoped to it. The period block above the list always states the active range and count, and the view falls back to the full unfiltered history whenever the selected range already covers every review you have.
- When there's nothing to compare against, the year-over-year figures read "no prior-year data" rather than inventing a 0 or a −100% drop.
- **Reviews whose date could not be resolved are excluded from period maths and counted openly** ("N reviews without a date excluded"), instead of being quietly dropped into whichever month happened to be selected or dragged through the average.

## [1.20.4] - 2026-08-02
- **Fixed: the pending-upload count grew without bound while uploads were failing** (one profile reported "76 pending"). Re-queuing a push only replaced an existing job if that job had never failed. So the moment an upload started failing — expired sign-in, offline, a rejected payload — every later scrape of the same thing added *another* job instead of replacing it. The number on the header chip was never 76 pieces of unsent data; it was one problem counted 76 times, with 76 doomed retries attached. Re-queuing now always collapses onto the job that already owns that data, and existing bloated queues are compacted automatically on the next sync — no data is discarded, and nothing has to be re-scraped.
- A fresh scrape now also re-arms a push that was sitting in a long backoff, instead of making you wait out as much as six hours to find out whether it works now. The retry ladder itself is preserved, so a genuinely broken upload still backs off rather than hammering the server.
- Note: this fixes the *count*, not necessarily the underlying upload failure. Hover the header chip to see the actual error — an expired sign-in is the most common cause and is fixed by signing in again.

## [1.20.3] - 2026-08-02
- **Fixed: reviewer names still showed "open_in_new" glued to the end** ("Ankit Roy Chowdhuryopen_in_new"). 1.20.1 stripped the icon-font ligature at scrape time, which only protected newly scraped reviews — every name already stored, and every name arriving from the server (which holds the polluted copy), stayed wrong. The scrub now runs on the way INTO local storage, so it covers the server-hydrate path too and the dashboard repairs itself as data flows through, with no re-scrape and no backend migration needed. Repeated icons ("…open_in_newopen_in_new") are handled, and the scrubber is now owned in one place so the scrape path and the storage path cannot drift apart.

## [1.20.2] - 2026-08-01
- **Fixed: the 1–5 star breakdown emptied itself after a scrape.** Only a scrape can read the star histogram — it's rendered on Google's page and the backend has no column for it — but each day's snapshot was saved with a full overwrite. Since 1.18.0 every scrape is followed by a server hydrate, and that hydrate had no histogram to offer, so it wrote an empty one straight over the breakdown the scrape had just captured. The star chart was reliably blank a second or two after a successful fetch. A day's snapshot is now merged rather than replaced: a field is written only when the incoming data actually carries a value, so "I don't know" can no longer overwrite "I do". The same fix protects the average rating from being blanked by a server row that has neither a display rating nor a true average.
- Existing snapshots that were already blanked stay blank until the business is scraped again — either review button repairs them, since both re-read the histogram from the page.

## [1.20.1] - 2026-08-01
- **Fixed: reviewer names were captured with an icon name glued to the end** — "Remo Ghosh" stored as "Remo Ghoshopen_in_new". Google renders the ↗ "open in new tab" icon as a Material Symbols *ligature*: the element's text really is the string `open_in_new`, and reading the name container's `textContent` swallowed it. Icon elements are now stripped before any text is read, with an exact-name fallback for icons that carry no identifying class. The same cleaning is applied to the review date and contributor fields.
- Existing reviews keep the polluted name until they are scraped again. A full **⭐ Fetch Reviews** repairs them (the server updates `authorName` on re-ingest); **🆕 Fetch New Reviews** will not, since it deliberately skips reviews already stored.

## [1.20.0] - 2026-08-01
- **New: "🆕 Fetch New Reviews" — an incremental catch-up that only collects reviews the server doesn't already have.** "Fetch Reviews" re-walks the entire list on every run, which on an established profile means minutes of scrolling to re-collect hundreds of reviews already stored. The new button asks the backend which review ids it holds, switches Google's list to **Newest**, and stops as soon as it walks into that known set — so a routine top-up usually costs one or two screens. The full "Fetch Reviews" is unchanged and remains the right choice for a first capture, for a competitor's profile you've never scraped, or any time you want a guaranteed complete re-read.
- The baseline is the **server's** review ids, never the local copy: a review still queued in the outbox (or one whose upload failed) stays eligible for re-capture instead of being skipped forever. If the backend can't be reached, local ids are used as a fallback and the result says so.
- If the "Newest" sort control can't be found on the current surface, the scan doesn't silently go wrong — it widens the stop threshold and the result panel flags that the sort was unavailable.
- A partial batch no longer corrupts the profile's aggregates: true average, photo count, local-guide count and average reviewer contribution are computed only from a full scrape, so a batch of four new reviews can't overwrite them. Google's own total and displayed rating are still captured every run.

## [1.19.0] - 2026-08-01
- **New: assisted AI replies now work on the Google Search "Reviews" merchant panel** (`google.com/search#mpd=…/customers/reviews`), not just `business.google.com`. Two surface-specific problems had to be solved: (1) that panel renders its editor inside a separate same-origin iframe, so the top document's `HTMLTextAreaElement.prototype` value-setter threw "Illegal invocation" — the insertion now uses the element's *own* window realm; (2) its submit button is labelled "Reply", identical to the button that *opens* the editor, so text alone can't tell them apart — the open/submit discriminator is now structural (the submit control only exists once a sibling "Cancel" appears). Surface detection also no longer keys off the hostname: a page counts as owner-manageable only when a review card actually exposes a Reply control, so read-only views (Maps, someone else's listing) are correctly excluded. The "never click Post" rule is unchanged — the human still submits every reply.
- **Landed the review-dashboard work that CHANGELOG 1.15.0 / 1.15.1 described but that never actually shipped in the extension code**: the "All reviews" list with sorting and Show-100-more / Show-all pagination, the pannable "Reviews per period" chart (◀ Older / Newer ▶ with a range label), per-bar and per-dot hover tooltips, the zoomed dynamic right-hand rating axis, the "5★ reviews to next tier" stat card, and distinct gold/gray colouring for filled vs. empty stars. Those entries stay as-is for history; this is the release that actually contains the code.
- The reviews stat-card row now wraps instead of forcing four fixed columns, so the added card doesn't squeeze the others on narrow windows.

## [1.18.0] - 2026-07-26
- **Fixed: a business would show performance without reviews, or reviews without performance, seemingly at random.** Metrics and reviews were fetched from two different servers on two different credentials, and metrics could only be *read back* from the legacy sync server even though they were also being written to the Postgres backend. Whenever one of those two paths was healthy and the other wasn't, the dashboard rendered half a business. Both now arrive from a single backend call, so "half a business" can no longer happen.
- **Fixed: "No review data yet" appeared over reviews that had actually loaded.** Selecting a business rendered the views immediately while the review pull was still in flight, and the follow-up refresh was skipped unless the Reviews tab was already open at that moment. Both views now render only after the sync settles, and show "Syncing…" while it runs.
- **Fixed: data scraped while offline or with an expired sign-in was silently lost.** Uploads are now held in a durable queue and retried automatically with backoff until the server confirms them, instead of being discarded on the first failure. The header indicator reports what is actually pending and why, rather than always claiming "Up to date".
- **Fixed: one business could be stored under two different ids** (its Google Business Profile id and its Maps id), which is what split performance and reviews apart in the first place. The extension now follows the id the server treats as canonical and merges the duplicate rows automatically.
- **Changed: every scrape now refreshes that business completely.** Whichever button you press, the extension pulls that business's full server history afterwards — so scraping performance also brings its reviews down, and scraping reviews also brings its performance down. The buttons now only control what is re-read from Google, not what the dashboard is able to show.
- **Renamed "Fetch Everything" to "Fetch All Performance"** — it fetches every month of performance data and never fetched reviews, despite the name.
- All of the above is off by default and opt-in via the `gbpSyncV2` extension-storage flag. With it unset, the previous sync behaviour runs unchanged; turning it back off is instant and needs no reinstall. Requires a backend exposing `GET /api/ingest/sync` — against an older backend the new sync fails safely and local data is untouched.

## [1.17.0] - 2026-07-25
- **Added: performance metrics are now also sent to the Postgres backend, alongside the existing sync server.** This is a dual-write — the existing sync path is unchanged and remains the source of truth, and the new push is best-effort: if it fails, nothing else is affected and your local data is untouched. It is the first step in moving metrics off the legacy sync server so history, reports and year-over-year comparisons can live in one place with reviews.
- Can be turned off without an update by setting `gbpBackendMetricsSync` to `false` in extension storage.
- Requires a backend that exposes `POST /api/ingest/metrics`; against an older backend the push simply fails silently and the extension carries on as before.

## [1.16.2] - 2026-07-25
- **Fixed: the collector panel failed to appear at all after the extension was reloaded or updated with a Google tab still open.** The panel's footer read the version via `chrome.runtime.getManifest()` from inside a template literal, and `chrome.runtime` becomes undefined once the extension context is invalidated. Because the throw happened while the HTML string was being built — before the panel was added to the page — one cosmetic version label took down the entire panel and every button on it, with the only clue being a `getManifest` error in the console. Version lookup is now guarded and fails to an empty label; the panel always renders.

## [1.16.1] - 2026-07-17
- **Fixed: assisted AI-reply drafts weren't reaching Google's reply box.** The card element carrying Google's review id doesn't contain the Reply button/textarea on `business.google.com/reviews` — the real card is its parent. Live-verified against a real merchant session and fixed the DOM matching accordingly; also hardened the "never click Post" safety guard with an explicit check against Google's verified submit-button identifier.

## [1.16.0] - 2026-07-17
- **New: "Auto-draft AI replies" (assisted mode, Agency/Pro only).** On the owner's own merchant reviews page (business.google.com), a new "🤖 Auto-draft replies" button loads every un-replied review, generates a neutral, professional AI draft for each via the backend's OpenRouter-powered reply copilot, and inserts the draft text directly into that review's native reply box. The human still clicks Google's own "Post" button for every review — this tool never submits on your behalf, by design. Small-business (Owner) accounts do not see this button; the backend also rejects the underlying draft-generation endpoints for read-only Owner accounts.
- **New backend endpoints:** `POST /api/ai/reply/bulk` (draft up to 50 reviews in one call, with a partial result + budget-stop if the monthly AI cost cap is hit mid-batch) and `GET /api/ai/reviews` (list a business's reviews, optionally filtered to un-replied only).

## [1.15.1] - 2026-07-13
- **New: hover tooltips on "Reviews per period" bars/dots** showing the exact review count and avg rating per period (native SVG `<title>`).
- **New: dynamic right-axis rating scale.** Instead of a fixed 0–5 quarter scale that flattens the avg-rating line near the top, the axis now zooms into the actual rating range and labels it in "nice" 0.1/0.2/0.5/1 steps (e.g. 4.0 / 4.2 / 4.4 / 4.6 / 4.8 / 5.0).
- **New: "5★ reviews to next tier" stat card** — computes how many additional 5★ reviews would push the average rating up to the next 0.1 tier (e.g. 4.1 → 4.2), using the exact star histogram when available so it isn't thrown off by Google's own rounding of the displayed average.
- **Fixed: 1★ reviews were hard to distinguish from 5★ from a glance** — filled (★) and empty (☆) stars now render in distinct colors (gold vs. muted gray) instead of the same gold for both.

## [1.15.0] - 2026-07-12
- **New: "All reviews" list with sorting.** The dashboard's "Recent reviews" section (capped at 50) is now "All reviews": sortable by newest, oldest, highest rating, or lowest rating (date sorting uses the actual review date via `GBPDate.resolveReviewDate`, falling back to capture time). Renders 50 at a time with "Show 100 more" / "Show all" pagination and a "showing X of Y" counter.
- **New: "Reviews per period" chart is pannable.** Dense histories no longer squeeze into one frame — the chart shows a readable window per granularity (60 days / 52 weeks / 24 months / 20 years) with "◀ Older / Newer ▶" buttons that pan half a window per click and a range label (e.g. "Jan 2024 — Dec 2025 (13–36 of 44)"). Controls hide when everything fits; pan position resets on granularity or business change.

## [1.14.4] - 2026-07-06
- **Fixed: performance and reviews no longer split into two separate dashboard businesses.** Performance saves (from the `/local/business/<id>` iframe) were keyed by the GBP **local id** while review scrapes on the `#mpd` panel were keyed by the canonical **CID** (per 1.14.x identity unification) — one business became two rows, each showing only one kind of data. The main frame now passes the DOM-recovered CID to the performance iframe (`businessCid`, like `businessName`), so metric saves use the same canonical id; every save/query also carries the local id as `aliasId`, and a new `GBPStorage.migrateBusinessData()` folds all metrics/snapshots/reviews stored under the alias into the canonical row (never clobbering existing records) and deletes the duplicate business.

## [1.14.3] - 2026-07-06
- **Fixed: review scraping on the merchant "Reviews" panel (`#mpd=…/customers/reviews`) captured 0 reviews.** Three root causes: (1) the outermost `[data-review-id]` element there is an empty action-bar div — `getReviewCards()` now climbs to the enclosing `<article>` when the id element has no content; (2) `parseStarLabel()` matched the "5 star" substring of "3 **out of 5 star**s", reporting every rating as 5★ — "N out of 5" is now tried first, with a filled-star icon count (`i.google-symbols.lMAmUc`) as fallback; (3) review text lives in direct text nodes of `div[jsname="PBWx0c"/"lvvS4b"]` — direct-text extraction added, with junk ("View full review", dish recommendations) excluded.

## [1.13.0] - 2026-06-27
- **Fixed: review cards now extract data on the Search modal (was always returning 0).** The rating and text selectors were Maps-specific CSS classes that don't exist in the Search modal DOM. Added generic fallbacks: rating now walks all card descendants for any `aria-label` containing "star"; text falls back to the longest leaf `span`/`p` in the card (>20 chars) when no known class matches.
- **Fixed: "More reviews" button now correctly identified.** The broad text-match was matching the sort dropdown ("Most relevant…") instead of the pagination button. Primary selector is now `[jsname="V67aGc"]` (the confirmed span for this button), with a strict `^more reviews` regex fallback.

## [1.12.9] - 2026-06-27
- **Fixed: "More reviews" button now reliably found in the Search modal.** The button's visible text lives inside an `aria-hidden` span (`jsname="V67aGc"`) with no `role` attribute, so all previous interactive-element selectors missed it entirely. The clicker now walks ALL elements to match on raw text content, then climbs the DOM to the nearest `button`/`a`/`[jsaction]` ancestor to fire the click there.

## [1.12.8] - 2026-06-27
- **Rewrote scroll loop and "More reviews" clicker for Search modal resilience.**
  - **Scroll:** replaced overflow-container detection with `lastCard.scrollIntoView({ behavior:'smooth', block:'end' })` — lets the browser handle ancestor selection, bypassing Google's nested div traps. Falls back to `doc.defaultView.scrollTo()` when no cards are visible.
  - **"More reviews" click:** switched from start-anchored regex to broad contains-match (`label includes "review" AND ("more"|"all"|"load")`); dispatches full `pointerdown → mousedown → mouseup → click` synthetic event chain with `composed:true` so Google's jsaction framework registers it, followed by a native `.click()` fallback.
  - **Timing:** randomized delay 1500–2500ms per step; extra 1000ms budget after "More reviews" click plus spinner wait.
  - **Logging:** `[SCRAPER-DEBUG]` lines on every scroll step, stall, and click attempt for DevTools diagnosis.

## [1.12.7] - 2026-06-27
- **Fixed: review scraping now breaks past the 100-review lazy-load cap.** The scroll loop now re-resolves the review document on every step (clicking "More reviews" can remount the iframe, invalidating the old reference). Also added a third scroll trigger — `doc.defaultView.scrollTo()` — to drive lazy-loading in the Search modal iframe window directly. Added console logging (`[GBP] scroll stall N/6`) so stalls are visible in DevTools.
- **Fixed: "X reviews stored locally" now shows the total count in local storage**, not just how many were new in the current session. Previously showed 9 (new this session) even when hundreds were already stored.

## [1.12.6] - 2026-06-27
- **Fixed: review scraping now captures the full list on the Search "all reviews" modal.** When clicking "View all Google reviews" from the Search knowledge panel, the scraper was stopping after ~9 reviews despite thousands being available. Root cause: Google's Search modal loads reviews in slow network batches, and the previous 1s post-scroll sleep + 3-stall threshold caused the loop to declare completion before the next batch arrived. Fix: added a `waitForSpinner()` helper that pauses the loop until Google's loading indicator disappears (`.qjESne`, `.oBAxrc`, `[role=progressbar]`, `.YbNNNb`); increased post-scroll sleep to 1.5s; raised the no-growth threshold to 6 consecutive stalls; extended the "More reviews" post-click wait to 2.5s + spinner check.

## [1.12.5] - 2026-06-21
- **Fixed: fetching reviews no longer triggers the "Get more reviews" promote dialog.** On the owner reviews panel, the pagination-button matcher had been broadened in 1.12.3 and was wrongly matching the **"Get more reviews"** button (it contains the substring "more reviews"). The match is now anchored to the start of the label, and promote/reply/share/write controls are explicitly excluded, so only a genuine "More reviews (N)" pagination link is ever clicked.

## [1.12.4] - 2026-06-21
- **Fixed: review scraping now captures the full list instead of only ~3.** The reviews list is virtualized — Google recycles review cards out of the DOM as you scroll — so the previous single end-of-scroll extraction pass only ever saw the last visible window (3–8 cards) regardless of how many had loaded. The scraper now **harvests reviews incrementally on every scroll step** into an id-keyed accumulator, so recycled cards are banked before they disappear.
- Review cards are now located by Google's stable `data-review-id` attribute first (falling back to the `.jftiEf` / `article.VaHEVc` classes only when no id is present), making extraction immune to Google's frequent CSS-class rotation.
- Lazy-loading is now driven by `scrollIntoView()` on the last card in addition to scrolling the detected container, so loading continues even when the exact scroll container can't be identified. The scroll container is re-resolved each step, and the no-growth cutoff was relaxed to three consecutive idle passes.

## [1.12.3] - 2026-06-21
- **Fixed: Maps split-view place panel now scrapes past the initial ~3 review preview.** The "More reviews" pagination button is now matched even when its text has a prefix character, count, or icon before the keyword (e.g. "8 More reviews", "→ More reviews"). The previous `^`-anchored regex silently missed those variants and left scraping stuck at the preview count.

## [1.12.2] - 2026-06-20
- **Fixed: large review sets are now captured past the ~100-review lazy-load cap.** When Google stops auto-loading and shows a "More Reviews" button, the scraper now clicks it to paginate; the Maps search → place-panel "More reviews (N)" link is also opened automatically (previously only the 3-review preview was captured). Capture is bounded to 1,500 reviews per session for stability.

## [1.12.1] - 2026-06-20
- **Fixed: review scraping now loads the full reviews list, not just the ~3 visible preview cards.** Opening a business's reviews now uses a real native click that reliably triggers Google's Reviews panel (the previous synthetic click silently failed), and the scraper scrolls the actual reviews container — found generically rather than via hardcoded Google class names — until no new reviews load.
- Internal: review cards are detected by distinct `data-review-id` (no more inflated counts from nested elements); the scroll loop tracks real growth and stops after two consecutive idle passes; default scroll budget raised to cover ~300 reviews.

## [1.12.0] - 2026-06-20
- **Fixed: the same business is no longer tracked under multiple IDs.** A business captured from a Maps/Search listing card now resolves to its canonical Google CID (parsed from the place link) instead of a name-based slug, so the same business seen on a search card, a Maps place panel, and the Search "all reviews" page collapses to a single tracked profile instead of three.
- The Search "all reviews" (`#mpd`) page now recovers the real CID from the page (place links / `data-fid`) instead of falling back to that surface's local id.
- Internal: shared `extractCidFromUrl()` helper; `extractBusinessId()` refactored to reuse it. Backend reconciles incoming businesses by normalized name+address and backfills the canonical CID when an older slug/empty id is found (no schema change).

## [1.11.0] - 2026-06-19
- **New: Review Momentum panel** — a bento-grid row of six cards inserted above the "Reviews per period" chart, showing at a glance how your reviews are performing:
  - **Momentum** — reviews earned in the latest period of your selected granularity (Day/Week/Month/Year), with a colour-coded up/down/flat arrow and percentage vs the prior period. Direction is conveyed by both colour and glyph, never colour alone.
  - **Forecast** — projected review total 3 months out based on your recent monthly pace, plus the underlying reviews-per-month rate. Shows "Not enough data yet" when there is no history.
  - **Your Records** — trophy-icon rows for your best-ever month and best-ever day by review count. Rows are hidden individually when data is not available.
  - **Streak** — consecutive non-zero periods in a row (respects selected granularity), plus a milestone hint showing how many reviews remain to reach the next milestone (3 → 6 → 12 → 25 → 50 → 100 …).
  - **Monthly Goal ring** — an SVG donut showing this month's review count against an owner-set target (default 10). Target persists per-business in `chrome.storage.local`. Ring turns green and reads "Goal smashed!" when the target is met. Visual fill is capped at 100% but the percentage text shows the true value.
  - **Get More Reviews** — a share card with a Copy review link button that builds the deeplink from the business's `googlePlaceId` (preferred) or `searchUrl`. Clicking copies to clipboard and shows "Copied!" for 2 s. Button is disabled with a hint when no link can be constructed.
- **New: avg-rating overlay on the review rate chart** — a gold line traces the per-bucket average star rating on a right-side 0–5 axis. Line breaks at gap-filled zero buckets (no artificial interpolation). A legend line below the chart reads "bars = review count · line = avg rating". Right padding expanded to 48 px to accommodate the rating labels.
- **New: Review Pace vs Tracked Profiles** — shown below the momentum grid whenever more than one business is tracked. Loads all businesses' reviews in parallel, computes reviews/month for each, and renders a compact ranked horizontal-bar list (top 5) with your profile highlighted in accent blue and labelled "You". Read-only; fails silently on error.
- All momentum/streak/goal cards re-render when the Day/Week/Month/Year granularity toggle changes. Panel hides automatically when the current business has no reviews.
- SVG icons only — no emoji used in new markup (trophy, flame, share/link, arrows are all inline SVG paths).
- Animation transitions wrapped in `@media (prefers-reduced-motion: reduce)` to disable for users who prefer it.

## [1.10.0] - 2026-06-19
- **New: review insight computations** — five pure, unit-tested functions added to `review-date.js` and exposed on `window.GBPDate` / `module.exports`, powering an upcoming Review Momentum panel:
  - `avgRating` per bucket — each period bucket now carries a rounded average star rating (null for zero-count gap buckets).
  - `computeMomentum(reviews, granularity, now)` — compares the last two periods and returns `{ current, previous, deltaPct, direction }` for velocity trend arrows.
  - `computeForecast(reviews, now)` — averages the last ≤6 months and returns `{ perMonth, projectedTotal, byLabel }` projecting 3 months ahead.
  - `computeBestPeriods(reviews, now)` — returns `{ bestMonth, bestDay }`: the highest-count month and day buckets (ties → earliest).
  - `computeStreak(reviews, granularity, now)` — counts consecutive non-zero buckets from the most recent end; gap-filled zeros break the streak.
- **New: pre-commit guard for review-date tests** — if `review-date.js` or `review-date.test.js` is staged, the hook runs `node unlimited-gbp-stats/review-date.test.js` and blocks the commit on failure (skips gracefully when `node` is absent).

## [1.9.0] - 2026-06-19
- **Fixed: the review trend now tracks when reviews were actually written — not when you fetched them.** The "reviews over time" chart used to plot data against each *capture* date, so the line only moved on days you clicked Fetch Reviews. It now buckets your individual reviews by their real review dates, so a single fetch instantly shows your full multi-year history.
- **New: review-rate granularity toggle — Day / Week / Month / Year.** See how many reviews you're earning per period, with continuous gap-filled timelines (quiet periods show as zero, so the trend is honest).
- The "New reviews (period)" stat now reflects the most recent period of the selected granularity (previously it showed the number of capture sessions).
- Internal: the normalized review date (`reviewedAtISO`) is now persisted locally; a shared `review-date.js` utility parses absolute ("7 Feb 2023"), relative ("2 weeks ago"), and ISO dates, with unit-test coverage guarding against the fetched-date regression.

## [1.8.3] - 2026-06-19
- **Review Audit capture (feeds the new server-side audit report).** The review scraper now captures richer per-review signals used by the deep audit: each reviewer's total review count (`authorReviewCount`), whether the owner responded (`ownerResponded`), and a normalized `YYYY-MM-DD` review date parsed from Google's relative strings ("2 weeks ago", "a month ago", "June 2025").
- **Search "all reviews" panel + Maps coverage.** Review cards are now read from both surfaces: Maps (`.d4r55` / `.wiI7pd` / `.rsqaWe`) and the Search/business reviews panel (`.PskQHd` / `.Fv38Af` / `.KEfuhb`), with the Maps selectors kept as fallbacks. The Search "all reviews" page (`#mpd=~…/customers/reviews`) is now recognized, and its cards — which render inside a same-origin iframe — are resolved and scraped correctly.
- Internal: snapshot extraction resolves the correct review document automatically; owner-response detection uses a text-regex primary with a class fallback.

## [1.7.0] - 2026-06-15
- **New: per-listing Review buttons in Google Maps / Search results.** A button row (⭐ Review · 🔗 Open reviews) is now injected under **each** business in the results — yours and competitors. Clicking **Review** captures that listing's name, rating, and review count directly from the card (robust — no need to open a panel) and sends it as a snapshot; it also best-effort opens the business's reviews in a background tab to scrape individual reviews.
  - Card detection is class-light and resilient (finds results by their rating+review-count pattern, with fallbacks) and logs what it matched to the page console for easy diagnosis as Google's DOM changes.
  - Competitor listings are recorded as tracked businesses (`isOwn: false`) and appear in the dashboard's business switcher so their review trend can be viewed.
  - Fixes the earlier limitation where "Fetch Reviews" only worked with a business's review panel already open.

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
