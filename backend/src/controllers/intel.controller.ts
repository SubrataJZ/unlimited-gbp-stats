import { Request, Response } from 'express';
import { asyncHandler } from '../middlewares/error.middleware';
import { auditEvents } from '../middlewares/audit.middleware';
import { ValidationError, AuthenticationError } from '../utils/errors';
import logger from '../utils/logger';
import { resolveOrgId, resolveMembership, ingestIntel as runIngestIntel, getIntelForOrg, getSyncBundleForOrg, IncomingBusiness, IncomingSnapshot, IncomingReview } from '../services/intel.service';
import { getAuditForBusiness } from '../services/audit.service';
import { renderAuditReportHtml } from '../services/audit.report';
import { prisma } from '../index';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Parse an ISO date string to a UTC-midnight Date. Returns today (UTC) when absent. */
function parseDateUTCMidnight(value: unknown): Date {
  if (typeof value === 'string' && value.length > 0) {
    const d = new Date(value);
    if (isNaN(d.getTime())) {
      return todayUTC();
    }
    // Force to UTC midnight
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }
  return todayUTC();
}

function todayUTC(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Parse the optional `?since=` query param. Accepts an ISO-8601 date string
 * or an epoch-milliseconds integer (as a string, per the query-string
 * contract). Returns undefined when absent. Throws ValidationError when
 * present but unparseable.
 */
function parseSince(value: unknown): Date | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new ValidationError('"since" must be a string (ISO-8601 date or epoch milliseconds)');
  }

  // Epoch milliseconds — an integer string
  if (/^\d+$/.test(value)) {
    const ms = Number(value);
    const d = new Date(ms);
    if (isNaN(d.getTime())) {
      throw new ValidationError('"since" is not a valid epoch-milliseconds timestamp');
    }
    return d;
  }

  const d = new Date(value);
  if (isNaN(d.getTime())) {
    throw new ValidationError('"since" is not a valid ISO-8601 date string');
  }
  return d;
}

// ── Validation ─────────────────────────────────────────────────────────────────

function validateSnapshot(raw: unknown, bizIndex: number): IncomingSnapshot {
  if (typeof raw !== 'object' || raw === null) {
    throw new ValidationError(`businesses[${bizIndex}].snapshot must be an object`);
  }

  const s = raw as Record<string, unknown>;

  if (typeof s.totalReviews !== 'number' || s.totalReviews < 0) {
    throw new ValidationError(
      `businesses[${bizIndex}].snapshot.totalReviews is required and must be a non-negative number`
    );
  }

  const optionalNumber = (key: string): number | undefined => {
    const v = s[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'number') {
      throw new ValidationError(
        `businesses[${bizIndex}].snapshot.${key} must be a number`
      );
    }
    return v;
  };

  return {
    totalReviews: s.totalReviews as number,
    displayRating: optionalNumber('displayRating'),
    trueAverage: optionalNumber('trueAverage'),
    reviewsWithPhotos: optionalNumber('reviewsWithPhotos'),
    localGuideReviews: optionalNumber('localGuideReviews'),
    avgReviewerContribution: optionalNumber('avgReviewerContribution'),
    capturedOn: parseDateUTCMidnight(s.capturedOn),
  };
}

function validateReview(raw: unknown, bizIndex: number, revIndex: number): IncomingReview {
  if (typeof raw !== 'object' || raw === null) {
    throw new ValidationError(
      `businesses[${bizIndex}].reviews[${revIndex}] must be an object`
    );
  }

  const r = raw as Record<string, unknown>;

  if (!r.externalReviewId || typeof r.externalReviewId !== 'string') {
    throw new ValidationError(
      `businesses[${bizIndex}].reviews[${revIndex}].externalReviewId is required and must be a non-empty string`
    );
  }

  if (
    typeof r.rating !== 'number' ||
    !Number.isInteger(r.rating) ||
    r.rating < 1 ||
    r.rating > 5
  ) {
    throw new ValidationError(
      `businesses[${bizIndex}].reviews[${revIndex}].rating must be an integer between 1 and 5`
    );
  }

  // text — untrusted, only store (truncated). Never interpret.
  let text: string | undefined;
  if (r.text !== undefined && r.text !== null) {
    if (typeof r.text !== 'string') {
      throw new ValidationError(
        `businesses[${bizIndex}].reviews[${revIndex}].text must be a string`
      );
    }
    text = r.text.slice(0, 5000);
  }

  // reviewedAt — optional ISO date string
  let reviewedAt: Date | undefined;
  if (r.reviewedAt !== undefined && r.reviewedAt !== null) {
    if (typeof r.reviewedAt !== 'string') {
      throw new ValidationError(
        `businesses[${bizIndex}].reviews[${revIndex}].reviewedAt must be a date string`
      );
    }
    const d = new Date(r.reviewedAt);
    if (isNaN(d.getTime())) {
      throw new ValidationError(
        `businesses[${bizIndex}].reviews[${revIndex}].reviewedAt is not a valid date`
      );
    }
    reviewedAt = d;
  }

  const optionalString = (key: string): string | undefined => {
    const v = r[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'string') {
      throw new ValidationError(
        `businesses[${bizIndex}].reviews[${revIndex}].${key} must be a string`
      );
    }
    return v;
  };

  const optionalInt = (key: string): number | undefined => {
    const v = r[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'number' || !Number.isInteger(v)) {
      throw new ValidationError(
        `businesses[${bizIndex}].reviews[${revIndex}].${key} must be an integer`
      );
    }
    return v;
  };

  const optionalBool = (key: string): boolean | undefined => {
    const v = r[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'boolean') {
      throw new ValidationError(
        `businesses[${bizIndex}].reviews[${revIndex}].${key} must be a boolean`
      );
    }
    return v;
  };

  return {
    externalReviewId: r.externalReviewId as string,
    rating: r.rating as number,
    text,
    reviewedAt,
    authorName: optionalString('authorName'),
    authorId: optionalString('authorId'),
    authorReviewCount: optionalInt('authorReviewCount'),
    isLocalGuide: optionalBool('isLocalGuide'),
    hasPhoto: optionalBool('hasPhoto'),
    ownerResponded: optionalBool('ownerResponded'),
  };
}

function validateBusiness(raw: unknown, index: number): IncomingBusiness {
  if (typeof raw !== 'object' || raw === null) {
    throw new ValidationError(`businesses[${index}] must be an object`);
  }

  const b = raw as Record<string, unknown>;

  // name — required non-empty string
  if (!b.name || typeof b.name !== 'string') {
    throw new ValidationError(
      `businesses[${index}].name is required and must be a non-empty string`
    );
  }

  const optionalStr = (key: string): string | undefined => {
    const v = b[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'string') {
      throw new ValidationError(`businesses[${index}].${key} must be a string`);
    }
    return v;
  };

  // isOwn — optional boolean, default false
  let isOwn: boolean | undefined;
  if (b.isOwn !== undefined && b.isOwn !== null) {
    if (typeof b.isOwn !== 'boolean') {
      throw new ValidationError(`businesses[${index}].isOwn must be a boolean`);
    }
    isOwn = b.isOwn;
  }

  // snapshot — optional object
  let snapshot: IncomingSnapshot | undefined;
  if (b.snapshot !== undefined && b.snapshot !== null) {
    snapshot = validateSnapshot(b.snapshot, index);
  }

  // reviews — optional array, max 1000 per business
  let reviews: IncomingReview[] | undefined;
  if (b.reviews !== undefined && b.reviews !== null) {
    if (!Array.isArray(b.reviews)) {
      throw new ValidationError(`businesses[${index}].reviews must be an array`);
    }
    if (b.reviews.length > 1000) {
      throw new ValidationError(
        `businesses[${index}].reviews exceeds the maximum of 1000 reviews per business`
      );
    }
    reviews = b.reviews.map((rev, ri) => validateReview(rev, index, ri));
  }

  return {
    name: b.name as string,
    googlePlaceId: optionalStr('googlePlaceId'),
    address: optionalStr('address'),
    searchUrl: optionalStr('searchUrl'),
    logoUrl: optionalStr('logoUrl'),
    isOwn: isOwn ?? false,
    snapshot,
    reviews,
  };
}

// ── Controller ────────────────────────────────────────────────────────────────

/**
 * POST /api/ingest/intel
 *
 * Receives scraped Google Business Profile intelligence (competitor + own
 * profiles) from the Chrome extension and stores it idempotently.
 *
 * Powers:
 *   Module A — Leaderboard (TrackedBusiness + ProfileSnapshot comparisons)
 *   Module B — Deep audit  (ProfileSnapshot history)
 *   Module C — Velocity    (ProfileSnapshot time-series)
 *   Module D — Review inbox (ScrapedReview)
 *
 * Requires a per-user API key (zx_...). The legacy static key path is rejected
 * because there is no userId to associate the data with.
 *
 * @route  POST /api/ingest/intel
 * @access Private — per-user extension key (zx_...) only
 */
export const ingestIntel = asyncHandler(async (req: Request, res: Response) => {
  // Per-user key required; legacy static key has no req.user
  if (!req.user) {
    throw new AuthenticationError(
      'Profile-intel ingest requires a per-user API key (zx_...)'
    );
  }

  const { businesses } = req.body;

  // Top-level validation
  if (!businesses || !Array.isArray(businesses)) {
    throw new ValidationError('Request body must contain a "businesses" array');
  }

  if (businesses.length === 0) {
    throw new ValidationError('"businesses" array cannot be empty');
  }

  if (businesses.length > 200) {
    throw new ValidationError(
      `Too many businesses in a single request (got ${businesses.length}, max 200). Please batch your requests.`
    );
  }

  // Validate each business — fail fast on the first invalid entry
  const validated: IncomingBusiness[] = businesses.map((b, i) =>
    validateBusiness(b, i)
  );

  logger.info(
    `Intel ingest: ${validated.length} businesses from user ${req.user.id} (key: ${req.apiKey ?? 'unknown'})`
  );

  // Resolve (or auto-create) the org for this user
  const orgId = await resolveOrgId(req.user.id);

  // Run the idempotent sync
  const summary = await runIngestIntel(orgId, validated);

  // Audit trail
  await auditEvents.dataImported(req, req.user.id, validated.length, true);

  logger.info(`Intel ingest complete for org ${orgId}:`, summary);

  res.status(200).json({ ok: true, summary });
});

/**
 * GET /api/ingest/intel
 *
 * Returns the authenticated user's tracked businesses with their review
 * snapshot timelines and recent reviews. Powers the extension dashboard's
 * Reviews view. Requires a per-user API key (zx_...).
 *
 * @route  GET /api/ingest/intel
 * @access Private — per-user extension key (zx_...) only
 */
export const getIntel = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) {
    throw new AuthenticationError(
      'Profile-intel read requires a per-user API key (zx_...)'
    );
  }

  const orgId = await resolveOrgId(req.user.id);
  const businesses = await getIntelForOrg(orgId);

  res.status(200).json({ ok: true, businesses });
});

/**
 * GET /api/ingest/sync
 *
 * Returns the authenticated user's tracked businesses with FULL metrics
 * history plus review snapshots/reviews in a single response — the combined
 * read the dashboard needs so performance and reviews never fall out of
 * sync with each other. Optional `?since=` (ISO-8601 or epoch-ms) limits
 * each child collection to rows touched at or after that time; businesses
 * are always included (even with empty arrays) so the client learns about
 * new ones. Requires a per-user API key (zx_...).
 *
 * @route  GET /api/ingest/sync
 * @access Private — per-user extension key (zx_...) only
 */
export const getSyncBundle = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) {
    throw new AuthenticationError(
      'Sync bundle read requires a per-user API key (zx_...)'
    );
  }

  const since = parseSince(req.query.since);

  // Stamp the cursor BEFORE reading, not after. A row committed while these
  // queries are running would otherwise fall in the gap: it is absent from
  // this response, yet older than a syncedAt taken afterwards, so the next
  // incremental sync would skip it forever. Stamping first can only cause a
  // harmless re-fetch, and every client-side merge is idempotent.
  const syncedAt = new Date().toISOString();

  const orgId = await resolveOrgId(req.user.id);
  const businesses = await getSyncBundleForOrg(orgId, since);

  res.status(200).json({ ok: true, businesses, syncedAt });
});

/**
 * GET /api/ingest/intel/:businessId/audit
 *
 * Computes the deep review audit (velocity timeline + neutral authenticity
 * signals + keyword frequencies) for one tracked business. Agency/Pro only —
 * read-only Owner members are rejected by the service-layer tier gate.
 *
 * @route  GET /api/ingest/intel/:businessId/audit
 * @access Private — per-user extension key (zx_...), Agency/Pro role
 */
export const getAudit = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) {
    throw new AuthenticationError(
      'Profile-intel read requires a per-user API key (zx_...)'
    );
  }

  const businessId = req.params.businessId;
  if (!businessId || typeof businessId !== 'string') {
    throw new ValidationError('A businessId path parameter is required');
  }

  const { orgId, role } = await resolveMembership(req.user.id);
  const audit = await getAuditForBusiness(orgId, businessId, role);

  res.status(200).json({ ok: true, audit });
});

/**
 * GET /api/ingest/intel/:businessId/audit-report
 *
 * Renders the deep review audit as a self-contained HTML page.  Agency/Pro
 * only — the tier gate is enforced by getAuditForBusiness (same as getAudit).
 * Neutral framing: every signal is labelled as an internal aggregate; the
 * disclaimer from AuditResult is always rendered prominently.
 *
 * @route  GET /api/ingest/intel/:businessId/audit-report
 * @access Private — per-user extension key (zx_...), Agency/Pro role
 */
export const getAuditReport = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) {
    throw new AuthenticationError(
      'Profile-intel read requires a per-user API key (zx_...)'
    );
  }

  const businessId = req.params.businessId;
  if (!businessId || typeof businessId !== 'string') {
    throw new ValidationError('A businessId path parameter is required');
  }

  const { orgId, role } = await resolveMembership(req.user.id);

  // Tier gate + org-scoping enforced inside getAuditForBusiness.
  const audit = await getAuditForBusiness(orgId, businessId, role);

  // Fetch the business name for the report title.  We query AFTER the audit
  // call so the tier/ownership checks run first; the business row is always
  // present at this point (getAuditForBusiness would have thrown NotFoundError).
  const business = await prisma.trackedBusiness.findFirst({
    where: { id: businessId, orgId },
    select: { name: true },
  });
  const businessName = business?.name ?? 'Business';

  const html = renderAuditReportHtml(businessName, audit);

  res.status(200).set('Content-Type', 'text/html; charset=utf-8').send(html);
});
