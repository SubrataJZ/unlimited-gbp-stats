import { Router, Request, Response } from 'express';
import { prisma } from '../index';
import { asyncHandler } from '../middlewares/error.middleware';
import { NotFoundError } from '../utils/errors';
import logger from '../utils/logger';

const router = Router();

/**
 * GET /api/locations
 * Purpose: Get all locations for authenticated user
 * Auth: JWT token required
 * @param userId From JWT token
 */
router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    // TODO: Extract userId from JWT
    const userId = req.query.userId as string;

    if (!userId) {
      return res.status(400).json({ error: 'User ID required' });
    }

    const locations = await prisma.location.findMany({
      where: { userId },
      include: {
        metrics: {
          select: { metricType: true, value: true, date: true },
          orderBy: { date: 'desc' },
          take: 1,
        },
      },
    });

    res.json({
      total: locations.length,
      locations,
    });
  })
);

/**
 * GET /api/locations/:locationId/metrics
 * Purpose: Get metrics for a specific location
 * Auth: JWT token required
 * @param locationId Location ID
 * @param from Start date (ISO format)
 * @param to End date (ISO format)
 */
router.get(
  '/:locationId/metrics',
  asyncHandler(async (req: Request, res: Response) => {
    const { locationId } = req.params;
    const { from, to, metricType } = req.query;

    const location = await prisma.location.findUnique({
      where: { id: locationId },
    });

    if (!location) {
      throw new NotFoundError('Location not found');
    }

    const whereClause: any = {
      locationId: location.googleLocationId,
    };

    if (from || to) {
      whereClause.date = {};
      if (from) whereClause.date.gte = new Date(from as string);
      if (to) whereClause.date.lte = new Date(to as string);
    }

    if (metricType) {
      whereClause.metricType = metricType;
    }

    const metrics = await prisma.metric.findMany({
      where: whereClause,
      orderBy: { date: 'desc' },
    });

    res.json({
      location,
      metrics,
      totalRecords: metrics.length,
    });
  })
);

export default router;
