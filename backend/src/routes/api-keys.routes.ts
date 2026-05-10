import { Router, Request, Response } from 'express';
import { asyncHandler } from '../middlewares/error.middleware';
import { validateJWT } from '../middlewares/auth.middleware';
import { createApiKey } from '../utils/apiKeys';
import { prisma } from '../index';
import { AuthenticationError, ValidationError } from '../utils/errors';
import logger from '../utils/logger';

const router = Router();

/**
 * POST /api/auth/provision-extension
 *
 * Called by the Chrome extension immediately after OAuth login.
 * Auto-generates a per-extension API key — no manual setup needed.
 *
 * Returns the raw key ONCE. It is never stored in plain-text.
 * Subsequent calls return only the prefix if a key already exists.
 */
router.post(
  '/provision-extension',
  validateJWT,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.id;
    const extensionId = (req.headers['x-extension-id'] as string) || 'default';
    const keyName = `ext-${extensionId}`;

    // Check if already provisioned and active
    const existing = await prisma.apiKey.findUnique({
      where: { userId_name: { userId, name: keyName } },
    });

    if (existing?.isActive) {
      logger.info(`Extension key already provisioned for user ${userId}`);
      return res.json({
        alreadyProvisioned: true,
        prefix: existing.prefix,
        serverUrl: process.env.API_BASE_URL,
        message: 'Key already exists for this extension.',
      });
    }

    // Generate new key — returned once, never stored plain-text
    const rawKey = await createApiKey(userId, keyName);

    logger.info(`Provisioned new extension key for user ${userId}, ext ${extensionId}`);

    res.status(201).json({
      apiKey: rawKey,
      serverUrl: process.env.API_BASE_URL,
      expiresIn: null,
      message: 'Store this key securely in the extension. It will not be shown again.',
    });
  })
);

/**
 * GET /api/auth/api-keys
 *
 * List all active API keys for the logged-in user.
 * Returns metadata only — never the key hash or raw value.
 */
router.get(
  '/api-keys',
  validateJWT,
  asyncHandler(async (req: Request, res: Response) => {
    const keys = await prisma.apiKey.findMany({
      where: { userId: req.user!.id, isActive: true },
      select: {
        id: true,
        name: true,
        prefix: true,
        isActive: true,
        lastUsedAt: true,
        expiresAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ keys });
  })
);

/**
 * POST /api/auth/api-keys
 *
 * Manually create a named API key (e.g. for CI, scripts, or integrations).
 * Body: { name: string, expiresInDays?: number }
 */
router.post(
  '/api-keys',
  validateJWT,
  asyncHandler(async (req: Request, res: Response) => {
    const { name, expiresInDays } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      throw new ValidationError('Key name is required');
    }

    if (name.trim().length > 64) {
      throw new ValidationError('Key name must be 64 characters or fewer');
    }

    if (expiresInDays !== undefined && (typeof expiresInDays !== 'number' || expiresInDays < 1)) {
      throw new ValidationError('expiresInDays must be a positive integer');
    }

    const rawKey = await createApiKey(req.user!.id, name.trim(), expiresInDays);

    logger.info(`User ${req.user!.id} created API key "${name.trim()}"`);

    res.status(201).json({
      apiKey: rawKey,
      message: 'Store this key securely. It will not be shown again.',
    });
  })
);

/**
 * DELETE /api/auth/api-keys/:id
 *
 * Revoke (soft-delete) an API key by its database ID.
 * The key immediately stops working for ingestion.
 */
router.delete(
  '/api-keys/:id',
  validateJWT,
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;

    const key = await prisma.apiKey.findUnique({ where: { id } });

    if (!key || key.userId !== req.user!.id) {
      throw new AuthenticationError('API key not found');
    }

    await prisma.apiKey.update({
      where: { id },
      data: { isActive: false },
    });

    logger.info(`User ${req.user!.id} revoked API key ${id}`);

    res.json({ message: 'API key revoked successfully' });
  })
);

export default router;
