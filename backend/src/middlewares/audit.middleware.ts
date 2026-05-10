import { Request, Response, NextFunction } from 'express';
import { prisma } from '../index';
import logger from '../utils/logger';

/**
 * Audit Trail Middleware
 *
 * Logs all sensitive operations (auth, API keys, data exports) to the database
 * for compliance, security investigation, and operational insight.
 *
 * Tracked actions:
 *   - LOGIN, LOGOUT, TOKEN_REFRESH
 *   - API_KEY_CREATED, API_KEY_REVOKED
 *   - DATA_EXPORTED, DATA_IMPORTED
 *   - INGEST_SUCCESS, INGEST_FAILED
 */

export interface AuditContext {
  userId?: string;
  action: string;
  resource?: string;
  status: 'success' | 'failure';
  metadata?: Record<string, any>;
}

/**
 * Log an audit event asynchronously (don't block the response)
 */
export async function logAudit(
  req: Request,
  context: AuditContext
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId: context.userId || req.user?.id,
        action: context.action,
        resource: context.resource,
        status: context.status,
        ipAddress: req.ip || req.socket?.remoteAddress,
        userAgent: req.get('user-agent'),
        metadata: context.metadata || {},
      },
    });
  } catch (error) {
    logger.error('Failed to log audit event:', { context, error });
    // Don't throw — audit failures should not break the app
  }
}

/**
 * Middleware factory: wrap route handlers to auto-log sensitive actions
 *
 * Usage:
 *   router.post('/logout', auditedRoute('LOGOUT'), handleLogout);
 *
 * The middleware captures the action, user, IP, and HTTP status on response.
 */
export function auditedRoute(action: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const originalJson = res.json.bind(res);

    // Intercept response to capture success/failure and metadata
    res.json = function (body: any) {
      const isSuccess = res.statusCode < 400;

      // Fire audit log async (don't await)
      logAudit(req, {
        action,
        status: isSuccess ? 'success' : 'failure',
        metadata: isSuccess ? body : { error: body?.error?.message },
      }).catch((error) => logger.error('Audit log error:', error));

      return originalJson(body);
    };

    next();
  };
}

/**
 * High-value audit logging for specific events
 * (called explicitly from route handlers)
 */
export const auditEvents = {
  async login(req: Request, userId: string, method: string) {
    await logAudit(req, {
      userId,
      action: `LOGIN_${method.toUpperCase()}`,
      status: 'success',
      metadata: { method },
    });
  },

  async logout(req: Request, userId: string) {
    await logAudit(req, {
      userId,
      action: 'LOGOUT',
      status: 'success',
    });
  },

  async tokenRefresh(req: Request, userId: string) {
    await logAudit(req, {
      userId,
      action: 'TOKEN_REFRESH',
      status: 'success',
    });
  },

  async apiKeyCreated(req: Request, userId: string, keyId: string, keyName: string) {
    await logAudit(req, {
      userId,
      action: 'API_KEY_CREATED',
      resource: `ApiKey:${keyId}`,
      status: 'success',
      metadata: { name: keyName },
    });
  },

  async apiKeyRevoked(req: Request, userId: string, keyId: string) {
    await logAudit(req, {
      userId,
      action: 'API_KEY_REVOKED',
      resource: `ApiKey:${keyId}`,
      status: 'success',
    });
  },

  async ingestMetrics(
    req: Request,
    userId: string,
    metricsCount: number,
    success: boolean,
    error?: string
  ) {
    await logAudit(req, {
      userId,
      action: success ? 'INGEST_SUCCESS' : 'INGEST_FAILED',
      status: success ? 'success' : 'failure',
      metadata: { metricsCount, error },
    });
  },

  async dataExported(req: Request, userId: string, format: string, recordCount: number) {
    await logAudit(req, {
      userId,
      action: 'DATA_EXPORTED',
      status: 'success',
      metadata: { format, recordCount },
    });
  },

  async dataImported(req: Request, userId: string, recordCount: number, success: boolean) {
    await logAudit(req, {
      userId,
      action: success ? 'DATA_IMPORTED' : 'DATA_IMPORT_FAILED',
      status: success ? 'success' : 'failure',
      metadata: { recordCount },
    });
  },

  async authenticationFailed(req: Request, reason: string) {
    await logAudit(req, {
      action: 'AUTH_FAILED',
      status: 'failure',
      metadata: { reason },
    });
  },
};
