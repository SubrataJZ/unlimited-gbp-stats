import { ValidationError } from '../utils/errors';

export interface EventInput {
  eventDate: string;     // YYYY-MM-DD
  title: string;
  description: string | null;
  emoji: string;
}

// One emoji: a pictograph (optionally with skin tone, variation selector or
// zero-width-joined parts), or a flag made of two regional indicators.
const EMOJI = /^(\p{Extended_Pictographic}(️|\p{Emoji_Modifier}|‍\p{Extended_Pictographic})*|\p{Regional_Indicator}{2})$/u;

/** Validate a note from the request body. Throws ValidationError on bad input. */
export function parseEventInput(raw: unknown): EventInput {
  const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  const eventDate = typeof b.eventDate === 'string' ? b.eventDate : '';
  const d = new Date(`${eventDate}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== eventDate) {
    throw new ValidationError('eventDate must be a real date in YYYY-MM-DD form');
  }

  const title = typeof b.title === 'string' ? b.title.trim() : '';
  if (title.length < 1 || title.length > 120) {
    throw new ValidationError('title is required and must be at most 120 characters');
  }

  let description: string | null = null;
  if (b.description !== undefined && b.description !== null) {
    if (typeof b.description !== 'string') throw new ValidationError('description must be text');
    description = b.description.trim() || null;
    if (description && description.length > 2000) {
      throw new ValidationError('description must be at most 2000 characters');
    }
  }

  const emoji = typeof b.emoji === 'string' ? b.emoji.trim() : '';
  if (!EMOJI.test(emoji)) throw new ValidationError('emoji must be a single emoji');

  return { eventDate, title, description, emoji };
}

/** Only agency and Pro accounts may write notes; owners are read-only. */
export function canWriteEvents(role: string, plan: string): boolean {
  return role !== 'OWNER_READONLY' && (plan === 'PRO' || plan === 'AGENCY');
}
