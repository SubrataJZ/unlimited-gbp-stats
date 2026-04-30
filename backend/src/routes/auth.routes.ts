import { Router, Request, Response } from 'express';
import googleService from '../services/google.service';
import { asyncHandler } from '../middlewares/error.middleware';
import logger from '../utils/logger';

const router = Router();

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
 */
router.get(
  '/google/callback',
  asyncHandler(async (req: Request, res: Response) => {
    const { code, state, error } = req.query;

    // Handle OAuth errors
    if (error) {
      logger.warn(`Google OAuth error: ${error}`);
      return res.redirect(`http://localhost:3000/auth/error?error=${error}`);
    }

    if (!code || typeof code !== 'string') {
      logger.warn('Missing authorization code in callback');
      return res.redirect('http://localhost:3000/auth/error?error=missing_code');
    }

    try {
      // Process OAuth callback and auto-link locations
      const user = await googleService.handleOAuthCallback(code);

      logger.info(`User ${user?.id} logged in successfully`);
      res.redirect(
        `http://localhost:3000/dashboard?userId=${user?.id}&locations=${user?.locations?.length || 0}`
      );
    } catch (error) {
      logger.error('OAuth callback processing failed:', error);
      res.redirect('http://localhost:3000/auth/error?error=auth_failed');
    }
  })
);

/**
 * GET /api/auth/logout
 * Purpose: Logout user (invalidate session)
 */
router.get('/logout', (req: Request, res: Response) => {
  // TODO: Implement logout (clear session/cookie)
  res.json({ message: 'Logged out successfully' });
});

/**
 * GET /api/auth/me
 * Purpose: Get current authenticated user
 * Auth: JWT token required
 */
router.get('/me', (req: Request, res: Response) => {
  // TODO: Validate JWT and return current user
  res.json({ message: 'Get authenticated user' });
});

export default router;
