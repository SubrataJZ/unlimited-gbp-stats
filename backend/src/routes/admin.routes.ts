import { Router, Request, Response } from 'express';
import { asyncHandler } from '../middlewares/error.middleware';
import { validateJWT } from '../middlewares/auth.middleware';
import { prisma } from '../index';
import { ValidationError } from '../utils/errors';
import logger from '../utils/logger';

const router = Router();

/**
 * GET /api/admin/audit-logs
 *
 * Retrieve paginated audit logs with filtering and sorting.
 * Admin-only endpoint for compliance, security investigation, and operational monitoring.
 *
 * Query Parameters:
 *   - page: number (default: 1)
 *   - limit: number (default: 50, max: 500)
 *   - action: string (filter by action, e.g., 'LOGIN_OAUTH')
 *   - status: 'success' | 'failure' (filter by status)
 *   - userId: string (filter by user ID)
 *   - startDate: ISO string (filter from date)
 *   - endDate: ISO string (filter to date)
 *   - sortBy: 'createdAt' | 'action' | 'userId' (default: createdAt)
 *   - sortOrder: 'asc' | 'desc' (default: desc)
 *   - export: 'csv' | 'json' (optional export format)
 */
router.get(
  '/audit-logs',
  validateJWT,
  asyncHandler(async (req: Request, res: Response) => {
    // Parse and validate query parameters
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit as string) || 50));
    const action = (req.query.action as string) || undefined;
    const status = (req.query.status as 'success' | 'failure') || undefined;
    const userId = (req.query.userId as string) || undefined;
    const startDate = (req.query.startDate as string) || undefined;
    const endDate = (req.query.endDate as string) || undefined;
    const sortBy = (['createdAt', 'action', 'userId'].includes(req.query.sortBy as string)
      ? req.query.sortBy
      : 'createdAt') as string;
    const sortOrder = (req.query.sortOrder as 'asc' | 'desc') || 'desc';
    const exportFormat = (req.query.export as 'csv' | 'json') || undefined;

    // Validate date parameters
    if (startDate) {
      try {
        new Date(startDate);
      } catch {
        throw new ValidationError('Invalid startDate format. Use ISO 8601 (YYYY-MM-DDTHH:mm:ssZ)');
      }
    }
    if (endDate) {
      try {
        new Date(endDate);
      } catch {
        throw new ValidationError('Invalid endDate format. Use ISO 8601 (YYYY-MM-DDTHH:mm:ssZ)');
      }
    }

    // Build filter object
    const where: any = {};
    if (action) where.action = { contains: action, mode: 'insensitive' };
    if (status) where.status = status;
    if (userId) where.userId = userId;
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) where.createdAt.lte = new Date(endDate);
    }

    // Build orderBy object
    const orderBy: any = {};
    orderBy[sortBy] = sortOrder;

    // Query total count
    const total = await prisma.auditLog.count({ where });

    // Query paginated results
    const skip = (page - 1) * limit;
    const logs = await prisma.auditLog.findMany({
      where,
      select: {
        id: true,
        userId: true,
        action: true,
        resource: true,
        status: true,
        ipAddress: true,
        userAgent: true,
        metadata: true,
        createdAt: true,
      },
      orderBy,
      skip,
      take: limit,
    });

    // Handle export formats
    if (exportFormat === 'csv') {
      return exportAsCSV(res, logs, total, page, limit);
    }

    if (exportFormat === 'json') {
      return exportAsJSON(res, logs, total, page, limit);
    }

    // Return paginated JSON response
    const totalPages = Math.ceil(total / limit);
    res.json({
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
      filters: {
        action,
        status,
        userId,
        startDate,
        endDate,
        sortBy,
        sortOrder,
      },
      data: logs,
      timestamp: new Date().toISOString(),
    });

    logger.info(
      `Admin retrieved audit logs: page=${page}, limit=${limit}, total=${total}, action=${action || 'any'}`
    );
  })
);

/**
 * Helper: Export audit logs as CSV
 */
function exportAsCSV(res: Response, logs: any[], total: number, page: number, limit: number) {
  const headers = ['ID', 'User ID', 'Action', 'Resource', 'Status', 'IP Address', 'User Agent', 'Metadata', 'Created At'];
  const rows = logs.map((log) => [
    log.id,
    log.userId || '',
    log.action,
    log.resource || '',
    log.status,
    log.ipAddress || '',
    log.userAgent || '',
    JSON.stringify(log.metadata || {}),
    log.createdAt.toISOString(),
  ]);

  const csv = [
    headers.join(','),
    ...rows.map((row) =>
      row
        .map((cell) => {
          // Escape CSV cells with quotes if they contain commas or quotes
          const str = String(cell);
          if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return `"${str.replace(/"/g, '""')}"`;
          }
          return str;
        })
        .join(',')
    ),
  ].join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="audit-logs-page-${page}-${new Date().toISOString().split('T')[0]}.csv"`
  );
  res.send(csv);
}

/**
 * Helper: Export audit logs as JSON
 */
function exportAsJSON(res: Response, logs: any[], total: number, page: number, limit: number) {
  const totalPages = Math.ceil(total / limit);
  const data = {
    exportedAt: new Date().toISOString(),
    pagination: {
      page,
      limit,
      total,
      totalPages,
    },
    logs,
  };

  res.setHeader('Content-Type', 'application/json');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="audit-logs-page-${page}-${new Date().toISOString().split('T')[0]}.json"`
  );
  res.json(data);
}

export default router;
