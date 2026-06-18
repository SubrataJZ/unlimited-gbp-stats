/**
 * Audit Report Renderer — Phase 4.
 *
 * Converts an AuditResult (computed by audit.service / audit.compute) into a
 * self-contained HTML page suitable for direct browser delivery.
 *
 * NEUTRAL FRAMING (non-negotiable): every signal is labelled as an INTERNAL
 * AGGREGATE. Nothing here accuses a business of fake/bought/fraudulent reviews.
 * The AuditResult.disclaimer is always rendered prominently.
 *
 * No Prisma / DB imports — this module is intentionally pure (data in → HTML
 * string out) so it can be unit-tested without a running database.
 */

import * as fs from 'fs';
import * as path from 'path';
import { AuditResult, VelocityPoint, VelocityAnomaly, KeywordFreq } from './audit.service';

// ── Template directory (same convention as report.service.ts) ─────────────────

const TEMPLATES_DIR = path.join(__dirname, '../templates');

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Render a self-contained HTML audit report for `businessName`.
 *
 * Tries `backend/src/templates/audit-report.html` first; falls back to inline
 * HTML if the file is absent (mirrors report.service.ts renderTemplate logic).
 */
export function renderAuditReportHtml(businessName: string, audit: AuditResult): string {
  const data = buildTemplateData(businessName, audit);
  const templatePath = path.join(TEMPLATES_DIR, 'audit-report.html');

  try {
    if (fs.existsSync(templatePath)) {
      let html = fs.readFileSync(templatePath, 'utf-8');
      Object.entries(data).forEach(([key, value]) => {
        const regex = new RegExp(`{{${key}}}`, 'g');
        html = html.replace(regex, value ?? '');
      });
      return html;
    }
  } catch {
    // fall through to inline fallback
  }

  return buildFallbackHtml(data);
}

// ── Template data builder ─────────────────────────────────────────────────────

interface AuditTemplateData {
  businessName: string;
  generatedAt: string;
  sampleSizes: string;
  dateRange: string;
  signalsTable: string;
  ratingDistribution: string;
  velocityChart: string;
  anomaliesList: string;
  unigramsList: string;
  bigramsList: string;
  disclaimer: string;
  [key: string]: string;
}

function buildTemplateData(businessName: string, audit: AuditResult): AuditTemplateData {
  return {
    businessName: escapeHtml(businessName),
    generatedAt: new Date(audit.generatedAt).toLocaleString(),
    sampleSizes: buildSampleSizes(audit),
    dateRange: buildDateRange(audit),
    signalsTable: buildSignalsTable(audit),
    ratingDistribution: buildRatingDistribution(audit),
    velocityChart: buildVelocityChart(audit.velocity),
    anomaliesList: buildAnomaliesList(audit.velocityAnomalies),
    unigramsList: buildKeywordList(audit.keywords.unigrams),
    bigramsList: buildKeywordList(audit.keywords.bigrams),
    disclaimer: escapeHtml(audit.disclaimer),
  };
}

// ── Section builders ──────────────────────────────────────────────────────────

function buildSampleSizes(audit: AuditResult): string {
  return `${audit.reviewSampleSize} reviews (${audit.datedSampleSize} with dates)`;
}

function buildDateRange(audit: AuditResult): string {
  const from = audit.dateRange.from ?? 'N/A';
  const to = audit.dateRange.to ?? 'N/A';
  return `${from} — ${to}`;
}

function buildSignalsTable(audit: AuditResult): string {
  const s = audit.signals;

  const fmt = (val: number | null, suffix = '%'): string =>
    val == null ? 'N/A' : `${val}${suffix}`;

  const rows: [string, string][] = [
    ['Scraped review count', String(s.scrapedReviewCount)],
    ['Display rating (from profile)', fmt(s.displayRating, ' ★')],
    ['True average rating (sample mean)', fmt(s.trueAverage, ' ★')],
    ['Rating delta (sample mean − display)', fmt(s.ratingDelta, '')],
    ['Local Guide author share', fmt(s.localGuidePct)],
    ['Reviews with photo', fmt(s.withPhotoPct)],
    ['Rating-only (no text body)', fmt(s.noTextPct)],
    ['Owner response rate', fmt(s.ownerResponseRate)],
    ['Avg reviews per reviewer', fmt(s.avgReviewerContribution, '')],
    ['Single-review authors', fmt(s.singleReviewAuthorPct)],
  ];

  const trs = rows
    .map(
      ([label, value]) =>
        `<tr><td class="signal-label">${escapeHtml(label)}</td><td class="signal-value">${escapeHtml(value)}</td></tr>`
    )
    .join('\n');

  return `<table class="signals-table"><tbody>${trs}</tbody></table>`;
}

function buildRatingDistribution(audit: AuditResult): string {
  const dist = audit.signals.ratingDistribution;
  const total = audit.signals.scrapedReviewCount || 1;

  const bars = ([5, 4, 3, 2, 1] as const)
    .map((star) => {
      const count = dist[star];
      const pct = Math.round((count / total) * 100);
      return `
      <div class="dist-row">
        <span class="dist-label">${star}★</span>
        <div class="dist-bar-wrap">
          <div class="dist-bar" style="width:${pct}%"></div>
        </div>
        <span class="dist-count">${count} (${pct}%)</span>
      </div>`;
    })
    .join('\n');

  return `<div class="rating-dist">${bars}</div>`;
}

function buildVelocityChart(velocity: VelocityPoint[]): string {
  if (velocity.length === 0) {
    return '<p class="no-data">No dated reviews available for the velocity timeline.</p>';
  }

  const W = 800;
  const H = 220;
  const PL = 50; // left padding (for y-axis labels)
  const PR = 20;
  const PT = 20;
  const PB = 40; // bottom padding (for x-axis labels)

  const chartW = W - PL - PR;
  const chartH = H - PT - PB;

  const counts = velocity.map((v) => v.monthlyCount);
  const maxCount = Math.max(...counts, 1);

  // Monthly bar chart
  const barWidth = Math.max(1, chartW / velocity.length - 1);

  const bars = velocity
    .map((v, i) => {
      const x = PL + (i / velocity.length) * chartW;
      const barH = (v.monthlyCount / maxCount) * chartH;
      const y = PT + chartH - barH;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barH.toFixed(1)}" fill="#8ab4f8" opacity="0.7"/>`;
    })
    .join('\n');

  // Cumulative line overlay
  const maxCumul = Math.max(...velocity.map((v) => v.cumulativeCount), 1);
  const linePoints = velocity
    .map((v, i) => {
      const x = PL + ((i + 0.5) / velocity.length) * chartW;
      const y = PT + chartH - (v.cumulativeCount / maxCumul) * chartH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  // X-axis labels — show at most 12 evenly spaced
  const labelStep = Math.ceil(velocity.length / 12);
  const xLabels = velocity
    .filter((_, i) => i % labelStep === 0 || i === velocity.length - 1)
    .map((v, _, arr) => {
      const origIndex = velocity.indexOf(v);
      const x = PL + ((origIndex + 0.5) / velocity.length) * chartW;
      return `<text x="${x.toFixed(1)}" y="${(PT + chartH + 18).toFixed(1)}" text-anchor="middle" font-size="10" fill="#999">${v.month}</text>`;
    })
    .join('\n');

  // Y-axis label
  const yLabel = `<text x="${(PL - 8).toFixed(1)}" y="${(PT + chartH / 2).toFixed(1)}" text-anchor="middle" font-size="10" fill="#999" transform="rotate(-90 ${(PL - 8).toFixed(1)} ${(PT + chartH / 2).toFixed(1)})">Reviews/mo</text>`;

  return `
<div class="chart-wrap">
  <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;">
    <defs>
      <linearGradient id="auditGrad" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" style="stop-color:#8ab4f8;stop-opacity:0.3"/>
        <stop offset="100%" style="stop-color:#8ab4f8;stop-opacity:0.05"/>
      </linearGradient>
    </defs>
    <!-- grid line -->
    <line x1="${PL}" y1="${PT}" x2="${PL}" y2="${PT + chartH}" stroke="#eee" stroke-width="1"/>
    <line x1="${PL}" y1="${PT + chartH}" x2="${PL + chartW}" y2="${PT + chartH}" stroke="#eee" stroke-width="1"/>
    <!-- bars -->
    ${bars}
    <!-- cumulative line -->
    <polyline points="${linePoints}" fill="none" stroke="#ff8c66" stroke-width="2" opacity="0.85"/>
    <!-- labels -->
    ${xLabels}
    ${yLabel}
    <!-- legend -->
    <rect x="${PL + chartW - 180}" y="${PT}" width="12" height="12" fill="#8ab4f8" opacity="0.7"/>
    <text x="${PL + chartW - 164}" y="${PT + 10}" font-size="11" fill="#666">Monthly count</text>
    <line x1="${PL + chartW - 80}" y1="${PT + 6}" x2="${PL + chartW - 68}" y2="${PT + 6}" stroke="#ff8c66" stroke-width="2"/>
    <text x="${PL + chartW - 64}" y="${PT + 10}" font-size="11" fill="#666">Cumulative</text>
  </svg>
</div>`;
}

function buildAnomaliesList(anomalies: VelocityAnomaly[]): string {
  if (anomalies.length === 0) {
    return '<p class="no-data">No velocity anomalies detected in this sample.</p>';
  }

  const items = anomalies
    .map(
      (a) =>
        `<li><strong>${escapeHtml(a.month)}</strong> — ${a.monthlyCount} reviews (baseline: ${a.baseline}, ratio: ${a.ratio}×)</li>`
    )
    .join('\n');

  return `<ul class="anomaly-list">${items}</ul>`;
}

function buildKeywordList(kws: KeywordFreq[]): string {
  if (kws.length === 0) {
    return '<p class="no-data">No frequent terms found.</p>';
  }
  const chips = kws
    .map((k) => `<span class="keyword-chip">${escapeHtml(k.term)} <em>(${k.count})</em></span>`)
    .join(' ');
  return `<div class="keyword-chips">${chips}</div>`;
}

// ── Fallback HTML ─────────────────────────────────────────────────────────────

function buildFallbackHtml(d: AuditTemplateData): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Review Audit — ${d.businessName}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      line-height: 1.6;
      color: #333;
      background: #f5f5f5;
    }
    .container { max-width: 960px; margin: 0 auto; background: #fff; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    .header {
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      color: #fff;
      padding: 40px;
      text-align: center;
    }
    .header h1 { font-size: 32px; margin-bottom: 8px; }
    .header .meta { font-size: 13px; opacity: 0.8; }
    .content { padding: 40px; }
    .section { margin-bottom: 40px; }
    .section h2 {
      font-size: 20px;
      color: #1a1a2e;
      margin-bottom: 16px;
      border-bottom: 2px solid #8ab4f8;
      padding-bottom: 8px;
    }
    .disclaimer-box {
      background: #fff8e1;
      border-left: 4px solid #f9a825;
      padding: 16px 20px;
      border-radius: 4px;
      font-size: 13px;
      color: #555;
      margin-bottom: 40px;
    }
    .disclaimer-box strong { color: #e65100; }
    .meta-row { display: flex; gap: 24px; flex-wrap: wrap; margin-bottom: 12px; font-size: 14px; color: #555; }
    .meta-row span strong { color: #1a1a2e; }
    .signals-table { width: 100%; border-collapse: collapse; font-size: 14px; }
    .signals-table tr:nth-child(even) { background: #f9f9f9; }
    .signals-table td { padding: 10px 14px; border-bottom: 1px solid #eee; }
    .signal-label { color: #555; width: 60%; }
    .signal-value { font-weight: 600; color: #1a1a2e; text-align: right; }
    .rating-dist { font-size: 14px; }
    .dist-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
    .dist-label { width: 28px; text-align: right; font-weight: 600; color: #1a1a2e; }
    .dist-bar-wrap { flex: 1; height: 16px; background: #f0f0f0; border-radius: 8px; overflow: hidden; }
    .dist-bar { height: 100%; background: #8ab4f8; border-radius: 8px; transition: width 0.3s; }
    .dist-count { width: 90px; font-size: 12px; color: #666; }
    .chart-wrap { overflow-x: auto; }
    .anomaly-list { padding-left: 20px; font-size: 14px; line-height: 2; }
    .anomaly-list li { color: #444; }
    .keyword-chips { display: flex; flex-wrap: wrap; gap: 8px; }
    .keyword-chip {
      background: #e8f0fe;
      color: #1a73e8;
      border-radius: 16px;
      padding: 4px 12px;
      font-size: 13px;
    }
    .keyword-chip em { font-style: normal; color: #888; font-size: 11px; }
    .no-data { color: #999; font-size: 13px; font-style: italic; }
    .footer {
      background: #f5f5f5;
      padding: 20px 40px;
      text-align: center;
      font-size: 12px;
      color: #999;
      border-top: 1px solid #eee;
    }
    @media print {
      body { background: white; }
      .container { box-shadow: none; }
      .section { page-break-inside: avoid; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>${d.businessName}</h1>
      <div class="meta">Review Audit Report</div>
      <div class="meta">Generated: ${d.generatedAt}</div>
    </div>

    <div class="content">

      <div class="disclaimer-box">
        <strong>Important:</strong> ${d.disclaimer}
      </div>

      <div class="section">
        <h2>Sample Overview</h2>
        <div class="meta-row">
          <span><strong>Sample size:</strong> ${d.sampleSizes}</span>
          <span><strong>Date range:</strong> ${d.dateRange}</span>
        </div>
      </div>

      <div class="section">
        <h2>Aggregate Signals</h2>
        <p style="font-size:13px;color:#888;margin-bottom:12px;">Internal aggregates computed from the scraped sample — not a determination of review authenticity.</p>
        ${d.signalsTable}
      </div>

      <div class="section">
        <h2>Rating Distribution</h2>
        ${d.ratingDistribution}
      </div>

      <div class="section">
        <h2>Review Velocity Timeline</h2>
        <p style="font-size:13px;color:#888;margin-bottom:12px;">Monthly review count (bars) and cumulative total (orange line).</p>
        ${d.velocityChart}
      </div>

      <div class="section">
        <h2>Velocity Anomalies</h2>
        <p style="font-size:13px;color:#888;margin-bottom:12px;">Months where the review count was 3× or more above the median active-month baseline. A burst may reflect a marketing push, press coverage, or other activity — this is an internal signal only.</p>
        ${d.anomaliesList}
      </div>

      <div class="section">
        <h2>Top Keywords — Single Terms</h2>
        ${d.unigramsList}
      </div>

      <div class="section">
        <h2>Top Keywords — Two-Word Phrases</h2>
        ${d.bigramsList}
      </div>

    </div>

    <div class="footer">
      <p>Generated by GBP Sentinel on ${d.generatedAt}</p>
      <p style="margin-top:4px;font-size:11px;">${d.disclaimer}</p>
    </div>
  </div>
</body>
</html>`;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
