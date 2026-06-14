import { Router } from 'express';
import * as ingestController from '../controllers/ingest.controller';
import * as intelController from '../controllers/intel.controller';
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

/**
 * POST /api/ingest/intel
 * Purpose: Idempotent sync of scraped GBP competitor/own-profile intelligence
 * Auth: Per-user extension API key (zx_...) — legacy static key is rejected
 */
router.post(
  '/intel',
  asyncHandler(validateExtensionKey),
  asyncHandler(intelController.ingestIntel)
);

/**
 * GET /api/ingest/intel
 * Purpose: Read back the user's tracked businesses + review snapshots/reviews
 * Auth: Per-user extension API key (zx_...)
 */
router.get(
  '/intel',
  asyncHandler(validateExtensionKey),
  asyncHandler(intelController.getIntel)
);

export default router;
