/**
 * AI Review Reply Copilot — controller layer (Module D)
 *
 * All endpoints require a valid JWT (req.user is set by validateJWT).
 * Validation is manual to match the style of intel.controller.ts.
 */

import { Request, Response } from 'express';
import { asyncHandler } from '../middlewares/error.middleware';
import { ValidationError, AuthenticationError } from '../utils/errors';
import logger from '../utils/logger';
import {
  generateReply as svcGenerateReply,
  generateRepliesBulk as svcGenerateRepliesBulk,
  listReviewsForBusiness,
  updateReply as svcUpdateReply,
  getMonthlyUsage,
  setBusinessContext,
  MAX_BULK_BATCH_SIZE,
} from '../services/ai-reply.service';
import {
  analyzeReviews as svcAnalyzeReviews,
  getConceptInsights as svcGetConceptInsights,
} from '../services/review-concepts.service';

// ─── POST /api/ai/reply ───────────────────────────────────────────────────────

/**
 * Generate an AI draft reply for a review.
 *
 * Body (either form accepted):
 *   { scrapedReviewId: string }
 *   OR
 *   { reviewText: string, rating: number (1–5), trackedBusinessId?: string }
 *
 * Response 200: { ok: true, draftText, reviewReplyId?, usage }
 */
export const generateReply = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) {
    throw new AuthenticationError('Authentication required');
  }

  const body = req.body as Record<string, unknown>;

  const scrapedReviewId =
    typeof body.scrapedReviewId === 'string' && body.scrapedReviewId.trim() !== ''
      ? body.scrapedReviewId.trim()
      : undefined;

  const reviewText =
    typeof body.reviewText === 'string' ? body.reviewText : undefined;

  const rating =
    body.rating !== undefined && body.rating !== null
      ? Number(body.rating)
      : undefined;

  const trackedBusinessId =
    typeof body.trackedBusinessId === 'string' && body.trackedBusinessId.trim() !== ''
      ? body.trackedBusinessId.trim()
      : undefined;

  const model =
    typeof body.model === 'string' && body.model.trim() !== ''
      ? body.model.trim()
      : undefined;

  // Require either scrapedReviewId OR (reviewText + rating)
  if (!scrapedReviewId && (!reviewText || rating === undefined)) {
    throw new ValidationError(
      'Provide either "scrapedReviewId" or both "reviewText" and "rating" (1–5)'
    );
  }

  if (!scrapedReviewId && rating !== undefined) {
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new ValidationError('"rating" must be an integer between 1 and 5');
    }
  }

  logger.info(
    `AI reply requested by user ${req.user.id}: ` +
      (scrapedReviewId ? `scrapedReviewId=${scrapedReviewId}` : `ad-hoc rating=${rating}`)
  );

  const result = await svcGenerateReply({
    userId: req.user.id,
    scrapedReviewId,
    reviewText,
    rating,
    trackedBusinessId,
    model,
  });

  res.status(200).json({
    ok: true,
    draftText: result.draftText,
    reviewReplyId: result.reviewReplyId ?? null,
    usage: result.usage,
  });
});

// ─── PATCH /api/ai/reply/:id ──────────────────────────────────────────────────

/**
 * Update a saved review reply (finalText and/or status).
 *
 * Body: { finalText?: string, status?: 'draft' | 'edited' | 'published' }
 *
 * Response 200: { ok: true, reply }
 */
export const updateReply = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) {
    throw new AuthenticationError('Authentication required');
  }

  const reviewReplyId = req.params.id;
  if (!reviewReplyId || reviewReplyId.trim() === '') {
    throw new ValidationError('Reply ID is required in the URL path');
  }

  const body = req.body as Record<string, unknown>;

  const finalText =
    body.finalText !== undefined
      ? body.finalText === null
        ? undefined
        : typeof body.finalText === 'string'
          ? body.finalText
          : (() => {
              throw new ValidationError('"finalText" must be a string');
            })()
      : undefined;

  const status =
    body.status !== undefined
      ? typeof body.status === 'string'
        ? body.status
        : (() => {
            throw new ValidationError('"status" must be a string');
          })()
      : undefined;

  const reply = await svcUpdateReply({
    userId: req.user.id,
    reviewReplyId: reviewReplyId.trim(),
    finalText,
    status,
  });

  res.status(200).json({ ok: true, reply });
});

// ─── GET /api/ai/usage ────────────────────────────────────────────────────────

/**
 * Return the calling user's AI usage summary for the current calendar month.
 *
 * Response 200: { ok: true, usage: { tokensIn, tokensOut, costUsd, capUsd, remainingUsd, count } }
 */
export const getUsage = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) {
    throw new AuthenticationError('Authentication required');
  }

  const usage = await getMonthlyUsage(req.user.id);

  res.status(200).json({ ok: true, usage });
});

// ─── PUT /api/ai/context ──────────────────────────────────────────────────────

/**
 * Create or update the BusinessContext for a TrackedBusiness.
 *
 * Body: { trackedBusinessId: string, tone?: string, services?: string,
 *          ownerName?: string, signature?: string }
 *
 * Response 200: { ok: true, context }
 */
export const setContext = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) {
    throw new AuthenticationError('Authentication required');
  }

  const body = req.body as Record<string, unknown>;

  if (!body.trackedBusinessId || typeof body.trackedBusinessId !== 'string' || body.trackedBusinessId.trim() === '') {
    throw new ValidationError('"trackedBusinessId" is required and must be a non-empty string');
  }

  const optionalString = (key: string): string | undefined => {
    const v = body[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'string') {
      throw new ValidationError(`"${key}" must be a string`);
    }
    return v;
  };

  const trackedBusinessId = (body.trackedBusinessId as string).trim();
  const tone = optionalString('tone');
  const services = optionalString('services');
  const ownerName = optionalString('ownerName');
  const signature = optionalString('signature');

  const context = await setBusinessContext({
    userId: req.user.id,
    trackedBusinessId,
    tone,
    services,
    ownerName,
    signature,
  });

  res.status(200).json({ ok: true, context });
});

// ─── POST /api/ai/reply/bulk ──────────────────────────────────────────────────

/**
 * Generate AI draft replies for a batch of scraped reviews in one call.
 * Powers the extension's "Auto-draft replies" assisted-mode flow — the
 * extension still inserts each draft into its own reply box and a human
 * clicks Google's native Post button; this endpoint only drafts text.
 *
 * Body: { scrapedReviewIds: string[] (1–50), trackedBusinessId: string, model?: string }
 *
 * Response 200: { ok: true, results: [...], stoppedForBudget: boolean }
 */
export const generateRepliesBulk = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) {
    throw new AuthenticationError('Authentication required');
  }

  const body = req.body as Record<string, unknown>;

  if (!Array.isArray(body.scrapedReviewIds) || body.scrapedReviewIds.length === 0) {
    throw new ValidationError('"scrapedReviewIds" must be a non-empty array');
  }

  if (body.scrapedReviewIds.length > MAX_BULK_BATCH_SIZE) {
    throw new ValidationError(
      `"scrapedReviewIds" cannot contain more than ${MAX_BULK_BATCH_SIZE} entries`
    );
  }

  const scrapedReviewIds = body.scrapedReviewIds.map((id, i) => {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new ValidationError(`"scrapedReviewIds[${i}]" must be a non-empty string`);
    }
    return id.trim();
  });

  if (
    !body.trackedBusinessId ||
    typeof body.trackedBusinessId !== 'string' ||
    body.trackedBusinessId.trim() === ''
  ) {
    throw new ValidationError('"trackedBusinessId" is required and must be a non-empty string');
  }

  const model =
    typeof body.model === 'string' && body.model.trim() !== '' ? body.model.trim() : undefined;

  logger.info(
    `AI bulk reply requested by user ${req.user.id}: business=${body.trackedBusinessId} count=${scrapedReviewIds.length}`
  );

  const result = await svcGenerateRepliesBulk({
    userId: req.user.id,
    scrapedReviewIds,
    model,
  });

  res.status(200).json({
    ok: true,
    results: result.results,
    stoppedForBudget: result.stoppedForBudget,
  });
});

// ─── GET /api/ai/reviews ──────────────────────────────────────────────────────

/**
 * List scraped reviews for a tracked business, optionally filtered to only
 * those not yet answered by the owner on Google. Read-only — available to
 * every role including Owner (read-only tier).
 *
 * Query: ?trackedBusinessId=...&onlyUnreplied=true
 *
 * Response 200: { ok: true, reviews: [...] }
 */
export const listReviews = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) {
    throw new AuthenticationError('Authentication required');
  }

  const trackedBusinessId =
    typeof req.query.trackedBusinessId === 'string' ? req.query.trackedBusinessId.trim() : '';

  if (!trackedBusinessId) {
    throw new ValidationError('"trackedBusinessId" query parameter is required');
  }

  const onlyUnreplied = req.query.onlyUnreplied === 'true' || req.query.onlyUnreplied === '1';

  const reviews = await listReviewsForBusiness({
    userId: req.user.id,
    trackedBusinessId,
    onlyUnreplied,
  });

  res.status(200).json({ ok: true, reviews });
});

// ─── Review concept analyser ──────────────────────────────────────────────────

/**
 * POST /api/ai/concepts/analyze
 *
 * Run the multilingual concept extractor over un-analysed reviews for one
 * business. Costs money, so it is an explicit user action rather than
 * something that fires on ingest, and it is gated to write-capable roles.
 *
 * Body: { trackedBusinessId: string, months?: number, limit?: number, model?: string }
 * Response 200: { ok: true, analyzed, conceptsFound, remaining, costUsd, model, stoppedForBudget }
 */
export const analyzeConcepts = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) {
    throw new AuthenticationError('Authentication required');
  }

  const body = req.body as Record<string, unknown>;
  const trackedBusinessId =
    typeof body.trackedBusinessId === 'string' ? body.trackedBusinessId.trim() : '';

  if (!trackedBusinessId) {
    throw new ValidationError('"trackedBusinessId" is required and must be a non-empty string');
  }

  const model =
    typeof body.model === 'string' && body.model.trim() !== '' ? body.model.trim() : undefined;

  logger.info(
    `Concept analysis requested by user ${req.user.id} for business=${trackedBusinessId}`
  );

  const result = await svcAnalyzeReviews({
    userId: req.user.id,
    trackedBusinessId,
    months: body.months as number | undefined,
    limit: body.limit as number | undefined,
    model,
  });

  res.status(200).json({ ok: true, ...result });
});

/**
 * GET /api/ai/concepts?trackedBusinessId=...&months=12&minMentions=2
 *
 * Read-only insight rollup over already-analysed reviews. Spends nothing, so
 * every role including the read-only Owner tier may call it.
 *
 * Response 200: { ok: true, months, windowStart, recentSince, reviewsAnalyzed,
 *                 reviewsPending, languages, concepts }
 */
export const getConcepts = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) {
    throw new AuthenticationError('Authentication required');
  }

  const trackedBusinessId =
    typeof req.query.trackedBusinessId === 'string' ? req.query.trackedBusinessId.trim() : '';

  if (!trackedBusinessId) {
    throw new ValidationError('"trackedBusinessId" query parameter is required');
  }

  const result = await svcGetConceptInsights({
    userId: req.user.id,
    trackedBusinessId,
    months: req.query.months as string | undefined,
    minMentions: req.query.minMentions as string | undefined,
  });

  res.status(200).json({ ok: true, ...result });
});
