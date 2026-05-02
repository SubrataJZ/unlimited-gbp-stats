import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import googleService from '../services/google.service';
import { asyncHandler } from '../middlewares/error.middleware';
import { prisma } from '../index';
import logger from '../utils/logger';

const router = Router();

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://zixify.zixai.in';
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret';

/**
 * GET /api/auth/google
 * Purpose: Initiate Google OAuth flow
 * Redirects to Google's consent screen
 */
router.get('/google', (req: Request, res: Response) => {
  try {
    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID || '',
      redirect_uri: process.env.GOOGLE_REDIRECT_URI || '',
      response_type: 'code',
      scope: 'openid email profile https://www.googleapis.com/auth/business.manage',
      access_type: 'offline',
      prompt: 'consent',
    });

    const url = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    logger.debug(`Redirecting to Google OAuth: ${url}`);
    res.redirect(url);
  } catch (error) {
    logger.error('Failed to redirect to Google OAuth:', error);
    res.status(500).json({ error: 'Failed to initialize Google OAuth' });
  }
});

/**
 * GET /api/auth/google/callback
 * Purpose: Handle Google OAuth callback
 * Google redirects here with authorization code
 * Issues a JWT token and redirects to frontend dashboard
 */
router.get(
  '/google/callback',
  asyncHandler(async (req: Request, res: Response) => {
    const { code, error } = req.query;

    // Handle OAuth errors
    if (error) {
      logger.warn(`Google OAuth error: ${error}`);
      return res.redirect(`${FRONTEND_URL}?error=${error}`);
    }

    if (!code || typeof code !== 'string') {
      logger.warn('Missing authorization code in callback');
      return res.redirect(`${FRONTEND_URL}?error=missing_code`);
    }

    try {
      // Process OAuth callback and auto-link locations
      const user = await googleService.handleOAuthCallback(code);

      // Issue JWT token for subsequent API requests
      const token = jwt.sign(
        { userId: user?.id, email: user?.email },
        JWT_SECRET,
        { expiresIn: '7d' }
      );

      logger.info(`User ${user?.id} logged in, ${user?.locations?.length || 0} locations linked`);

      // Redirect to frontend with JWT token and user info
      res.redirect(
        `${FRONTEND_URL}?token=${token}&userId=${user?.id}&locations=${user?.locations?.length || 0}&name=${encodeURIComponent(user?.name || '')}`
      );
    } catch (error) {
      logger.error('OAuth callback processing failed:', error);
      res.redirect(`${FRONTEND_URL}?error=auth_failed`);
    }
  })
);

/**
 * POST /api/auth/logout
 * Purpose: Logout user (client should discard JWT)
 */
router.post('/logout', (req: Request, res: Response) => {
  // JWT is stateless — client discards token
  // Optionally: clear refresh token from database
  res.json({ message: 'Logged out successfully. Please discard your token.' });
});

/**
 * GET /api/auth/me
 * Purpose: Get current authenticated user info
 * Auth: Bearer JWT token required
 */
router.get('/me', asyncHandler(async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string; email: string };

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: {
        id: true,
        email: true,
        name: true,
        avatarUrl: true,
        createdAt: true,
        locations: {
          where: { isActive: true },
          select: {
            id: true,
            googleLocationId: true,
            businessName: true,
            isActive: true,
          },
        },
      },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user });
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}));

export default router;
