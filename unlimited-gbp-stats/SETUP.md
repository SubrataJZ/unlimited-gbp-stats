# Unlimited GBP Stats — Setup Guide

## Step 1: Generate Icons (one-time)

Open a terminal in this folder and run:
```
node create-icons.js
```
This creates `icons/icon16.png`, `icons/icon48.png`, `icons/icon128.png`.

---

## Step 2: Load the Extension in Chrome

1. Open Chrome and go to: `chrome://extensions`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **"Load unpacked"**
4. Select this entire folder: `2nd Try Unlimited Google Stats`
5. The extension icon (blue chart) will appear in your Chrome toolbar

---

## Step 3: Collect Your Data

1. Log into your Google Business Profile at **business.google.com**
2. Navigate to the **Performance** section of your business
3. A floating panel labeled **"GBP Stats Collector"** will appear in the bottom-right
4. Click **"Fetch Everything"** — the extension will automatically click through all metric tabs (Calls, Chat clicks, Bookings, Directions, Website clicks) and all available months (6 months back), saving each to local storage
5. Repeat this monthly or weekly to keep building your historical archive

> **Tip:** Google only shows 6 months. The more often you run "Fetch Everything", the deeper your history becomes over time. After a year of use, you'll have data going back 18 months — far beyond what Google shows.

---

## Step 4: Open the Dashboard

- Click the extension icon → **"Open Dashboard"**
- Or click **"Open Dashboard"** in the floating collector panel

---

## Dashboard Features

| Feature | How to use |
|---|---|
| **Business switcher** | Dropdown at the top — switches between all tracked businesses |
| **12-month view** | Date picker lets you select any range of months (not limited to 6) |
| **Historical comparison** | Toggle "Compare with historical month" → select any past month |
| **Year-over-year** | Automatically shows % change vs same month last year (when both are available) |
| **Coverage grid** | Click any month cell to jump directly to that month's data |
| **Daily breakdown** | Single-month view shows day-by-day data with bar chart |
| **Export/Import** | Top-right buttons — export all data as JSON for backup or transfer |

---

## Multiple Businesses

The extension automatically detects which business you're viewing on Google Business Profile. When you run "Fetch Everything" on Business A, then switch to Business B and run it again — both are stored and appear in the dashboard business switcher.

---

## Data Storage

All data is stored **locally in your browser** using IndexedDB (unlimited storage). Nothing is sent to any server. The JSON export is your backup.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Floating panel doesn't appear | Make sure you're on the Performance page (not just the GBP home page). Reload the page. |
| "Incomplete data" message | You may be on a multi-month view. The picker might be showing a range (e.g. Nov 2025–Apr 2026). Switch to single-month view first. |
| Chart not showing | Select a single month that has collected data (green in the coverage grid) |
| Icons missing in Chrome toolbar | Run `node create-icons.js` then reload the extension |
