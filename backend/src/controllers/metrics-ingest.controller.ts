import { Request, Response } from 'express';
import { asyncHandler } from '../middlewares/error.middleware';
import { auditEvents } from '../middlewares/audit.middleware';
import { ValidationError, AuthenticationError } from '../utils/errors';
import logger from '../utils/logger';
import { resolveOrgId } from '../services/intel.service';
import {
  ingestMetricMonths,
  IncomingMetricsBusiness,
  IncomingMetricMonth,
} from '../services/metrics-intel.service';

// ── Vocabulary ──────────────────────────────────────────────────────────────

const VALID_METRIC_TYPES = new Set([
  'overview',
  'calls',
  'chat_clicks',
  'bookings',
  'directions',
  'website_clicks',
]);

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Parse a supplied ISO date string for `collectedAt`. Always returns a Date —
 * never undefined and never throws. Missing/unparseable input falls back to
 * `new Date()` (now), which is required for A2's merge-rule ordering
 * guarantee (see task spec): epoch-0 backfill rows must always lose to live
 * pushes, and live pushes must order correctly among themselves.
 */
function parseCollectedAt(value: unknown): Date {
  if (typeof value === 'string' && value.length > 0) {
    const d = new Date(value);
    if (!isNaN(d.getTime())) {
      return d;
    }
  }
  return new Date();
}

// ── Validation ─────────────────────────────────────────────────────────────────

function validateMetricMonth(
  raw: unknown,
  bizIndex: number,
  metricIndex: number
): IncomingMetricMonth {
  if (typeof raw !== 'object' || raw === null) {
    throw new ValidationError(
      `businesses[${bizIndex}].metrics[${metricIndex}] must be an object`
    );
  }

  const m = raw as Record<string, unknown>;

  // metricType — whitelist only
  if (typeof m.metricType !== 'string' || !VALID_METRIC_TYPES.has(m.metricType)) {
    throw new ValidationError(
      `businesses[${bizIndex}].metrics[${metricIndex}].metricType is invalid (got ${JSON.stringify(
        m.metricType
      )}); must be one of: ${Array.from(VALID_METRIC_TYPES).join(', ')}`
    );
  }

  // year — integer, 2000 <= year <= currentUTCYear + 1
  const maxYear = new Date().getUTCFullYear() + 1;
  if (
    typeof m.year !== 'number' ||
    !Number.isInteger(m.year) ||
    m.year < 2000 ||
    m.year > maxYear
  ) {
    throw new ValidationError(
      `businesses[${bizIndex}].metrics[${metricIndex}].year must be an integer between 2000 and ${maxYear}`
    );
  }

  // month — integer 1-12
  if (typeof m.month !== 'number' || !Number.isInteger(m.month) || m.month < 1 || m.month > 12) {
    throw new ValidationError(
      `businesses[${bizIndex}].metrics[${metricIndex}].month must be an integer between 1 and 12`
    );
  }

  // total — integer >= 0
  if (typeof m.total !== 'number' || !Number.isInteger(m.total) || m.total < 0) {
    throw new ValidationError(
      `businesses[${bizIndex}].metrics[${metricIndex}].total must be a non-negative integer`
    );
  }

  // daily — optional array of finite non-negative numbers, max length 31
  let daily: number[] | undefined;
  if (m.daily !== undefined && m.daily !== null) {
    if (!Array.isArray(m.daily)) {
      throw new ValidationError(
        `businesses[${bizIndex}].metrics[${metricIndex}].daily must be an array`
      );
    }
    if (m.daily.length > 31) {
      throw new ValidationError(
        `businesses[${bizIndex}].metrics[${metricIndex}].daily exceeds the maximum length of 31`
      );
    }
    for (let i = 0; i < m.daily.length; i++) {
      const v = m.daily[i];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        throw new ValidationError(
          `businesses[${bizIndex}].metrics[${metricIndex}].daily[${i}] must be a finite non-negative number`
        );
      }
    }
    daily = m.daily as number[];
  }

  // yoyPercent — optional finite number or explicit null
  let yoyPercent: number | null | undefined;
  if (m.yoyPercent !== undefined) {
    if (m.yoyPercent === null) {
      yoyPercent = null;
    } else if (typeof m.yoyPercent !== 'number' || !Number.isFinite(m.yoyPercent)) {
      throw new ValidationError(
        `businesses[${bizIndex}].metrics[${metricIndex}].yoyPercent must be a finite number or null`
      );
    } else {
      yoyPercent = m.yoyPercent;
    }
  }

  // breakdown — optional flat object of finite numbers
  let breakdown: Record<string, number> | undefined;
  if (m.breakdown !== undefined && m.breakdown !== null) {
    if (typeof m.breakdown !== 'object' || Array.isArray(m.breakdown)) {
      throw new ValidationError(
        `businesses[${bizIndex}].metrics[${metricIndex}].breakdown must be a flat object`
      );
    }
    const entries = Object.entries(m.breakdown as Record<string, unknown>);
    for (const [k, v] of entries) {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new ValidationError(
          `businesses[${bizIndex}].metrics[${metricIndex}].breakdown.${k} must be a finite number`
        );
      }
    }
    breakdown = m.breakdown as Record<string, number>;
  }

  // searchTerms — optional array (max 500) of { term: string, count: number }
  let searchTerms: Array<{ term: string; count: number }> | undefined;
  if (m.searchTerms !== undefined && m.searchTerms !== null) {
    if (!Array.isArray(m.searchTerms)) {
      throw new ValidationError(
        `businesses[${bizIndex}].metrics[${metricIndex}].searchTerms must be an array`
      );
    }
    if (m.searchTerms.length > 500) {
      throw new ValidationError(
        `businesses[${bizIndex}].metrics[${metricIndex}].searchTerms exceeds the maximum of 500 entries`
      );
    }
    searchTerms = m.searchTerms.map((entry, ti) => {
      if (typeof entry !== 'object' || entry === null) {
        throw new ValidationError(
          `businesses[${bizIndex}].metrics[${metricIndex}].searchTerms[${ti}] must be an object`
        );
      }
      const e = entry as Record<string, unknown>;
      if (typeof e.term !== 'string' || e.term.length === 0) {
        throw new ValidationError(
          `businesses[${bizIndex}].metrics[${metricIndex}].searchTerms[${ti}].term must be a non-empty string`
        );
      }
      if (typeof e.count !== 'number' || !Number.isFinite(e.count)) {
        throw new ValidationError(
          `businesses[${bizIndex}].metrics[${metricIndex}].searchTerms[${ti}].count must be a finite number`
        );
      }
      return { term: e.term, count: e.count };
    });
  }

  // isDerived — optional boolean, default false
  let isDerived: boolean | undefined;
  if (m.isDerived !== undefined && m.isDerived !== null) {
    if (typeof m.isDerived !== 'boolean') {
      throw new ValidationError(
        `businesses[${bizIndex}].metrics[${metricIndex}].isDerived must be a boolean`
      );
    }
    isDerived = m.isDerived;
  }

  // collectedAt — default to now() when absent/unparseable (see parseCollectedAt)
  const collectedAt = parseCollectedAt(m.collectedAt);

  return {
    metricType: m.metricType,
    year: m.year,
    month: m.month,
    total: m.total,
    daily,
    yoyPercent,
    breakdown,
    searchTerms,
    isDerived: isDerived ?? false,
    collectedAt,
  };
}

function validateMetricsBusiness(raw: unknown, index: number): IncomingMetricsBusiness {
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

  // metrics — required array, max 1000 per business
  if (!b.metrics || !Array.isArray(b.metrics)) {
    throw new ValidationError(`businesses[${index}].metrics must be an array`);
  }
  if (b.metrics.length > 1000) {
    throw new ValidationError(
      `businesses[${index}].metrics exceeds the maximum of 1000 metrics per business`
    );
  }
  const metrics: IncomingMetricMonth[] = b.metrics.map((m, mi) =>
    validateMetricMonth(m, index, mi)
  );

  return {
    name: b.name as string,
    googlePlaceId: optionalStr('googlePlaceId'),
    address: optionalStr('address'),
    searchUrl: optionalStr('searchUrl'),
    logoUrl: optionalStr('logoUrl'),
    isOwn: isOwn ?? false,
    metrics,
  };
}

// ── Controller ────────────────────────────────────────────────────────────────

/**
 * POST /api/ingest/metrics
 *
 * Receives scraped Google Business Profile performance metrics (overview,
 * calls, chat_clicks, bookings, directions, website_clicks) from the Chrome
 * extension and merges them idempotently by month. Read as a sibling of
 * `ingestIntel` in intel.controller.ts.
 *
 * Requires a per-user API key (zx_...). The legacy static key path is
 * rejected because there is no userId to associate the data with.
 *
 * @route  POST /api/ingest/metrics
 * @access Private — per-user extension key (zx_...) only
 */
export const ingestMetrics = asyncHandler(async (req: Request, res: Response) => {
  // Per-user key required; legacy static key has no req.user
  if (!req.user) {
    throw new AuthenticationError(
      'Metrics ingest requires a per-user API key (zx_...)'
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
  const validated: IncomingMetricsBusiness[] = businesses.map((b, i) =>
    validateMetricsBusiness(b, i)
  );

  logger.info(
    `Metrics ingest: ${validated.length} businesses from user ${req.user.id} (key: ${req.apiKey ?? 'unknown'})`
  );

  // Resolve (or auto-create) the org for this user
  const orgId = await resolveOrgId(req.user.id);

  // Run the idempotent merge
  const summary = await ingestMetricMonths(orgId, validated);

  // Audit trail
  await auditEvents.dataImported(req, req.user.id, validated.length, true);

  logger.info(`Metrics ingest complete for org ${orgId}:`, summary);

  res.status(200).json({ ok: true, summary });
});
