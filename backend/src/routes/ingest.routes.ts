import { Router } from 'express';
import * as ingestController from '../controllers/ingest.controller';
import { validateExtensionKey } from '../middlewares/auth.middleware';
import { asyncHandler } from '../middlewares/error.middleware';

const router = Router();

/**
 * POST /api/ingest
 * Purpose: Receive and store metrics from Chrome extension
 * Auth: Static extension API key (Bearer token)
 * Rate Limited: 50 requests per minute
 */
router.post(
  '/',
  validateExtensionKey,
  asyncHandler(ingestController.ingestMetrics)
);

/**
 * GET /api/ingest/status
 * Purpose: Get ingestion statistics and status
 * Auth: Static extension API key
 */
router.get(
  '/status',
  validateExtensionKey,
  asyncHandler(ingestController.getIngestionStatus)
);

export default router;
