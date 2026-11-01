import { prisma } from '../index';
import { NotFoundError, AuthorizationError } from '../utils/errors';
import { EventInput } from './events.validate';

const EVENT_SELECT = {
  id: true, trackedBusinessId: true, eventDate: true, title: true,
  description: true, emoji: true, createdAt: true, updatedAt: true,
} as const;

// The dashboard knows a business by its Google place ID; the API also accepts the
// server's own ID. Either way the result is limited to the caller's organisation.
async function resolveBusinessId(orgId: string, key: string): Promise<string> {
  const business = await prisma.trackedBusiness.findFirst({
    where: { orgId, OR: [{ id: key }, { googlePlaceId: key }] },
    select: { id: true },
  });
  if (!business) throw new NotFoundError('Tracked business not found for this organization.');
  return business.id;
}

export async function listEvents(orgId: string, businessKey: string, from?: string, to?: string) {
  const trackedBusinessId = await resolveBusinessId(orgId, businessKey);
  return prisma.businessEvent.findMany({
    where: {
      trackedBusinessId,
      ...(from || to ? { eventDate: { ...(from && { gte: new Date(`${from}T00:00:00Z`) }), ...(to && { lte: new Date(`${to}T00:00:00Z`) }) } } : {}),
    },
    orderBy: { eventDate: 'asc' },
    select: EVENT_SELECT,
  });
}

export async function createEvent(orgId: string, businessKey: string, userId: string, input: EventInput) {
  const trackedBusinessId = await resolveBusinessId(orgId, businessKey);
  return prisma.businessEvent.create({
    data: {
      trackedBusinessId,
      eventDate: new Date(`${input.eventDate}T00:00:00Z`),
      title: input.title,
      description: input.description,
      emoji: input.emoji,
      createdById: userId,
    },
    select: EVENT_SELECT,
  });
}

export async function updateEvent(orgId: string, eventId: string, input: EventInput) {
  const existing = await prisma.businessEvent.findFirst({
    where: { id: eventId, trackedBusiness: { orgId } }, select: { id: true },
  });
  if (!existing) throw new NotFoundError('Note not found for this organization.');
  return prisma.businessEvent.update({
    where: { id: eventId },
    data: {
      eventDate: new Date(`${input.eventDate}T00:00:00Z`),
      title: input.title,
      description: input.description,
      emoji: input.emoji,
    },
    select: EVENT_SELECT,
  });
}

export async function deleteEvent(orgId: string, eventId: string) {
  const existing = await prisma.businessEvent.findFirst({
    where: { id: eventId, trackedBusiness: { orgId } }, select: { id: true },
  });
  if (!existing) throw new NotFoundError('Note not found for this organization.');
  await prisma.businessEvent.delete({ where: { id: eventId } });
}

export function assertCanWrite(canWrite: boolean) {
  if (!canWrite) {
    throw new AuthorizationError('Notes are available on Agency and Pro plans only.');
  }
}
