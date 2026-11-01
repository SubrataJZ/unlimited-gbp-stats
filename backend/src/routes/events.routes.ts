import { Router, Request, Response } from 'express';
import { asyncHandler } from '../middlewares/error.middleware';
import { validateJWTOrApiKey } from '../middlewares/auth.middleware';
import { ValidationError, AuthenticationError } from '../utils/errors';
import { resolveMembership } from '../services/intel.service';
import { getPlanForUser } from '../services/billing.service';
import { parseEventInput, canWriteEvents } from '../services/events.validate';
import {
  listEvents, createEvent, updateEvent, deleteEvent, assertCanWrite,
} from '../services/events.service';

/**
 * Business notes: a date, a title, a description and an emoji on a tracked
 * business. Everyone in the organisation can read them; only agency and Pro
 * accounts can write them (owners are read-only).
 */
const router = Router();

function requireUser(req: Request): string {
  if (!req.user) throw new AuthenticationError('Sign in to view or change notes.');
  return req.user.id;
}

// GET /api/events/businesses/:businessId?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get(
  '/businesses/:businessId',
  validateJWTOrApiKey,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = requireUser(req);
    const { orgId } = await resolveMembership(userId);
    const from = typeof req.query.from === 'string' ? req.query.from : undefined;
    const to = typeof req.query.to === 'string' ? req.query.to : undefined;
    const events = await listEvents(orgId, String(req.params.businessId), from, to);
    res.json({ events });
  })
);

// POST /api/events/businesses/:businessId
router.post(
  '/businesses/:businessId',
  validateJWTOrApiKey,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = requireUser(req);
    const { orgId, role } = await resolveMembership(userId);
    const plan = (await getPlanForUser(userId)).plan;
    assertCanWrite(canWriteEvents(role, plan));
    const input = parseEventInput(req.body);
    const event = await createEvent(orgId, String(req.params.businessId), userId, input);
    res.status(201).json({ event });
  })
);

// PATCH /api/events/:eventId
router.patch(
  '/:eventId',
  validateJWTOrApiKey,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = requireUser(req);
    const { orgId, role } = await resolveMembership(userId);
    const plan = (await getPlanForUser(userId)).plan;
    assertCanWrite(canWriteEvents(role, plan));
    const input = parseEventInput(req.body);
    const event = await updateEvent(orgId, String(req.params.eventId), input);
    res.json({ event });
  })
);

// DELETE /api/events/:eventId
router.delete(
  '/:eventId',
  validateJWTOrApiKey,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = requireUser(req);
    const { orgId, role } = await resolveMembership(userId);
    const plan = (await getPlanForUser(userId)).plan;
    assertCanWrite(canWriteEvents(role, plan));
    await deleteEvent(orgId, String(req.params.eventId));
    res.status(204).end();
  })
);

export default router;
