import crypto from 'crypto';
import { Plan } from '@prisma/client';
import { prisma } from '../index';
import { resolveOrgId } from './intel.service';
import { NotFoundError, ConflictError, ValidationError } from '../utils/errors';
import logger from '../utils/logger';

/**
 * Plan model — hybrid: plans live on the Organization, activated by redeeming a
 * single-use LicenseKey (POST /api/billing/redeem). No in-app checkout yet; a
 * payment-provider webhook can later call setOrgPlan() directly.
 */

export interface PlanLimits {
  label: string;
  /** Soft cap surfaced in /api/billing/status; not hard-enforced at ingest yet. */
  trackedBusinesses: number;
  /** Monthly AI spend ceiling in USD. 0 => fall back to the env default. */
  aiMonthlyUsd: number;
}

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  FREE:   { label: 'Free',   trackedBusinesses: 1,   aiMonthlyUsd: 0 },
  PRO:    { label: 'Pro',    trackedBusinesses: 10,  aiMonthlyUsd: 10 },
  AGENCY: { label: 'Agency', trackedBusinesses: 100, aiMonthlyUsd: 50 },
};

const PLAN_RANK: Record<Plan, number> = { FREE: 0, PRO: 1, AGENCY: 2 };

/**
 * The plan actually in force right now. A paid plan whose planExpiresAt has
 * passed falls back to FREE (the stored plan is left untouched so history and
 * "renew" UX still work).
 */
export function effectivePlan(plan: Plan, planExpiresAt: Date | null, now: Date = new Date()): Plan {
  if (plan === 'FREE') return 'FREE';
  if (planExpiresAt && planExpiresAt.getTime() <= now.getTime()) return 'FREE';
  return plan;
}

export interface PlanStatus {
  plan: Plan;            // stored plan
  effectivePlan: Plan;   // what's in force now (FREE if expired)
  planExpiresAt: string | null;
  active: boolean;       // effectivePlan !== FREE, or FREE (which is always "active")
  expired: boolean;      // stored plan is paid but lapsed
  limits: PlanLimits;
}

function toStatus(plan: Plan, planExpiresAt: Date | null, now = new Date()): PlanStatus {
  const eff = effectivePlan(plan, planExpiresAt, now);
  const expired = plan !== 'FREE' && eff === 'FREE';
  return {
    plan,
    effectivePlan: eff,
    planExpiresAt: planExpiresAt ? planExpiresAt.toISOString() : null,
    active: !expired,
    expired,
    limits: PLAN_LIMITS[eff],
  };
}

/** Read the plan status for a user's organization. */
export async function getPlanForUser(userId: string): Promise<PlanStatus & { orgId: string }> {
  const orgId = await resolveOrgId(userId);
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { plan: true, planExpiresAt: true },
  });
  const status = toStatus(org?.plan ?? 'FREE', org?.planExpiresAt ?? null);
  return { orgId, ...status };
}

/**
 * The monthly AI cost cap in USD for a user, taking their plan into account.
 * A plan cap of 0 (FREE) means "use the server's env default" — this keeps the
 * existing behaviour for free users rather than cutting AI off.
 */
export async function aiMonthlyCapUsd(userId: string): Promise<number> {
  const envCap = Number(process.env.AI_MONTHLY_COST_CAP_USD) || 5;
  try {
    const { limits } = await getPlanForUser(userId);
    return limits.aiMonthlyUsd > 0 ? limits.aiMonthlyUsd : envCap;
  } catch (e) {
    logger.warn('aiMonthlyCapUsd: plan lookup failed, using env cap:', (e as Error).message);
    return envCap;
  }
}

// ── License codes ────────────────────────────────────────────────────────────

// Crockford-ish base32, no I/L/O/U to avoid confusion.
const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

function group(len: number): string {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/** e.g. ZX-PRO-K4M9-7XQP-2W6H (3 groups of 4). */
export function generateLicenseCode(plan: Plan): string {
  return `ZX-${plan}-${group(4)}-${group(4)}-${group(4)}`;
}

export function normalizeCode(raw: unknown): string {
  return String(raw ?? '').trim().toUpperCase().replace(/\s+/g, '');
}

// ── Redeem ───────────────────────────────────────────────────────────────────

/**
 * How long the plan runs after redeeming `key`, given the org's current state.
 * Redeeming the same (or higher) plan while still active extends from the
 * current expiry; anything else starts from now.
 */
export function computeNewExpiry(
  currentPlan: Plan,
  currentExpiry: Date | null,
  keyPlan: Plan,
  durationDays: number,
  now: Date = new Date()
): Date {
  const add = durationDays * 24 * 60 * 60 * 1000;
  const stillActive = currentExpiry != null && currentExpiry.getTime() > now.getTime();
  const canStack = stillActive && PLAN_RANK[keyPlan] >= PLAN_RANK[currentPlan] && currentPlan !== 'FREE';
  const base = canStack ? currentExpiry!.getTime() : now.getTime();
  return new Date(base + add);
}

export interface RedeemResult extends PlanStatus {
  redeemedCode: string;
  message: string;
}

export async function redeemLicenseKey(userId: string, rawCode: unknown): Promise<RedeemResult> {
  const code = normalizeCode(rawCode);
  if (!/^ZX-(FREE|PRO|AGENCY)-[A-Z0-9-]{6,}$/.test(code)) {
    throw new ValidationError('That does not look like a license key.');
  }

  const orgId = await resolveOrgId(userId);

  const result = await prisma.$transaction(async (tx) => {
    const key = await tx.licenseKey.findUnique({ where: { code } });
    if (!key) throw new NotFoundError('Invalid license key.');
    if (key.revokedAt) throw new ConflictError('This key has been revoked.');
    if (key.redeemedByOrgId) {
      throw new ConflictError(
        key.redeemedByOrgId === orgId
          ? 'You have already redeemed this key.'
          : 'This key has already been redeemed.'
      );
    }

    const org = await tx.organization.findUnique({
      where: { id: orgId },
      select: { plan: true, planExpiresAt: true },
    });
    const now = new Date();
    const newExpiry = computeNewExpiry(
      org?.plan ?? 'FREE',
      org?.planExpiresAt ?? null,
      key.plan,
      key.durationDays,
      now
    );

    await tx.licenseKey.update({
      where: { id: key.id },
      data: { redeemedByOrgId: orgId, redeemedAt: now },
    });
    await tx.organization.update({
      where: { id: orgId },
      data: { plan: key.plan, planExpiresAt: newExpiry },
    });

    return { plan: key.plan, planExpiresAt: newExpiry, code };
  });

  logger.info(`Org ${orgId} redeemed ${result.code} → ${result.plan} until ${result.planExpiresAt.toISOString()}`);

  const status = toStatus(result.plan, result.planExpiresAt);
  return {
    ...status,
    redeemedCode: result.code,
    message: `${PLAN_LIMITS[result.plan].label} plan active until ${result.planExpiresAt.toISOString().slice(0, 10)}.`,
  };
}

/** Direct plan setter for a future payment-webhook path (not exposed over HTTP). */
export async function setOrgPlan(orgId: string, plan: Plan, planExpiresAt: Date | null): Promise<void> {
  await prisma.organization.update({ where: { id: orgId }, data: { plan, planExpiresAt } });
}

// ── Mint (admin CLI only) ────────────────────────────────────────────────────

export async function mintLicenseKeys(opts: {
  plan: Plan;
  count: number;
  durationDays?: number;
  note?: string;
}): Promise<string[]> {
  const count = Math.max(1, Math.min(1000, Math.floor(opts.count)));
  const durationDays = opts.durationDays && opts.durationDays > 0 ? Math.floor(opts.durationDays) : 365;

  const codes: string[] = [];
  while (codes.length < count) {
    const code = generateLicenseCode(opts.plan);
    if (!codes.includes(code)) codes.push(code);
  }

  await prisma.licenseKey.createMany({
    data: codes.map((code) => ({ code, plan: opts.plan, durationDays, note: opts.note ?? null })),
    skipDuplicates: true,
  });

  return codes;
}
