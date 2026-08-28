import { Request, Response } from 'express';
import metricsService from '../services/metrics.service';
import reportService from '../services/report.service';
import { asyncHandler } from '../middlewares/error.middleware';
import { ValidationError, NotFoundError } from '../utils/errors';
import logger from '../utils/logger';

/**
 * GET /api/analytics/locations/:locationId/yoy
 * Get YoY comparison for a specific month
 */
export const getYoYComparison = asyncHandler(async (req: Request, res: Response) => {
  const { locationId } = req.params;
  const { year, month, metricType = 'overview' } = req.query;

  // Validation
  if (!year || !month) {
    throw new ValidationError('year and month parameters are required');
  }

  const yearNum = parseInt(year as string, 10);
  const monthNum = parseInt(month as string, 10);

  if (isNaN(yearNum) || isNaN(monthNum) || monthNum < 1 || monthNum > 12) {
    throw new ValidationError('year and month must be valid integers (month: 1-12)');
  }

  try {
    const comparison = await metricsService.getMetricsForYoYComparison(
      locationId,
      yearNum,
      monthNum,
      metricType as string
    );

    res.status(200).json(comparison);
  } catch (error) {
    logger.error('Error fetching YoY comparison:', error);
    throw error;
  }
});

/**
 * GET /api/analytics/locations/:locationId/period-comparison
 * Get metrics for a date range with optional comparison
 */
export const getPeriodComparison = asyncHandler(async (req: Request, res: Response) => {
  const { locationId } = req.params;
  const { from, to, compareMode = 'yoy', metricType = 'overview', customDate } = req.query;

  // Validation
  if (!from || !to) {
    throw new ValidationError('from and to date parameters are required (ISO format)');
  }

  const startDate = new Date(from as string);
  const endDate = new Date(to as string);
  const customDateObj = customDate ? new Date(customDate as string) : undefined;

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    throw new ValidationError('from and to must be valid ISO dates (YYYY-MM-DD)');
  }

  if (startDate > endDate) {
    throw new ValidationError('from date must be before to date');
  }

  const mode = compareMode as 'yoy' | 'prev' | 'custom';
  if (!['yoy', 'prev', 'custom'].includes(mode)) {
    throw new ValidationError('compareMode must be one of: yoy, prev, custom');
  }

  try {
    const periods = await metricsService.getMetricsForPeriod(
      locationId,
      startDate,
      endDate,
      metricType as string,
      mode,
      customDateObj
    );

    // Calculate summary
    const summary = {
      totalCurrent: periods.reduce((sum, p) => sum + p.value, 0),
      totalComparison: periods.reduce((sum, p) => sum + (p.compareValue || 0), 0),
      growthPercent:
        periods.length > 0
          ? periods[periods.length - 1].yoyPercent
          : null,
    };

    res.status(200).json({
      periods,
      summary,
    });
  } catch (error) {
    logger.error('Error fetching period comparison:', error);
    throw error;
  }
});

/**
 * POST /api/reports/generate
 * Generate a new report
 */
export const generateReport = asyncHandler(async (req: Request, res: Response) => {
  const { locationId, reportType, options } = req.body;

  // Validation
  if (!locationId || !reportType) {
    throw new ValidationError('locationId and reportType are required');
  }

  if (!['full', 'mvm', 'pvp', '6year'].includes(reportType)) {
    throw new ValidationError('reportType must be one of: full, mvm, pvp, 6year');
  }

  if (reportType === 'pvp' && (!options?.period1 || !options?.period2)) {
    throw new ValidationError('Period vs Period reports require period1 and period2 options');
  }

  // Both 'full' (optional window + optional comparison) and 'pvp' take periods;
  // reject malformed ones here so callers get a 400 rather than a 500.
  for (const key of ['period1', 'period2'] as const) {
    const period = options?.[key];
    if (!period) continue;
    const start = new Date(period.start);
    const end = new Date(period.end);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      throw new ValidationError(`options.${key} must have valid start and end dates`);
    }
    if (start > end) {
      throw new ValidationError(`options.${key}.start must not be after options.${key}.end`);
    }
  }

  try {
    const result = await reportService.generateReport(
      locationId,
      reportType,
      options || {}
    );

    res.status(201).json(result);
    logger.info(`Report generated: ${result.reportId} by user ${req.user?.id || 'unknown'}`);
  } catch (error) {
    logger.error('Error generating report:', error);
    throw error;
  }
});

/**
 * GET /api/reports/:reportId/download
 * Download a generated report (HTML or PDF)
 */
export const downloadReport = asyncHandler(async (req: Request, res: Response) => {
  const { reportId } = req.params;
  const { format = 'html' } = req.query;

  if (!['html', 'pdf'].includes(format as string)) {
    throw new ValidationError('format must be one of: html, pdf');
  }

  try {
    const { prisma } = await import('../index');

    const report = await prisma.report.findUnique({
      where: { id: reportId },
    });

    if (!report) {
      throw new NotFoundError(`Report ${reportId} not found`);
    }

    // Check expiration
    if (report.expiresAt && new Date() > report.expiresAt) {
      res.status(410).json({ error: 'Report has expired' });
      return;
    }

    // Return appropriate format
    if (format === 'html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="report-${reportId}.html"`);
      res.status(200).send(report.htmlContent);
    } else if (format === 'pdf') {
      if (!report.pdfContent) {
        res.status(400).json({ error: 'PDF not available for this report' });
        return;
      }

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="report-${reportId}.pdf"`);
      res.status(200).send(report.pdfContent);
    }

    logger.info(`Report downloaded: ${reportId} (${format})`);
  } catch (error) {
    logger.error('Error downloading report:', error);
    throw error;
  }
});

/**
 * GET /api/reports/locations/:locationId
 * List recent reports for a location
 */
export const listLocationReports = asyncHandler(async (req: Request, res: Response) => {
  const { locationId } = req.params;
  const { limit = '10', skip = '0' } = req.query;

  const limitNum = Math.min(parseInt(limit as string, 10) || 10, 100);
  const skipNum = parseInt(skip as string, 10) || 0;

  try {
    const { prisma } = await import('../index');

    const [reports, total] = await Promise.all([
      prisma.report.findMany({
        where: { locationId },
        select: {
          id: true,
          reportType: true,
          generatedAt: true,
          expiresAt: true,
          recipientEmail: true,
        },
        orderBy: { generatedAt: 'desc' },
        take: limitNum,
        skip: skipNum,
      }),
      prisma.report.count({
        where: { locationId },
      }),
    ]);

    res.status(200).json({
      total,
      reports: reports.map((r: any) => ({
        reportId: r.id,
        reportType: r.reportType,
        generatedAt: r.generatedAt,
        expiresAt: r.expiresAt,
        downloadUrl: `/api/reports/${r.id}/download?format=html`,
        recipientEmail: r.recipientEmail,
      })),
    });
  } catch (error) {
    logger.error('Error listing reports:', error);
    throw error;
  }
});
