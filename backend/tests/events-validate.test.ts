/**
 * events-validate.test.ts — the rules for business notes, no database.
 * Run: npx ts-node tests/events-validate.test.ts → "ALL TESTS PASSED (N assertions)".
 */
import { parseEventInput, canWriteEvents } from '../src/services/events.validate';

let n = 0;
function assert(cond: boolean, msg: string) {
  n++;
  if (!cond) throw new Error('FAILED #' + n + ': ' + msg);
}
function rejects(input: unknown, msg: string) {
  let threw = false;
  try { parseEventInput(input); } catch { threw = true; }
  assert(threw, msg);
}
const good = { eventDate: '2026-07-01', title: 'Website launched', description: 'New site live', emoji: '🚀' };

// A valid note parses and keeps its values.
{
  const e = parseEventInput(good);
  assert(e.title === 'Website launched' && e.eventDate === '2026-07-01' && e.emoji === '🚀', 'a valid note parses');
  assert(parseEventInput({ ...good, description: '   ' }).description === null, 'a blank description becomes null');
  assert(parseEventInput({ ...good, description: undefined }).description === null, 'a missing description is allowed');
  assert(parseEventInput({ ...good, title: '  Opening  ' }).title === 'Opening', 'the title is trimmed');
}

// Dates must be real calendar dates.
rejects({ ...good, eventDate: '2026-02-30' }, 'a date that does not exist is rejected');
rejects({ ...good, eventDate: '01/07/2026' }, 'a non-ISO date is rejected');
rejects({ ...good, eventDate: '' }, 'an empty date is rejected');

// Title and description limits.
rejects({ ...good, title: '' }, 'an empty title is rejected');
rejects({ ...good, title: '   ' }, 'a blank title is rejected');
rejects({ ...good, title: 'x'.repeat(121) }, 'a title over 120 characters is rejected');
rejects({ ...good, description: 'x'.repeat(2001) }, 'a description over 2000 characters is rejected');
rejects({ ...good, description: 42 }, 'a non-text description is rejected');

// Emoji: any emoji, but only one.
for (const e of ['🎉', '🏖️', '👍🏽', '👨‍👩‍👧', '🇮🇳']) {
  assert(parseEventInput({ ...good, emoji: e }).emoji === e, `emoji ${e} is accepted`);
}
rejects({ ...good, emoji: 'hello' }, 'plain text is not an emoji');
rejects({ ...good, emoji: '🎉🎉' }, 'two emoji are rejected');
rejects({ ...good, emoji: '' }, 'an empty emoji is rejected');
rejects({ ...good, emoji: '<script>' }, 'markup is not an emoji');

// Who may write: agency and Pro only; owners never.
assert(canWriteEvents('AGENCY_ADMIN', 'AGENCY'), 'an agency admin on Agency can write');
assert(canWriteEvents('AGENCY_MEMBER', 'PRO'), 'an agency member on Pro can write');
assert(!canWriteEvents('AGENCY_ADMIN', 'FREE'), 'an agency on Free cannot write');
assert(!canWriteEvents('OWNER_READONLY', 'PRO'), 'an owner cannot write, even on Pro');
assert(!canWriteEvents('OWNER_READONLY', 'AGENCY'), 'an owner cannot write, even on Agency');

console.log(`ALL TESTS PASSED (${n} assertions)`);
