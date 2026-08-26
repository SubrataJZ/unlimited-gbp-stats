import { prisma } from '../index';
import metricsService, { PeriodData, GrowthData } from './metrics.service';
import logger from '../utils/logger';
import * as fs from 'fs';
import * as path from 'path';

// ── Type Definitions ───────────────────────────────────────────────────────

export interface GenerateReportOptions {
  metricTypes?: string[];
  /**
   * For 'pvp': the first of the two compared periods.
   * For 'full': the report window. Omit to report on all data ever tracked.
   */
  period1?: DateRange;
  /**
   * For 'pvp': the second of the two compared periods (required).
   * For 'full': an optional comparison window rendered alongside period1.
   */
  period2?: DateRange;
  customMonth?: string;
  recipientEmail?: string;
  expiresInDays?: number;
}

export interface DateRange {
  start: Date;
  end: Date;
}

/**
 * Options arrive over HTTP as JSON, so date bounds are ISO strings on the wire.
 */
type RawDateRange = { start: Date | string; end: Date | string };

export interface ReportMeta {
  title: string;
  period: string;
  generatedAt: string;
  businessName: string;
  locationId: string;
  // Actual date-range bounds for persistence (avoids parsing the display string)
  dateRangeStart: Date;
  dateRangeEnd: Date;
}

interface TemplateData {
  businessName: string;
  period: string;
  generatedAt: string;
  summaryCards: string;
  mainChart: string;
  platformBreakdown: string;
  searchTerms: string;
  [key: string]: string;
}

// ── ReportService ───────────────────────────────────────────────────────

class ReportService {
  private templatesDir = path.join(__dirname, '../templates');

  /**
   * Main orchestrator: Generate report based on type
   */
  async generateReport(
    locationId: string,
    reportType: 'full' | 'mvm' | 'pvp' | '6year',
    options: GenerateReportOptions = {}
  ): Promise<any> {
    try {
      // Fetch location info
      const location = await prisma.location.findUnique({
        where: { googleLocationId: locationId },
      });

      if (!location) {
        throw new Error(`Location ${locationId} not found`);
      }

      // Options come off the wire as JSON: normalise date bounds before use
      const period1 = this.normalizeDateRange(options.period1, 'period1');
      const period2 = this.normalizeDateRange(options.period2, 'period2');

      // Generate report content based on type
      let reportData: { html: string; meta: ReportMeta };

      switch (reportType) {
        case 'full':
          reportData = await this.buildFullReport(
            locationId,
            location.businessName,
            period1,
            period2,
            options.metricTypes
          );
          break;
        case 'mvm':
          reportData = await this.buildMvMReport(locationId, location.businessName);
          break;
        case 'pvp':
          if (!period1 || !period2) {
            throw new Error('Period vs Period reports require period1 and period2');
          }
          reportData = await this.buildPvPReport(
            locationId,
            location.businessName,
            period1,
            period2
          );
          break;
        case '6year':
          const metricType = options.metricTypes?.[0] || 'overview';
          reportData = await this.build6YearReport(locationId, location.businessName, metricType);
          break;
        default:
          throw new Error(`Unknown report type: ${reportType}`);
      }

      // Save report to database
      const expiresAt = options.expiresInDays
        ? new Date(Date.now() + options.expiresInDays * 24 * 60 * 60 * 1000)
        : null;

      const report = await prisma.report.create({
        data: {
          locationId,
          reportType,
          dateRangeStart: reportData.meta.dateRangeStart,
          dateRangeEnd: reportData.meta.dateRangeEnd,
          htmlContent: reportData.html,
          generatedAt: new Date(),
          expiresAt,
          recipientEmail: options.recipientEmail,
        },
      });

      logger.info(`Report generated: ${report.id} (${reportType})`);

      return {
        reportId: report.id,
        reportType,
        locationId,
        generatedAt: report.generatedAt,
        expiresAt: report.expiresAt,
        downloadUrl: `/api/reports/${report.id}/download?format=html`,
        pdfUrl: `/api/reports/${report.id}/download?format=pdf`,
      };
    } catch (error) {
      logger.error('Error generating report:', error);
      throw error;
    }
  }

  /**
   * Full Performance Report.
   *
   * With no `range`, this reports on all data ever tracked for the location.
   * With a `range`, only metrics inside it are reported — this is what the
   * extension's export sends so the report honours the months the user picked.
   * An optional `comparison` range adds a period-over-period section.
   */
  private async buildFullReport(
    locationId: string,
    businessName: string,
    range?: DateRange,
    comparison?: DateRange,
    metricTypes?: string[]
  ): Promise<{ html: string; meta: ReportMeta }> {
    try {
      // Fetch metrics for the location, narrowed to the requested window
      const allMetrics = await metricsService.getAllMetricsForLocation(
        locationId,
        metricTypes,
        range
      );

      if (allMetrics.length === 0) {
        throw new Error(
          range
            ? `No metrics found for location in ${this.formatRange(range)}`
            : 'No metrics found for location'
        );
      }

      // getAllMetricsForLocation orders newest-first
      const newest = new Date(allMetrics[0].date);
      const oldest = new Date(allMetrics[allMetrics.length - 1].date);

      // Group by metric type
      const metricsByType = this.groupMetricsByType(allMetrics);

      // Build summary cards, with a comparison block when a second period is given
      let summaryCards = this.buildSummaryCards(metricsByType);

      if (comparison) {
        const comparisonMetrics = await metricsService.getAllMetricsForLocation(
          locationId,
          metricTypes,
          comparison
        );
        summaryCards +=
          this.buildRangeComparison(
            metricsByType,
            this.groupMetricsByType(comparisonMetrics),
            range ? this.formatRange(range) : `${oldest.toLocaleDateString()} to ${newest.toLocaleDateString()}`,
            this.formatRange(comparison)
          );
      }

      // Build main chart SVG (oldest → newest reads left to right)
      const mainChart = this.buildChartSvg([...allMetrics].reverse());

      // Build platform breakdown
      const platformBreakdown = this.buildPlatformBreakdown(metricsByType);

      const period = range
        ? this.formatRange(range) + (comparison ? ` vs ${this.formatRange(comparison)}` : '')
        : `${oldest.toLocaleDateString()} to ${newest.toLocaleDateString()}`;

      // Load and render template
      const templateData: TemplateData = {
        businessName,
        period,
        generatedAt: new Date().toLocaleString(),
        summaryCards,
        mainChart,
        platformBreakdown,
        searchTerms: '<div class="section"><h2>Top Search Terms</h2><p>Data not available in this version</p></div>',
      };

      const html = this.renderTemplate('full-report.html', templateData);

      return {
        html,
        meta: {
          title: `Full Performance Report - ${businessName}`,
          period: templateData.period,
          generatedAt: templateData.generatedAt,
          businessName,
          locationId,
          // Persist the window that was asked for, so saved reports are
          // addressable by the user's selection rather than by what data existed
          dateRangeStart: range ? range.start : oldest,
          dateRangeEnd: range ? range.end : newest,
        },
      };
    } catch (error) {
      logger.error('Error building full report:', error);
      throw error;
    }
  }

  /**
   * Coerce an over-the-wire date range into real Dates, rejecting bad input.
   */
  private normalizeDateRange(
    range: RawDateRange | undefined,
    label: string
  ): DateRange | undefined {
    if (!range) return undefined;

    const start = new Date(range.start);
    const end = new Date(range.end);

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      throw new Error(`${label} must have valid start and end dates`);
    }
    if (start > end) {
      throw new Error(`${label}.start must not be after ${label}.end`);
    }

    return { start, end };
  }

  private formatRange(range: DateRange): string {
    return `${range.start.toLocaleDateString()} to ${range.end.toLocaleDateString()}`;
  }

  /**
   * Month vs Month Report: Current month vs previous month
   */
  private async buildMvMReport(
    locationId: string,
    businessName: string
  ): Promise<{ html: string; meta: ReportMeta }> {
    try {
      const now = new Date();
      const currentMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);

      // Fetch metrics for both months
      const currentMonthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);

      const metrics = await metricsService.getMetricsForPeriod(
        locationId,
        lastMonth,
        currentMonthEnd,
        'overview',
        'prev'
      );

      // Build comparison cards
      const comparisonCards = this.buildComparisonCards(metrics);

      // Build chart
      const mainChart = this.buildComparisonChartSvg(metrics);

      // Render template
      const templateData: TemplateData = {
        businessName,
        period: `${lastMonth.toLocaleDateString()} to ${currentMonthEnd.toLocaleDateString()}`,
        generatedAt: new Date().toLocaleString(),
        summaryCards: comparisonCards,
        mainChart,
        platformBreakdown: '',
        searchTerms: '',
      };

      const html = this.renderTemplate('mvm-report.html', templateData);

      return {
        html,
        meta: {
          title: `Month vs Month Report - ${businessName}`,
          period: templateData.period,
          generatedAt: templateData.generatedAt,
          businessName,
          locationId,
          dateRangeStart: lastMonth,
          dateRangeEnd: currentMonthEnd,
        },
      };
    } catch (error) {
      logger.error('Error building MvM report:', error);
      throw error;
    }
  }

  /**
   * Period vs Period Report: Custom date range comparison
   */
  private async buildPvPReport(
    locationId: string,
    businessName: string,
    period1: DateRange,
    period2: DateRange
  ): Promise<{ html: string; meta: ReportMeta }> {
    try {
      // Fetch metrics for both periods
      const metrics1 = await metricsService.getMetricsForPeriod(
        locationId,
        period1.start,
        period1.end,
        'overview'
      );

      const metrics2 = await metricsService.getMetricsForPeriod(
        locationId,
        period2.start,
        period2.end,
        'overview'
      );

      // Calculate summary for each period
      const summary1 = this.calculatePeriodSummary(metrics1);
      const summary2 = this.calculatePeriodSummary(metrics2);

      // Build comparison display
      const comparisonDisplay = this.buildPeriodComparison(summary1, summary2);

      // Render template
      const templateData: TemplateData = {
        businessName,
        period: `${period1.start.toLocaleDateString()} to ${period1.end.toLocaleDateString()} vs ${period2.start.toLocaleDateString()} to ${period2.end.toLocaleDateString()}`,
        generatedAt: new Date().toLocaleString(),
        summaryCards: comparisonDisplay,
        mainChart: this.buildComparisonChartSvg(metrics1),
        platformBreakdown: '',
        searchTerms: '',
      };

      const html = this.renderTemplate('pvp-report.html', templateData);

      return {
        html,
        meta: {
          title: `Period vs Period Report - ${businessName}`,
          period: templateData.period,
          generatedAt: templateData.generatedAt,
          businessName,
          locationId,
          // Span both periods: earliest start to latest end
          dateRangeStart: period1.start < period2.start ? period1.start : period2.start,
          dateRangeEnd: period1.end > period2.end ? period1.end : period2.end,
        },
      };
    } catch (error) {
      logger.error('Error building PvP report:', error);
      throw error;
    }
  }

  /**
   * 6-Year Historical Growth Report: 72 months with YoY overlays
   */
  private async build6YearReport(
    locationId: string,
    businessName: string,
    metricType: string
  ): Promise<{ html: string; meta: ReportMeta }> {
    try {
      // Get 6-year growth summary
      const growthData = await metricsService.get6YearGrowthSummary(locationId, metricType);

      if (growthData.length === 0) {
        throw new Error('No historical data available for 6-year report');
      }

      const sixYearEnd = new Date();
      const sixYearStart = new Date();
      sixYearStart.setFullYear(sixYearStart.getFullYear() - 6);

      // Build historical chart with YoY percentages labeled
      const mainChart = this.build6YearChartSvg(growthData);

      // Build growth insights
      const insights = this.buildGrowthInsights(growthData);

      // Render template
      const templateData: TemplateData = {
        businessName,
        period: '6 Years Historical',
        generatedAt: new Date().toLocaleString(),
        summaryCards: insights,
        mainChart,
        platformBreakdown: '',
        searchTerms: '',
      };

      const html = this.renderTemplate('6year-report.html', templateData);

      return {
        html,
        meta: {
          title: `6-Year Growth Report - ${businessName}`,
          period: templateData.period,
          generatedAt: templateData.generatedAt,
          businessName,
          locationId,
          dateRangeStart: sixYearStart,
          dateRangeEnd: sixYearEnd,
        },
      };
    } catch (error) {
      logger.error('Error building 6-year report:', error);
      throw error;
    }
  }

  /**
   * Render HTML template with data substitution
   */
  private renderTemplate(templateName: string, data: TemplateData): string {
    try {
      const templatePath = path.join(this.templatesDir, templateName);

      // If template doesn't exist, use fallback
      if (!fs.existsSync(templatePath)) {
        return this.buildFallbackHtml(templateName, data);
      }

      let html = fs.readFileSync(templatePath, 'utf-8');

      // Replace all template variables
      Object.entries(data).forEach(([key, value]) => {
        const regex = new RegExp(`{{${key}}}`, 'g');
        html = html.replace(regex, value || '');
      });

      return html;
    } catch (error) {
      logger.error('Error rendering template:', error);
      return this.buildFallbackHtml(templateName, data);
    }
  }

  /**
   * Fallback HTML if template file doesn't exist
   */
  private buildFallbackHtml(templateName: string, data: TemplateData): string {
    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${data.businessName} - Report</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
          .container { max-width: 900px; margin: 0 auto; background: white; padding: 40px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
          h1 { color: #1a1a2e; margin-top: 0; }
          .meta { color: #666; font-size: 14px; margin-bottom: 30px; border-bottom: 1px solid #eee; padding-bottom: 20px; }
          .section { margin: 30px 0; }
          .chart { margin: 20px 0; padding: 20px; background: #f9f9f9; border-radius: 4px; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>${data.businessName}</h1>
          <div class="meta">
            <p><strong>Period:</strong> ${data.period}</p>
            <p><strong>Generated:</strong> ${data.generatedAt}</p>
          </div>
          ${data.summaryCards ? `<div class="section">${data.summaryCards}</div>` : ''}
          ${data.mainChart ? `<div class="chart">${data.mainChart}</div>` : ''}
          <footer style="margin-top: 60px; padding-top: 20px; border-top: 1px solid #eee; color: #999; font-size: 12px;">
            <p>Generated by Unlimited GBP Stats on ${new Date().toLocaleDateString()}</p>
          </footer>
        </div>
      </body>
      </html>
    `;
  }

  /**
   * Build summary cards from metrics
   */
  private buildSummaryCards(metricsByType: { [key: string]: any[] }): string {
    const cards = Object.entries(metricsByType)
      .map(([type, metrics]) => {
        const total = metrics.reduce((sum, m) => sum + m.value, 0);
        const avg = Math.round(total / metrics.length);
        return `
          <div style="display: inline-block; width: 23%; margin: 1%; padding: 15px; background: #f5f5f5; border-radius: 4px;">
            <div style="font-size: 12px; color: #666; text-transform: uppercase;">${type}</div>
            <div style="font-size: 24px; font-weight: bold; color: #1a1a2e;">${total.toLocaleString()}</div>
            <div style="font-size: 12px; color: #999;">Avg: ${avg.toLocaleString()}</div>
          </div>
        `;
      })
      .join('');

    return `<div style="margin: 20px 0;">${cards}</div>`;
  }

  /**
   * Build a per-metric-type comparison table between two windows of a full report
   */
  private buildRangeComparison(
    currentByType: { [key: string]: any[] },
    comparisonByType: { [key: string]: any[] },
    currentLabel: string,
    comparisonLabel: string
  ): string {
    const types = Array.from(
      new Set([...Object.keys(currentByType), ...Object.keys(comparisonByType)])
    ).sort();

    if (types.length === 0) return '';

    const sum = (metrics: any[] | undefined) =>
      (metrics || []).reduce((total, m) => total + m.value, 0);

    const rows = types
      .map((type) => {
        const current = sum(currentByType[type]);
        const previous = sum(comparisonByType[type]);
        const change = previous > 0 ? ((current - previous) / previous) * 100 : null;
        const color = change === null ? '#666' : change > 0 ? '#4caf50' : change < 0 ? '#f44336' : '#ff9800';
        const arrow = change === null ? '' : change > 0 ? '↑' : change < 0 ? '↓' : '→';
        const changeText = change === null ? 'n/a' : `${arrow} ${Math.abs(change).toFixed(1)}%`;

        return `
          <tr>
            <td style="padding: 10px; border-bottom: 1px solid #eee; text-transform: uppercase; font-size: 12px; color: #666;">${type}</td>
            <td style="padding: 10px; border-bottom: 1px solid #eee; text-align: right; font-weight: bold; color: #1a1a2e;">${current.toLocaleString()}</td>
            <td style="padding: 10px; border-bottom: 1px solid #eee; text-align: right; color: #1a1a2e;">${previous.toLocaleString()}</td>
            <td style="padding: 10px; border-bottom: 1px solid #eee; text-align: right; font-weight: bold; color: ${color};">${changeText}</td>
          </tr>
        `;
      })
      .join('');

    return `
      <div style="margin: 30px 0;">
        <h2 style="font-size: 16px; color: #1a1a2e;">Period Comparison</h2>
        <table style="width: 100%; border-collapse: collapse; font-family: inherit;">
          <thead>
            <tr>
              <th style="padding: 10px; text-align: left; font-size: 12px; color: #999;">Metric</th>
              <th style="padding: 10px; text-align: right; font-size: 12px; color: #999;">${currentLabel}</th>
              <th style="padding: 10px; text-align: right; font-size: 12px; color: #999;">${comparisonLabel}</th>
              <th style="padding: 10px; text-align: right; font-size: 12px; color: #999;">Change</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  /**
   * Build comparison cards with growth indicators
   */
  private buildComparisonCards(metrics: PeriodData[]): string {
    if (metrics.length < 2) return '<p>Insufficient data for comparison</p>';

    const current = metrics[metrics.length - 1];
    const previous = metrics[metrics.length - 2];

    const growth = current.yoyPercent || 0;
    const trend = growth > 0 ? '↑' : growth < 0 ? '↓' : '→';
    const color = growth > 0 ? '#4caf50' : growth < 0 ? '#f44336' : '#ff9800';

    return `
      <div style="display: flex; gap: 20px; margin: 20px 0;">
        <div style="flex: 1; padding: 20px; background: #f5f5f5; border-radius: 4px;">
          <div style="color: #666; font-size: 12px;">Current Month</div>
          <div style="font-size: 28px; font-weight: bold; color: #1a1a2e;">${current.value.toLocaleString()}</div>
        </div>
        <div style="flex: 1; padding: 20px; background: #f5f5f5; border-radius: 4px;">
          <div style="color: #666; font-size: 12px;">Previous Month</div>
          <div style="font-size: 28px; font-weight: bold; color: #1a1a2e;">${previous.value.toLocaleString()}</div>
        </div>
        <div style="flex: 1; padding: 20px; background: ${color}20; border-radius: 4px;">
          <div style="color: #666; font-size: 12px;">Growth</div>
          <div style="font-size: 28px; font-weight: bold; color: ${color};">${trend} ${Math.abs(growth).toFixed(1)}%</div>
        </div>
      </div>
    `;
  }

  /**
   * Build simple chart SVG
   */
  private buildChartSvg(metrics: any[]): string {
    if (metrics.length === 0) return '<p>No data to display</p>';

    const width = 800;
    const height = 300;
    const padding = 40;

    const values = metrics.map((m) => m.value);
    const maxValue = Math.max(...values);
    const minValue = Math.min(...values);
    const range = maxValue - minValue || 1;

    const points = values
      .map((val, i) => {
        const x = padding + ((i / (values.length - 1)) * (width - 2 * padding)) || 0;
        const y = height - padding - ((val - minValue) / range) * (height - 2 * padding);
        return `${x},${y}`;
      })
      .join(' ');

    return `
      <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="background: #f9f9f9; border-radius: 4px;">
        <polyline points="${points}" fill="none" stroke="#8ab4f8" stroke-width="2"/>
        <polyline points="${points}" fill="url(#gradient)" opacity="0.3"/>
        <defs>
          <linearGradient id="gradient" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" style="stop-color:#8ab4f8;stop-opacity:0.5"/>
            <stop offset="100%" style="stop-color:#8ab4f8;stop-opacity:0.1"/>
          </linearGradient>
        </defs>
      </svg>
    `;
  }

  /**
   * Build comparison chart SVG with overlay
   */
  private buildComparisonChartSvg(metrics: PeriodData[]): string {
    return this.buildChartSvg(metrics);
  }

  /**
   * Build 6-year growth chart with YoY percentage labels
   */
  private build6YearChartSvg(growthData: GrowthData[]): string {
    if (growthData.length === 0) return '<p>No data available</p>';

    const width = 1000;
    const height = 400;
    const padding = 60;

    const values = growthData.map((g) => g.value);
    const maxValue = Math.max(...values);
    const minValue = Math.min(...values);
    const range = maxValue - minValue || 1;

    // Build data points
    const points = growthData
      .map((_, i) => {
        const x = padding + ((i / (growthData.length - 1)) * (width - 2 * padding)) || 0;
        const y =
          height -
          padding -
          ((growthData[i].value - minValue) / range) * (height - 2 * padding);
        return `${x},${y}`;
      })
      .join(' ');

    // Build YoY percentage labels
    const labels = growthData
      .map((d, i) => {
        if (!d.yoyPercent) return '';
        const x = padding + ((i / (growthData.length - 1)) * (width - 2 * padding)) || 0;
        const y =
          height -
          padding -
          ((d.value - minValue) / range) * (height - 2 * padding) -
          20;
        return `<text x="${x}" y="${y}" text-anchor="middle" font-size="11" fill="#666">${d.yoyPercent > 0 ? '+' : ''}${d.yoyPercent.toFixed(1)}%</text>`;
      })
      .join('');

    return `
      <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="background: #f9f9f9; border-radius: 4px;">
        <polyline points="${points}" fill="none" stroke="#8ab4f8" stroke-width="2"/>
        ${labels}
        <defs>
          <linearGradient id="gradient6year" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" style="stop-color:#8ab4f8;stop-opacity:0.3"/>
            <stop offset="100%" style="stop-color:#8ab4f8;stop-opacity:0.05"/>
          </linearGradient>
        </defs>
      </svg>
    `;
  }

  /**
   * Group metrics by type
   */
  private groupMetricsByType(metrics: any[]): { [key: string]: any[] } {
    return metrics.reduce((acc, m) => {
      if (!acc[m.metricType]) acc[m.metricType] = [];
      acc[m.metricType].push(m);
      return acc;
    }, {});
  }

  /**
   * Build platform breakdown section
   */
  private buildPlatformBreakdown(metricsByType: { [key: string]: any[] }): string {
    return '<div><p>Platform breakdown data not available in this version</p></div>';
  }

  /**
   * Calculate summary for a period
   */
  private calculatePeriodSummary(metrics: PeriodData[]): {
    total: number;
    average: number;
    growth: number | null;
  } {
    const total = metrics.reduce((sum, m) => sum + m.value, 0);
    const average = Math.round(total / metrics.length);
    const growth = metrics.length > 0 ? metrics[metrics.length - 1].yoyPercent : null;

    return { total, average, growth };
  }

  /**
   * Build period comparison display
   */
  private buildPeriodComparison(
    summary1: { total: number; average: number; growth: number | null },
    summary2: { total: number; average: number; growth: number | null }
  ): string {
    const growth = summary1.growth || 0;
    const color = growth > 0 ? '#4caf50' : growth < 0 ? '#f44336' : '#ff9800';

    return `
      <div style="display: flex; gap: 20px; margin: 20px 0;">
        <div style="flex: 1; padding: 20px; background: #f5f5f5; border-radius: 4px;">
          <div style="color: #666; font-size: 12px;">Period 1</div>
          <div style="font-size: 28px; font-weight: bold; color: #1a1a2e;">${summary1.total.toLocaleString()}</div>
          <div style="font-size: 12px; color: #999;">Avg: ${summary1.average.toLocaleString()}</div>
        </div>
        <div style="flex: 1; padding: 20px; background: #f5f5f5; border-radius: 4px;">
          <div style="color: #666; font-size: 12px;">Period 2</div>
          <div style="font-size: 28px; font-weight: bold; color: #1a1a2e;">${summary2.total.toLocaleString()}</div>
          <div style="font-size: 12px; color: #999;">Avg: ${summary2.average.toLocaleString()}</div>
        </div>
        <div style="flex: 1; padding: 20px; background: ${color}20; border-radius: 4px;">
          <div style="color: #666; font-size: 12px;">Growth</div>
          <div style="font-size: 28px; font-weight: bold; color: ${color};">${growth > 0 ? '↑' : growth < 0 ? '↓' : '→'} ${Math.abs(growth).toFixed(1)}%</div>
        </div>
      </div>
    `;
  }

  /**
   * Build growth insights from 6-year data
   */
  private buildGrowthInsights(growthData: GrowthData[]): string {
    const total = growthData.reduce((sum, g) => sum + g.value, 0);
    const avgYoY = growthData.filter((g) => g.yoyPercent !== null).reduce((sum, g) => sum + (g.yoyPercent || 0), 0) / growthData.filter((g) => g.yoyPercent !== null).length;
    const maxMonth = growthData.reduce((max, g) => (g.value > max.value ? g : max), growthData[0]);
    const minMonth = growthData.reduce((min, g) => (g.value < min.value ? g : min), growthData[0]);

    return `
      <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px;">
        <div style="padding: 20px; background: #f5f5f5; border-radius: 4px;">
          <div style="color: #666; font-size: 12px;">Total 6-Year Value</div>
          <div style="font-size: 24px; font-weight: bold; color: #1a1a2e;">${total.toLocaleString()}</div>
        </div>
        <div style="padding: 20px; background: #f5f5f5; border-radius: 4px;">
          <div style="color: #666; font-size: 12px;">Avg Annual Growth</div>
          <div style="font-size: 24px; font-weight: bold; color: #1a1a2e;">${avgYoY.toFixed(1)}%</div>
        </div>
        <div style="padding: 20px; background: #f5f5f5; border-radius: 4px;">
          <div style="color: #666; font-size: 12px;">Peak Month</div>
          <div style="font-size: 24px; font-weight: bold; color: #1a1a2e;">${maxMonth.value.toLocaleString()}</div>
          <div style="font-size: 12px; color: #999;">${maxMonth.month}</div>
        </div>
        <div style="padding: 20px; background: #f5f5f5; border-radius: 4px;">
          <div style="color: #666; font-size: 12px;">Low Month</div>
          <div style="font-size: 24px; font-weight: bold; color: #1a1a2e;">${minMonth.value.toLocaleString()}</div>
          <div style="font-size: 12px; color: #999;">${minMonth.month}</div>
        </div>
      </div>
    `;
  }
}

export default new ReportService();
