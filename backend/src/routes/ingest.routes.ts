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
  asyncHandler(validateExtensionKey),
  asyncHandler(ingestController.ingestMetrics)
);

router.get(
  '/status',
  asyncHandler(validateExtensionKey),
  asyncHandler(ingestController.getIngestionStatus)
);

export default router;
