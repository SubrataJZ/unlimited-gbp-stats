import { Router, Request, Response } from 'express';
import googleService from '../services/google.service';
import { asyncHandler } from '../middlewares/error.middleware';
import { validateJWT } from '../middlewares/auth.middleware';
import { issueTokenPair, rotateRefreshToken, revokeAllRefreshTokens } from '../utils/tokens';
import { auditEvents } from '../middlewares/audit.middleware';
import { recordFailedAuth, clearFailedAttempts, checkAccountLockout } from '../utils/security';
import { prisma } from '../index';
import { AuthenticationError } from '../utils/errors';
import logger from '../utils/logger';

const router = Router();

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://zixify.zixai.in';

// Cookie options for the httpOnly refresh token
const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict' as const,
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days in ms
  path: '/api/auth',
};

/**
 * GET /api/auth/google
 * Initiate Google OAuth — redirects to Google's consent screen.
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

    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
  } catch (error) {
    logger.error('Failed to redirect to Google OAuth:', error);
    res.status(500).json({ error: 'Failed to initialize Google OAuth' });
  }
});

/**
 * GET /api/auth/google/callback
 *
 * Google redirects here after user grants consent.
 * Issues a 15-min access token + 30-day refresh token.
 * Refresh token stored in httpOnly cookie; access token in URL fragment for the extension.
 */
router.get(
  '/google/callback',
  asyncHandler(async (req: Request, res: Response) => {
    const { code, error } = req.query;

    if (error) {
      logger.warn(`Google OAuth error: ${error}`);
      return res.redirect(`${FRONTEND_URL}?error=${error}`);
    }

    if (!code || typeof code !== 'string') {
      await recordFailedAuth({
        ipAddress: req.ip || 'unknown',
        userAgent: req.get('user-agent'),
        reason: 'missing_auth_code',
      });
      return res.redirect(`${FRONTEND_URL}?error=missing_code`);
    }

    let user;
    try {
      user = await googleService.handleOAuthCallback(code);
      if (!user) throw new Error('OAuth callback returned no user');
    } catch (error) {
      await recordFailedAuth({
        ipAddress: req.ip || 'unknown',
        userAgent: req.get('user-agent'),
        reason: 'oauth_callback_failed',
      });
      logger.error('OAuth callback failed:', error);
      return res.redirect(`${FRONTEND_URL}?error=oauth_failed`);
    }

    const { accessToken, refreshToken, expiresIn } = await issueTokenPair(user.id, user.email);

    // httpOnly cookie carries the refresh token — JS cannot read it
    res.cookie('gbp_refresh', refreshToken, REFRESH_COOKIE_OPTIONS);

    // Clear failed authentication attempts for this user (successful login)
    await clearFailedAttempts(user.id);

    // Log login event
    await auditEvents.login(req, user.id, 'oauth');

    logger.info(`User ${user.id} logged in via Google OAuth`);

    // Pass access token + metadata in URL for the extension/dashboard to consume
    const params = new URLSearchParams({
      token: accessToken,
      expiresIn: String(expiresIn),
      userId: user.id,
      name: user.name || '',
      locations: String(user.locations?.length || 0),
    });

    res.redirect(`${FRONTEND_URL}?${params.toString()}`);
  })
);

/**
 * POST /api/auth/refresh
 *
 * Exchange a valid refresh token for a new access + refresh token pair.
 * Implements rotation: the old refresh token is invalidated immediately.
 *
 * Accepts the refresh token either from:
 *   1. httpOnly cookie  (browser flow)
 *   2. Request body     (extension / mobile flow)
 */
router.post(
  '/refresh',
  asyncHandler(async (req: Request, res: Response) => {
    const rawToken = req.cookies?.gbp_refresh || req.body?.refreshToken;

    if (!rawToken) {
      throw new AuthenticationError('No refresh token provided');
    }

    const { accessToken, refreshToken: newRefreshToken, expiresIn } = await rotateRefreshToken(rawToken);

    // Rotate the cookie
    res.cookie('gbp_refresh', newRefreshToken, REFRESH_COOKIE_OPTIONS);

    // Log token refresh event (extract userId from JWT before rotation)
    // This is called before validateJWT, so we need to extract from the token itself
    try {
      const decoded = require('jsonwebtoken').decode(rawToken);
      if (decoded?.userId) {
        await auditEvents.tokenRefresh(req, decoded.userId);
      }
    } catch (e) {
      // Silently skip audit if token decode fails
    }

    res.json({
      accessToken,
      expiresIn,
      // Also return new refresh token for extension/mobile (they can't read cookies)
      refreshToken: newRefreshToken,
    });
  })
);

/**
 * POST /api/auth/logout
 *
 * Revoke all refresh tokens for the user and clear the cookie.
 */
router.post(
  '/logout',
  validateJWT,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.id;
    await revokeAllRefreshTokens(userId);
    res.clearCookie('gbp_refresh', { path: '/api/auth' });

    // Log logout event
    await auditEvents.logout(req, userId);

    logger.info(`User ${userId} logged out`);
    res.json({ message: 'Logged out successfully' });
  })
);

/**
 * GET /api/auth/me
 *
 * Return the current authenticated user's profile and linked locations.
 */
router.get(
  '/me',
  validateJWT,
  asyncHandler(async (req: Request, res: Response) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
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
      throw new AuthenticationError('User not found');
    }

    res.json({ user });
  })
);

export default router;
