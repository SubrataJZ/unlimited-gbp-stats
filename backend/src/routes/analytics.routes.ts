import { Router, Request, Response, NextFunction } from 'express';
import {
  getYoYComparison,
  getPeriodComparison,
  generateReport,
  downloadReport,
  listLocationReports,
} from '../controllers/analytics.controller';
import { validateJWT } from '../middlewares/auth.middleware';
import { AuthorizationError } from '../utils/errors';
import { prisma } from '../index';
import logger from '../utils/logger';

const analyticsRouter = Router();
const reportsRouter = Router();

/**
 * Verify the authenticated user owns the given location.
 * Throws AuthorizationError if the location is missing or owned by someone else.
 */
const assertLocationOwnership = async (
  locationId: string | undefined,
  userId: string | undefined
): Promise<void> => {
  if (!locationId) {
    throw new AuthorizationError('Location ID is required');
  }

  const location = await prisma.location.findUnique({
    where: { googleLocationId: locationId },
    select: { userId: true },
  });

  if (!location) {
    throw new AuthorizationError('Location not found');
  }

  if (location.userId !== userId) {
    logger.warn(
      `Unauthorized access attempt: User ${userId} tried to access location ${locationId}`
    );
    throw new AuthorizationError('You do not have access to this location');
  }
};

/**
 * Middleware: Validate location ownership using the :locationId route param.
 */
const validateLocationOwnership = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    await assertLocationOwnership(req.params.locationId, req.user?.id);
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Middleware: Validate location ownership using the request body's locationId.
 * Used by routes (e.g. POST /generate) where the location is supplied in the body.
 */
const validateLocationOwnershipFromBody = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    await assertLocationOwnership(req.body?.locationId, req.user?.id);
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Analytics Endpoints
 * YoY comparisons and period analytics
 */

// GET /api/analytics/locations/:locationId/yoy
// Get YoY comparison for a specific month
analyticsRouter.get(
  '/locations/:locationId/yoy',
  validateJWT,
  validateLocationOwnership,
  getYoYComparison
);

// GET /api/analytics/locations/:locationId/period-comparison
// Get metrics for a date range with optional comparison
analyticsRouter.get(
  '/locations/:locationId/period-comparison',
  validateJWT,
  validateLocationOwnership,
  getPeriodComparison
);

/**
 * Report Endpoints
 * Generate and download reports
 */

// POST /api/reports/generate
// Generate a new report
reportsRouter.post(
  '/generate',
  validateJWT,
  validateLocationOwnershipFromBody,
  generateReport
);

// GET /api/reports/:reportId/download
// Download a generated report (no auth required - public download links)
reportsRouter.get('/:reportId/download', downloadReport);

// GET /api/reports/locations/:locationId
// List reports for a location
reportsRouter.get(
  '/locations/:locationId',
  validateJWT,
  validateLocationOwnership,
  listLocationReports
);

export { analyticsRouter, reportsRouter };
