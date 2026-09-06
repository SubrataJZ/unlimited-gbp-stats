import { Router, Request, Response } from 'express';
import { asyncHandler } from '../middlewares/error.middleware';
import { validateJWTOrApiKey } from '../middlewares/auth.middleware';
import { logAudit } from '../middlewares/audit.middleware';
import { getPlanForUser, redeemLicenseKey } from '../services/billing.service';
import { prisma } from '../index';
import logger from '../utils/logger';

/**
 * Billing / plan endpoints. Auth accepts EITHER a backend JWT OR the extension's
 * zx_ key (validateJWTOrApiKey) — the extension redeems keys straight from the
 * dashboard.
 */
const router = Router();

// GET /api/billing/status — current plan, expiry, limits, usage.
router.get(
  '/status',
  validateJWTOrApiKey,
  asyncHandler(async (req: Request, res: Response) => {
    const status = await getPlanForUser(req.user!.id);
    const trackedBusinesses = await prisma.trackedBusiness.count({ where: { orgId: status.orgId } });
    res.json({
      plan: status.plan,
      effectivePlan: status.effectivePlan,
      planExpiresAt: status.planExpiresAt,
      active: status.active,
      expired: status.expired,
      limits: status.limits,
      usage: { trackedBusinesses },
    });
  })
);

// POST /api/billing/redeem { code } — redeem a single-use license key.
router.post(
  '/redeem',
  validateJWTOrApiKey,
  asyncHandler(async (req: Request, res: Response) => {
    const result = await redeemLicenseKey(req.user!.id, (req.body || {}).code);
    await logAudit(req, {
      action: 'LICENSE_REDEEMED',
      status: 'success',
      userId: req.user!.id,
      metadata: { plan: result.plan },
    });
    logger.info(`User ${req.user!.id} redeemed a ${result.plan} key`);
    res.json({
      plan: result.plan,
      effectivePlan: result.effectivePlan,
      planExpiresAt: result.planExpiresAt,
      active: result.active,
      limits: result.limits,
      message: result.message,
    });
  })
);

export default router;
