import { Request, Response } from 'express';
import { prisma } from '../index';
import { asyncHandler } from '../middlewares/error.middleware';
import { ValidationError, InternalServerError } from '../utils/errors';
import logger from '../utils/logger';

/**
 * Interface for incoming metric from Chrome extension
 */
interface IncomingMetric {
  googleLocationId: string;
  date: string; // ISO date string: YYYY-MM-DD
  metricType: string; // e.g., 'views', 'actions', 'phone_calls'
  value: number;
}

/**
 * Controller: Ingest Metrics from Chrome Extension
 *
 * Purpose:
 * - Receives an array of performance metrics from the Chrome extension
 * - Validates each metric
 * - Uses Prisma upsert to ensure idempotency (no duplicate data)
 * - Responds with operation summary
 *
 * Expected Request Body:
 * {
 *   "metrics": [
 *     {
 *       "googleLocationId": "12345678901234567890",
 *       "date": "2024-01-15",
 *       "metricType": "views",
 *       "value": 150
 *     },
 *     ...
 *   ]
 * }
 *
 * @route POST /api/ingest
 * @access Private (Extension API key required)
 * @returns Summary of ingested metrics
 */
export const ingestMetrics = asyncHandler(
  async (req: Request, res: Response) => {
    // Validate request body
    const { metrics } = req.body;

    if (!metrics || !Array.isArray(metrics)) {
      throw new ValidationError(
        'Request body must contain a "metrics" array'
      );
    }

    if (metrics.length === 0) {
      throw new ValidationError('Metrics array cannot be empty');
    }

    if (metrics.length > 1000) {
      throw new ValidationError(
        'Too many metrics in single request (max 1000). Please batch your requests.'
      );
    }

    logger.info(
      `Ingesting ${metrics.length} metrics from extension (ID: ${req.extensionId})`
    );

    // Ensure test user exists for ingestion
    const testUser = await prisma.user.upsert({
      where: { googleId: 'test-extension-user' },
      update: {},
      create: {
        googleId: 'test-extension-user',
        email: 'test-extension@example.com',
        name: 'Extension Test User',
      },
    });
    const testUserId = testUser.id;

    const results = {
      successful: 0,
      failed: 0,
      errors: [] as Array<{ index: number; metric: IncomingMetric; error: string }>,
    };

    /**
     * Process each metric individually
     * Even if one fails, continue processing others (bulk operation resilience)
     */
    for (let i = 0; i < metrics.length; i++) {
      const metric = metrics[i] as IncomingMetric;

      try {
        // Validate individual metric
        validateMetric(metric);

        // Parse and validate date
        const metricDate = new Date(metric.date);
        if (isNaN(metricDate.getTime())) {
          throw new ValidationError(
            `Invalid date format. Expected YYYY-MM-DD, got "${metric.date}"`
          );
        }

        /**
         * Ensure location exists before creating metric
         * Auto-create location if it doesn't exist (for testing/flexibility)
         */
        await prisma.location.upsert({
          where: { googleLocationId: metric.googleLocationId },
          update: {}, // No updates if location exists
          create: {
            googleLocationId: metric.googleLocationId,
            businessName: `Location ${metric.googleLocationId}`, // Auto-generated name
            userId: testUserId, // Use test user ID
          },
        });

        /**
         * Upsert Strategy:
         * - Unique constraint: (googleLocationId, date, metricType)
         * - If metric exists with same key, update the value
         * - If metric doesn't exist, create new record
         * - This ensures idempotency: pushing same metric twice = no duplicates
         */
        await prisma.metric.upsert({
          where: {
            // Composite unique key (defined in Prisma schema)
            locationId_date_metricType: {
              locationId: metric.googleLocationId,
              date: metricDate,
              metricType: metric.metricType,
            },
          },
          update: {
            // Update if record already exists
            value: metric.value,
          },
          create: {
            // Create if record doesn't exist
            locationId: metric.googleLocationId,
            date: metricDate,
            metricType: metric.metricType,
            value: metric.value,
          },
        });

        results.successful++;
      } catch (error) {
        results.failed++;
        results.errors.push({
          index: i,
          metric,
          error: error instanceof Error ? error.message : 'Unknown error',
        });

        logger.warn(
          `Failed to ingest metric at index ${i}:`,
          metric,
          error
        );
      }
    }

    /**
     * Response Summary
     * - Client can check successful count
     * - If there are errors, client should retry failed metrics
     */
    const response = {
      summary: {
        total: metrics.length,
        successful: results.successful,
        failed: results.failed,
      },
      ...(results.failed > 0 && { errors: results.errors }),
      timestamp: new Date().toISOString(),
    };

    // HTTP 207 Multi-Status: some operations succeeded, some failed
    // HTTP 200 OK: all operations succeeded
    const statusCode = results.failed > 0 ? 207 : 200;

    res.status(statusCode).json(response);

    logger.info(
      `Ingestion completed: ${results.successful} successful, ${results.failed} failed`
    );
  }
);

/**
 * Helper Function: Validate Individual Metric
 *
 * Purpose:
 * - Ensures metric has all required fields
 * - Ensures types are correct
 * - Ensures values are in acceptable ranges
 *
 * @param metric Metric object to validate
 * @throws ValidationError if metric is invalid
 */
function validateMetric(metric: IncomingMetric): void {
  // Check required fields
  if (!metric.googleLocationId || typeof metric.googleLocationId !== 'string') {
    throw new ValidationError(
      'googleLocationId is required and must be a string'
    );
  }

  if (!metric.date || typeof metric.date !== 'string') {
    throw new ValidationError('date is required and must be a string (YYYY-MM-DD)');
  }

  if (!metric.metricType || typeof metric.metricType !== 'string') {
    throw new ValidationError('metricType is required and must be a string');
  }

  if (typeof metric.value !== 'number') {
    throw new ValidationError('value is required and must be a number');
  }

  // Validate value range (no negative values)
  if (metric.value < 0) {
    throw new ValidationError('Metric value cannot be negative');
  }

  // Validate metric type against known types
  const validMetricTypes = [
    'views',
    'actions',
    'phone_calls',
    'direction_requests',
    'website_clicks',
    'message_clicks',
    'photos_videos_views',
  ];

  if (!validMetricTypes.includes(metric.metricType)) {
    throw new ValidationError(
      `Invalid metricType. Must be one of: ${validMetricTypes.join(', ')}`
    );
  }

  // Validate location code format (numeric string)
  if (!/^\d+$/.test(metric.googleLocationId)) {
    throw new ValidationError(
      'googleLocationId must be a numeric string (Google location code)'
    );
  }
}

/**
 * Controller: Get Ingestion Status
 *
 * Purpose:
 * - Returns status of recent ingestion operations (for debugging)
 * - Shows total metrics in database
 * - Shows last ingestion timestamp
 *
 * @route GET /api/ingest/status
 * @access Private (Extension API key required)
 */
export const getIngestionStatus = asyncHandler(
  async (req: Request, res: Response) => {
    try {
      // Get total metrics count
      const totalMetrics = await prisma.metric.count();

      // Get latest ingestion timestamp
      const latestMetric = await prisma.metric.findFirst({
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });

      // Get metrics by location
      const metricsByLocation = await prisma.metric.groupBy({
        by: ['locationId'],
        _count: {
          id: true,
        },
      });

      res.status(200).json({
        status: 'ok',
        totalMetrics,
        locationsWithData: metricsByLocation.length,
        lastIngestionAt: latestMetric?.createdAt || null,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Failed to get ingestion status:', error);
      throw new InternalServerError(
        'Failed to retrieve ingestion status'
      );
    }
  }
);
