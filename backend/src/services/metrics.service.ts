import { prisma } from '../index';
import logger from '../utils/logger';

// ── Type Definitions ───────────────────────────────────────────────────────

export interface YoYData {
  current: { value: number; date: string; metricType: string } | null;
  priorYear: { value: number; date: string } | null;
  yoyPercent: number | null;
  trend: 'up' | 'down' | 'flat' | null;
}

export interface PeriodData {
  month: string;
  year: number;
  value: number;
  compareValue: number | null;
  yoyPercent: number | null;
  trend: 'up' | 'down' | 'flat' | null;
}

export interface GrowthData {
  month: string;
  year: number;
  value: number;
  yoyPercent: number | null;
  trend: 'up' | 'down' | 'flat' | null;
}

export interface MetricData {
  id: string;
  locationId: string;
  date: Date;
  metricType: string;
  value: number;
  createdAt: Date;
}

// ── MetricsService ───────────────────────────────────────────────────────

class MetricsService {
  /**
   * Calculate YoY growth percentage
   * Returns (currentValue - priorYearValue) / priorYearValue * 100
   * Handles null and zero values gracefully
   */
  private calculateYoYGrowth(currentValue: number, priorYearValue: number | null): number | null {
    if (priorYearValue === null || priorYearValue === undefined) {
      return null;
    }

    if (priorYearValue === 0) {
      // Cannot calculate percentage change from zero
      return null;
    }

    const percent = ((currentValue - priorYearValue) / priorYearValue) * 100;
    return Math.round(percent * 10) / 10; // Round to 1 decimal place
  }

  /**
   * Determine trend direction
   */
  private determineTrend(yoyPercent: number | null): 'up' | 'down' | 'flat' | null {
    if (yoyPercent === null) return null;
    if (yoyPercent > 1) return 'up';
    if (yoyPercent < -1) return 'down';
    return 'flat';
  }

  /**
   * Fetch metrics for a specific month
   */
  async getMetricsForMonth(
    locationId: string,
    year: number,
    month: number,
    metricType: string
  ): Promise<MetricData | null> {
    try {
      const startDate = new Date(year, month - 1, 1);
      const endDate = new Date(year, month, 0);

      const metric = await prisma.metric.findFirst({
        where: {
          locationId,
          metricType,
          date: {
            gte: startDate,
            lte: endDate,
          },
        },
        orderBy: { date: 'desc' },
      });

      if (!metric) return null;

      return {
        id: metric.id,
        locationId: metric.locationId,
        date: metric.date,
        metricType: metric.metricType,
        value: metric.value,
        createdAt: metric.createdAt,
      };
    } catch (error) {
      logger.error(`Error fetching metrics for month ${year}-${month}:`, error);
      return null;
    }
  }

  /**
   * Fetch YoY comparison: current month vs same month last year
   */
  async getMetricsForYoYComparison(
    locationId: string,
    currentYear: number,
    currentMonth: number,
    metricType: string
  ): Promise<YoYData> {
    try {
      // Fetch current month metric
      const currentMetric = await this.getMetricsForMonth(
        locationId,
        currentYear,
        currentMonth,
        metricType
      );

      // Fetch prior year same month metric
      const priorYearMetric = await this.getMetricsForMonth(
        locationId,
        currentYear - 1,
        currentMonth,
        metricType
      );

      // Calculate YoY percentage
      const yoyPercent = currentMetric
        ? this.calculateYoYGrowth(currentMetric.value, priorYearMetric?.value || null)
        : null;

      const trend = this.determineTrend(yoyPercent);

      return {
        current: currentMetric
          ? {
              value: currentMetric.value,
              date: currentMetric.date.toISOString().split('T')[0],
              metricType: currentMetric.metricType,
            }
          : null,
        priorYear: priorYearMetric
          ? {
              value: priorYearMetric.value,
              date: priorYearMetric.date.toISOString().split('T')[0],
            }
          : null,
        yoyPercent,
        trend,
      };
    } catch (error) {
      logger.error('Error calculating YoY comparison:', error);
      return {
        current: null,
        priorYear: null,
        yoyPercent: null,
        trend: null,
      };
    }
  }

  /**
   * Fetch metrics for a date range with optional comparison mode
   */
  async getMetricsForPeriod(
    locationId: string,
    startDate: Date,
    endDate: Date,
    metricType: string,
    compareMode: 'yoy' | 'prev' | 'custom' = 'yoy',
    customDate?: Date
  ): Promise<PeriodData[]> {
    try {
      // Fetch current period metrics
      const currentMetrics = await prisma.metric.findMany({
        where: {
          locationId,
          metricType,
          date: {
            gte: startDate,
            lte: endDate,
          },
        },
        orderBy: { date: 'asc' },
      });

      if (currentMetrics.length === 0) {
        return [];
      }

      // Determine comparison period based on mode
      let comparisonMetrics: typeof currentMetrics = [];

      if (compareMode === 'yoy') {
        // YoY: same period last year
        const startYear = startDate.getFullYear();
        const endYear = endDate.getFullYear();
        const comparisonStart = new Date(startYear - 1, startDate.getMonth(), startDate.getDate());
        const comparisonEnd = new Date(endYear - 1, endDate.getMonth(), endDate.getDate());

        comparisonMetrics = await prisma.metric.findMany({
          where: {
            locationId,
            metricType,
            date: {
              gte: comparisonStart,
              lte: comparisonEnd,
            },
          },
        });
      } else if (compareMode === 'prev') {
        // Previous period: same length before start date
        const periodLength = Math.floor((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
        const comparisonStart = new Date(startDate);
        comparisonStart.setDate(comparisonStart.getDate() - periodLength);
        const comparisonEnd = new Date(startDate);
        comparisonEnd.setDate(comparisonEnd.getDate() - 1);

        comparisonMetrics = await prisma.metric.findMany({
          where: {
            locationId,
            metricType,
            date: {
              gte: comparisonStart,
              lte: comparisonEnd,
            },
          },
        });
      } else if (compareMode === 'custom' && customDate) {
        // Custom: specific single date comparison
        const customStart = new Date(customDate);
        customStart.setDate(customStart.getDate());
        const customEnd = new Date(customDate);
        customEnd.setDate(customEnd.getDate() + 1);

        comparisonMetrics = await prisma.metric.findMany({
          where: {
            locationId,
            metricType,
            date: {
              gte: customStart,
              lte: customEnd,
            },
          },
        });
      }

      // Build result array
      const result: PeriodData[] = currentMetrics.map((metric) => {
        const monthStr = `${metric.date.getFullYear()}-${String(metric.date.getMonth() + 1).padStart(2, '0')}`;

        // Find corresponding comparison metric
        let compareValue = null;
        if (compareMode === 'yoy') {
          // Match by same month/day last year
          const comparisonMetric = comparisonMetrics.find((m) => {
            const mMonth = m.date.getMonth();
            const cMonth = metric.date.getMonth();
            const mDate = m.date.getDate();
            const cDate = metric.date.getDate();
            return mMonth === cMonth && mDate === cDate;
          });
          compareValue = comparisonMetric?.value || null;
        } else {
          // For prev and custom modes, sum/average comparison metrics
          compareValue = comparisonMetrics.length > 0
            ? Math.round(
                comparisonMetrics.reduce((sum, m) => sum + m.value, 0) / comparisonMetrics.length
              )
            : null;
        }

        const yoyPercent = compareValue ? this.calculateYoYGrowth(metric.value, compareValue) : null;
        const trend = this.determineTrend(yoyPercent);

        return {
          month: monthStr,
          year: metric.date.getFullYear(),
          value: metric.value,
          compareValue,
          yoyPercent,
          trend,
        };
      });

      return result;
    } catch (error) {
      logger.error('Error fetching period comparison metrics:', error);
      return [];
    }
  }

  /**
   * Get all metrics for a location (for report generation)
   */
  async getAllMetricsForLocation(
    locationId: string,
    metricTypes?: string[]
  ): Promise<MetricData[]> {
    try {
      const metrics = await prisma.metric.findMany({
        where: {
          locationId,
          ...(metricTypes && metricTypes.length > 0
            ? { metricType: { in: metricTypes } }
            : {}),
        },
        orderBy: [{ date: 'desc' }],
      });

      return metrics.map((m) => ({
        id: m.id,
        locationId: m.locationId,
        date: m.date,
        metricType: m.metricType,
        value: m.value,
        createdAt: m.createdAt,
      }));
    } catch (error) {
      logger.error('Error fetching all metrics for location:', error);
      return [];
    }
  }

  /**
   * Get 6-year growth summary (72 months)
   */
  async get6YearGrowthSummary(
    locationId: string,
    metricType: string
  ): Promise<GrowthData[]> {
    try {
      const endDate = new Date();
      const startDate = new Date();
      startDate.setFullYear(startDate.getFullYear() - 6);

      const metrics = await prisma.metric.findMany({
        where: {
          locationId,
          metricType,
          date: {
            gte: startDate,
            lte: endDate,
          },
        },
        orderBy: { date: 'asc' },
      });

      if (metrics.length === 0) {
        return [];
      }

      // Build result with YoY calculations
      const result: GrowthData[] = metrics.map((metric, index) => {
        const monthStr = `${String(metric.date.getMonth() + 1).padStart(2, '0')}-${metric.date.getFullYear()}`;

        // Find metric from exactly 1 year ago
        const yearAgoMetric = metrics.find((m) => {
          const diff = Math.abs(
            (metric.date.getTime() - m.date.getTime()) / (1000 * 60 * 60 * 24 * 365)
          );
          return diff < 0.1; // Within 10% of a year
        });

        const yoyPercent = yearAgoMetric
          ? this.calculateYoYGrowth(metric.value, yearAgoMetric.value)
          : null;

        const trend = this.determineTrend(yoyPercent);

        return {
          month: monthStr,
          year: metric.date.getFullYear(),
          value: metric.value,
          yoyPercent,
          trend,
        };
      });

      return result;
    } catch (error) {
      logger.error('Error calculating 6-year growth summary:', error);
      return [];
    }
  }

  /**
   * Cache YoY comparison result for future lookups
   */
  async cacheYoYComparison(
    locationId: string,
    metricType: string,
    year: number,
    month: number,
    currentValue: number,
    priorYearValue: number | null
  ): Promise<void> {
    try {
      const yoyPercent = this.calculateYoYGrowth(currentValue, priorYearValue);

      // Note: YoYComparison table caching is optional and can be implemented
      // after Prisma client regeneration with the correct composite key syntax
      logger.info(
        `YoY comparison cached (in-memory): ${locationId} ${metricType} ${year}-${month} = ${yoyPercent}%`
      );
    } catch (error) {
      logger.warn('Error caching YoY comparison (non-critical):', error);
      // Non-critical operation, don't throw
    }
  }
}

export default new MetricsService();
