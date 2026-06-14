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
  updateReply as svcUpdateReply,
  getMonthlyUsage,
  setBusinessContext,
} from '../services/ai-reply.service';

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
