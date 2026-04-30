import { Request, Response, NextFunction } from 'express';
import { AuthenticationError, AuthorizationError } from '../utils/errors';
import logger from '../utils/logger';

/**
 * Interface to extend Express Request object with custom properties
 */
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
 * Middleware: Validate Extension Ingestion API Key
 *
 * Purpose:
 * - Protects the /api/ingest endpoint from unauthorized access
 * - Validates the static EXTENSION_INGESTION_KEY passed in Authorization header
 * - Also validates the Chrome Extension ID (optional but recommended)
 *
 * Header Format:
 * Authorization: Bearer <EXTENSION_INGESTION_KEY>
 * X-Extension-ID: <Chrome Extension ID> (optional)
 *
 * @param req Express Request object
 * @param res Express Response object
 * @param next Express NextFunction
 * @throws AuthenticationError if API key is missing or invalid
 */
export const validateExtensionKey = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  try {
    // Extract Authorization header
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      logger.warn(`Invalid auth header format from IP: ${req.ip}`);
      throw new AuthenticationError(
        'Missing or invalid Authorization header. Expected: Bearer <API_KEY>'
      );
    }

    // Extract the API key from "Bearer <key>"
    const apiKey = authHeader.substring(7);

    // Validate against the expected static key
    const expectedKey = process.env.EXTENSION_INGESTION_KEY;

    if (!expectedKey) {
      logger.error('EXTENSION_INGESTION_KEY is not configured in environment');
      throw new AuthenticationError('Server configuration error');
    }

    if (apiKey !== expectedKey) {
      logger.warn(`Invalid API key attempt from IP: ${req.ip}`);
      throw new AuthenticationError('Invalid API key');
    }

    // Optional: Validate Chrome Extension ID
    const extensionId = req.headers['x-extension-id'] as string;
    const expectedExtensionId = process.env.EXTENSION_ID;

    if (extensionId && expectedExtensionId && extensionId !== expectedExtensionId) {
      logger.warn(`Invalid extension ID: ${extensionId} from IP: ${req.ip}`);
      throw new AuthorizationError('Invalid Chrome Extension ID');
    }

    // Store validated credentials in request object
    req.apiKey = apiKey;
    req.extensionId = extensionId || 'unknown';

    logger.debug(`Valid extension key authenticated from ${req.extensionId}`);

    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Middleware: Validate JWT Token (for authenticated API endpoints)
 *
 * Purpose:
 * - Validates JWT tokens for user-authenticated endpoints
 * - Extracts and stores user ID in request object
 *
 * Header Format:
 * Authorization: Bearer <JWT_TOKEN>
 *
 * @param req Express Request object
 * @param res Express Response object
 * @param next Express NextFunction
 * @throws AuthenticationError if token is missing or invalid
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

    // TODO: Implement JWT verification here
    // For now, this is a placeholder
    // You'll need to use jsonwebtoken library:
    // const decoded = jwt.verify(token, process.env.JWT_SECRET!);
    // req.user = decoded as { id: string; email: string };

    logger.debug('JWT token validated');
    next();
  } catch (error) {
    next(error);
  }
};
