/**
 * AI Review Reply Copilot — routes (Module D)
 *
 * Mount at /api/ai in index.ts:
 *   app.use('/api/ai', aiRoutes);
 *
 * Endpoints:
 *   POST   /api/ai/reply        — generate draft reply
 *   PATCH  /api/ai/reply/:id    — update draft (finalText / status)
 *   GET    /api/ai/usage        — monthly usage summary
 *   PUT    /api/ai/context      — set / update business context
 */

import { Router } from 'express';
import { validateJWT } from '../middlewares/auth.middleware';
import { asyncHandler } from '../middlewares/error.middleware';
import {
  generateReply,
  updateReply,
  getUsage,
  setContext,
} from '../controllers/ai.controller';

const router = Router();

/**
 * POST /api/ai/reply
 * Generate an AI draft reply for a scraped review or ad-hoc review text.
 * Requires JWT.
 */
router.post('/reply', asyncHandler(validateJWT), generateReply);

/**
 * PATCH /api/ai/reply/:id
 * Edit finalText and/or status of a saved ReviewReply.
 * Requires JWT.
 */
router.patch('/reply/:id', asyncHandler(validateJWT), updateReply);

/**
 * GET /api/ai/usage
 * Return the current user's AI cost/token usage for the running calendar month.
 * Requires JWT.
 */
router.get('/usage', asyncHandler(validateJWT), getUsage);

/**
 * PUT /api/ai/context
 * Create or update the BusinessContext for a TrackedBusiness.
 * Requires JWT.
 */
router.put('/context', asyncHandler(validateJWT), setContext);

export default router;
