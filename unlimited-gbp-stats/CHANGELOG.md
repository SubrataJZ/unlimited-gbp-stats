# Changelog - Unlimited Google Business Stats Extension

All notable changes to this project will be documented in this file.

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
