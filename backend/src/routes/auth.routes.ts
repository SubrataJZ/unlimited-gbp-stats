import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import googleService from '../services/google.service';
import { asyncHandler } from '../middlewares/error.middleware';
import { validateJWT } from '../middlewares/auth.middleware';
import { issueTokenPair, rotateRefreshToken, revokeAllRefreshTokens } from '../utils/tokens';
import { auditEvents, logAudit } from '../middlewares/audit.middleware';
import {
  registerWithPassword,
  loginWithPassword,
  requestPasswordReset,
  resetPassword,
  changePassword,
} from '../services/auth.service';
import { getPlanForUser } from '../services/billing.service';
import { prisma } from '../index';
import { AuthenticationError, ValidationError } from '../utils/errors';
import logger from '../utils/logger';

const router = Router();

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://zixify.zixai.in';

// Where the server-rendered auth pages live (see auth-pages.routes.ts). Behind
// the production /backend/ proxy this is https://gbp.zixify.zixai.in/backend/auth;
// set AUTH_PAGES_URL in the environment to match. Used to build reset links.
const AUTH_PAGES_URL = (process.env.AUTH_PAGES_URL || 'http://localhost:3001/auth').replace(/\/+$/, '');

/**
 * Tight limiter for the credential endpoints — brute-force / enumeration guard,
 * on top of the app-wide generalLimiter. Keyed by IP.
 */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Too many attempts. Try again in a few minutes.', statusCode: 429 } },
});

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
      return res.redirect(`${FRONTEND_URL}?error=missing_code`);
    }

    const user = await googleService.handleOAuthCallback(code);
    if (!user) throw new Error('OAuth callback returned no user');

    const { accessToken, refreshToken, expiresIn } = await issueTokenPair(user.id, user.email);

    // httpOnly cookie carries the refresh token — JS cannot read it
    res.cookie('gbp_refresh', refreshToken, REFRESH_COOKIE_OPTIONS);

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
 * POST /api/auth/google/extension
 *
 * Token-based login for the Chrome extension. The extension obtains a Google
 * access token via launchWebAuthFlow and posts it here; we verify it, upsert
 * the user, and return a backend access token. The extension then calls
 * POST /api/auth/provision-extension to obtain its zx_ ingest key.
 *
 * Body: { accessToken: string }
 */
router.post(
  '/google/extension',
  asyncHandler(async (req: Request, res: Response) => {
    const { accessToken } = req.body || {};
    if (!accessToken || typeof accessToken !== 'string') {
      throw new ValidationError('accessToken is required');
    }

    const user = await googleService.handleExtensionAccessToken(accessToken);
    if (!user) throw new AuthenticationError('Could not resolve user from Google token');

    const { accessToken: token, refreshToken, expiresIn } = await issueTokenPair(
      user.id,
      user.email
    );

    await auditEvents.login(req, user.id, 'oauth');
    logger.info(`Extension user ${user.id} logged in`);

    res.json({
      token,
      refreshToken,
      expiresIn,
      user: { id: user.id, email: user.email, name: user.name },
    });
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

    const plan = await getPlanForUser(req.user!.id);
    res.json({
      user,
      plan: {
        plan: plan.plan,
        effectivePlan: plan.effectivePlan,
        planExpiresAt: plan.planExpiresAt,
        active: plan.active,
        limits: plan.limits,
      },
    });
  })
);

/**
 * POST /api/auth/register
 * Body: { email, password, name? }
 * Creates a password account (or attaches a password to a Google-only account),
 * returns an access/refresh token pair and sets the refresh cookie.
 */
router.post(
  '/register',
  authLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const result = await registerWithPassword(req.body || {});
    res.cookie('gbp_refresh', result.refreshToken, REFRESH_COOKIE_OPTIONS);
    await auditEvents.login(req, result.user.id, 'password_register');
    res.status(201).json({
      token: result.accessToken,
      refreshToken: result.refreshToken,
      expiresIn: result.expiresIn,
      user: result.user,
    });
  })
);

/**
 * POST /api/auth/login
 * Body: { email, password }
 */
router.post(
  '/login',
  authLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const result = await loginWithPassword(req.body || {});
    res.cookie('gbp_refresh', result.refreshToken, REFRESH_COOKIE_OPTIONS);
    await auditEvents.login(req, result.user.id, 'password');
    res.json({
      token: result.accessToken,
      refreshToken: result.refreshToken,
      expiresIn: result.expiresIn,
      user: result.user,
    });
  })
);

/**
 * POST /api/auth/forgot-password
 * Body: { email }
 * Always responds 200 with the same body — never reveals whether the account
 * exists. Emails a one-time reset link when it does.
 */
router.post(
  '/forgot-password',
  authLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { emailed } = await requestPasswordReset((req.body || {}).email, AUTH_PAGES_URL);
    await logAudit(req, {
      action: 'PASSWORD_RESET_REQUESTED',
      status: 'success',
      metadata: { emailed },
    });
    res.json({ message: 'If an account exists for that address, a reset link is on its way.' });
  })
);

/**
 * POST /api/auth/reset-password
 * Body: { token, password }
 * Consumes the one-time token, sets the new password, revokes all sessions.
 */
router.post(
  '/reset-password',
  authLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body || {};
    await resetPassword({ token: body.token, password: body.password });
    await logAudit(req, { action: 'PASSWORD_RESET_COMPLETED', status: 'success' });
    res.json({ message: 'Password updated. You can now sign in with your new password.' });
  })
);

/**
 * POST /api/auth/change-password  (authenticated)
 * Body: { currentPassword, newPassword }
 */
router.post(
  '/change-password',
  validateJWT,
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body || {};
    await changePassword(req.user!.id, {
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
    });
    res.clearCookie('gbp_refresh', { path: '/api/auth' });
    await logAudit(req, { action: 'PASSWORD_CHANGED', status: 'success', userId: req.user!.id });
    res.json({ message: 'Password changed. Please sign in again.' });
  })
);

export default router;
