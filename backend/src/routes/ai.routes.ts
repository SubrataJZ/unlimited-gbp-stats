/**
 * AI Review Reply Copilot — routes (Module D)
 *
 * Mount at /api/ai in index.ts:
 *   app.use('/api/ai', aiRoutes);
 *
 * Endpoints:
 *   POST   /api/ai/reply        — generate draft reply
 *   POST   /api/ai/reply/bulk   — generate draft replies for up to 50 reviews at once
 *   PATCH  /api/ai/reply/:id    — update draft (finalText / status)
 *   GET    /api/ai/reviews      — list scraped reviews for a business (optionally unreplied only)
 *   GET    /api/ai/usage        — monthly usage summary
 *   PUT    /api/ai/context      — set / update business context
 *
 * Auth: validateJWTOrApiKey accepts either a 15-min web-session JWT OR the
 * Chrome extension's long-lived zx_ ingest key, since the extension never
 * persists a backend JWT (see auth.middleware.ts for rationale).
 */

import { Router } from 'express';
import { validateJWTOrApiKey } from '../middlewares/auth.middleware';
import { asyncHandler } from '../middlewares/error.middleware';
import {
  generateReply,
  generateRepliesBulk,
  listReviews,
  updateReply,
  getUsage,
  setContext,
} from '../controllers/ai.controller';

const router = Router();

/**
 * POST /api/ai/reply
 * Generate an AI draft reply for a scraped review or ad-hoc review text.
 */
router.post('/reply', asyncHandler(validateJWTOrApiKey), generateReply);

/**
 * POST /api/ai/reply/bulk
 * Generate AI draft replies for up to 50 scraped reviews in one call.
 * Rejects OWNER_READONLY (write action).
 */
router.post('/reply/bulk', asyncHandler(validateJWTOrApiKey), generateRepliesBulk);

/**
 * GET /api/ai/reviews
 * List scraped reviews for a business (optionally only un-replied ones).
 * Read-only — available to every role.
 */
router.get('/reviews', asyncHandler(validateJWTOrApiKey), listReviews);

/**
 * PATCH /api/ai/reply/:id
 * Edit finalText and/or status of a saved ReviewReply.
 */
router.patch('/reply/:id', asyncHandler(validateJWTOrApiKey), updateReply);

/**
 * GET /api/ai/usage
 * Return the current user's AI cost/token usage for the running calendar month.
 */
router.get('/usage', asyncHandler(validateJWTOrApiKey), getUsage);

/**
 * PUT /api/ai/context
 * Create or update the BusinessContext for a TrackedBusiness.
 */
router.put('/context', asyncHandler(validateJWTOrApiKey), setContext);

export default router;
