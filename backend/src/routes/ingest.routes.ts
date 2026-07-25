import { Router } from 'express';
import * as ingestController from '../controllers/ingest.controller';
import * as intelController from '../controllers/intel.controller';
import * as metricsIngestController from '../controllers/metrics-ingest.controller';
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

/**
 * GET /api/ingest/intel/:businessId/audit
 * Purpose: Deep review audit (velocity timeline + neutral authenticity signals)
 * Auth: Per-user extension API key (zx_...) — Agency/Pro role only
 */
router.get(
  '/intel/:businessId/audit',
  asyncHandler(validateExtensionKey),
  asyncHandler(intelController.getAudit)
);

/**
 * POST /api/ingest/metrics
 * Purpose: Idempotent merge of scraped GBP performance metrics (overview,
 *          calls, chat_clicks, bookings, directions, website_clicks)
 * Auth: Per-user extension API key (zx_...) — legacy static key is rejected
 */
router.post(
  '/metrics',
  asyncHandler(validateExtensionKey),
  asyncHandler(metricsIngestController.ingestMetrics)
);

/**
 * GET /api/ingest/intel/:businessId/audit-report
 * Purpose: Server-rendered HTML audit report (same data as /audit, as a
 *          self-contained page). Neutral framing; disclaimer always prominent.
 * Auth: Per-user extension API key (zx_...) — Agency/Pro role only
 */
router.get(
  '/intel/:businessId/audit-report',
  asyncHandler(validateExtensionKey),
  asyncHandler(intelController.getAuditReport)
);

export default router;
