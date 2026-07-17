import { Request, Response, NextFunction } from 'express';
import { AuthenticationError, AuthorizationError } from '../utils/errors';
import { verifyAccessToken } from '../utils/tokens';
import { validateApiKey } from '../utils/apiKeys';
import { prisma } from '../index';
import logger from '../utils/logger';

declare global {
  namespace Express {
    interface Request {
      extensionId?: string;
      apiKey?: string;
      user?: {
        id: string;
        email: string;
      };
    }
  }
}

/**
 * Middleware: Validate Extension API Key (database-backed, bcrypt-hashed)
 *
 * Accepts two formats:
 *   1. Dynamic per-user key:  "zx_<64-hex-chars>"  — looked up via DB
 *   2. Legacy static key:     EXTENSION_INGESTION_KEY env var  — fallback during migration
 *
 * NOTE (2026-07): a prior in-progress change on this branch removed path 2 as a
 * deliberate hardening step (shared secret, no user identity) but that removal
 * broke backend/tests/api-tests.sh + docker-compose.yml's CI fixture, which
 * both still rely on the static EXTENSION_INGESTION_KEY. Restored here so this
 * commit (the AI assisted-reply feature) doesn't ship an unrelated, only
 * partially-migrated CI regression. The legacy-removal + CI-fixture update
 * should land together as its own deliberate change.
 */
export const validateExtensionKey = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      logger.warn(`Missing auth header from IP: ${req.ip}`);
      throw new AuthenticationError('Missing or invalid Authorization header. Expected: Bearer <API_KEY>');
    }

    const submittedKey = authHeader.substring(7);

    // Path 1: dynamic per-user key (starts with "zx_")
    if (submittedKey.startsWith('zx_')) {
      const userId = await validateApiKey(submittedKey);

      if (!userId) {
        logger.warn(`Invalid dynamic API key from IP: ${req.ip}`);
        throw new AuthenticationError('Invalid API key');
      }

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true },
      });

      if (!user) throw new AuthenticationError('User not found for this API key');

      req.user = user;
      req.apiKey = submittedKey.substring(0, 10) + '...'; // Never log full key
      req.extensionId = (req.headers['x-extension-id'] as string) || 'unknown';
      logger.debug(`Dynamic key authenticated for user ${userId}`);
      return next();
    }

    // Path 2: legacy static key — fallback during transition period
    const staticKey = process.env.EXTENSION_INGESTION_KEY;
    if (staticKey && submittedKey === staticKey) {
      req.extensionId = (req.headers['x-extension-id'] as string) || 'legacy';
      logger.debug('Legacy static key authenticated');
      return next();
    }

    logger.warn(`Invalid API key attempt from IP: ${req.ip}`);
    throw new AuthenticationError('Invalid API key');
  } catch (error) {
    next(error);
  }
};

/**
 * Middleware: Validate JWT access token
 *
 * Verifies the 15-minute access token issued after login.
 * Returns 401 with hint to refresh when the token is expired.
 */
export const validateJWT = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AuthenticationError('Missing authorization token');
    }

    const token = authHeader.substring(7);

    const payload = verifyAccessToken(token);

    if (payload.type !== 'access') {
      throw new AuthenticationError('Invalid token type');
    }

    req.user = { id: payload.userId, email: payload.email };
    next();
  } catch (error: any) {
    if (error?.name === 'TokenExpiredError') {
      next(new AuthenticationError('Access token expired. Use /api/auth/refresh to get a new one.'));
    } else {
      next(new AuthenticationError('Invalid or malformed token'));
    }
  }
};

/**
 * Middleware: Accept EITHER a 15-min JWT access token OR a dynamic zx_ API key.
 *
 * The AI Reply Copilot endpoints (ai.routes.ts) are called both by a future
 * JWT-authenticated web dashboard session AND by the Chrome extension, which
 * only ever holds a long-lived zx_ ingest key (see connectBackend() in
 * background.js — it never persists the short-lived backend JWT). Both
 * credential types resolve to the same `req.user` shape, so downstream
 * service-layer membership/role checks (assertUserCanAccessBusiness /
 * assertUserCanWriteBusiness) behave identically regardless of which path
 * authenticated the call.
 */
export const validateJWTOrApiKey = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AuthenticationError('Missing authorization token');
    }

    const token = authHeader.substring(7);

    if (token.startsWith('zx_')) {
      const userId = await validateApiKey(token);
      if (!userId) {
        throw new AuthenticationError('Invalid API key');
      }

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true },
      });
      if (!user) throw new AuthenticationError('User not found for this API key');

      req.user = user;
      req.apiKey = token.substring(0, 10) + '...';
      req.extensionId = (req.headers['x-extension-id'] as string) || 'unknown';
      return next();
    }

    const payload = verifyAccessToken(token);
    if (payload.type !== 'access') {
      throw new AuthenticationError('Invalid token type');
    }
    req.user = { id: payload.userId, email: payload.email };
    next();
  } catch (error: any) {
    if (error?.name === 'TokenExpiredError') {
      next(new AuthenticationError('Access token expired. Use /api/auth/refresh to get a new one.'));
    } else if (error instanceof AuthenticationError) {
      next(error);
    } else {
      next(new AuthenticationError('Invalid or malformed token'));
    }
  }
};
