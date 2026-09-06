/**
 * import-sqlite-users.test.ts — plain ts-node assertions for the SQLite -> Postgres
 * user migration planner, same style as backfill-sqlite-metrics.test.ts:
 * assert(), run directly, print "ALL TESTS PASSED".
 *
 * Run:  npx ts-node tests/import-sqlite-users.test.ts   (from backend/)
 *
 * No database. The planner is pure; runUserImport is exercised against a fake
 * PrismaLike in dry-run mode (services.resolveOrgId is never called there).
 */
'use strict';

import {
  planUserMigration,
  dedupeByEmail,
  normalizeEmail,
  runUserImport,
  SqliteUser,
  PgUserLite,
  PrismaLike,
} from '../scripts/import-sqlite-users';

let n = 0;
function assert(cond: unknown, msg: string): void {
  n++;
  if (!cond) throw new Error(`FAILED #${n}: ${msg}`);
}
function eq(a: unknown, b: unknown, msg: string): void {
  assert(a === b, `${msg} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`);
}

function sqUser(o: Partial<SqliteUser>): SqliteUser {
  return {
    id: 1,
    email: 'a@example.com',
    password: '',
    name: '',
    google_id: null,
    created_at: 1_600_000_000_000,
    last_login: 0,
    ...o,
  };
}
function pgUser(o: Partial<PgUserLite>): PgUserLite {
  return {
    id: 'pg1',
    email: 'a@example.com',
    googleId: null,
    passwordHash: null,
    emailVerifiedAt: null,
    lastLoginAt: null,
    createdAt: new Date(1_600_000_000_000),
    name: null,
    ...o,
  };
}
const idx = (users: PgUserLite[]) => {
  const byEmail = new Map<string, PgUserLite>();
  const byGid = new Map<string, PgUserLite>();
  for (const u of users) {
    byEmail.set(normalizeEmail(u.email), u);
    if (u.googleId) byGid.set(u.googleId, u);
  }
  return { byEmail, byGid };
};

async function run(): Promise<void> {

// 1. Brand-new password account → create, unverified.
{
  const p = planUserMigration([sqUser({ email: 'New@Example.com ', password: '$2a$10$hash', name: ' Jane ' })],
    new Map(), new Map());
  eq(p.length, 1, '1 entry');
  eq(p[0].kind, 'create', 'create');
  if (p[0].kind === 'create') {
    eq(p[0].data.email, 'new@example.com', 'email normalized');
    eq(p[0].data.name, 'Jane', 'name trimmed');
    eq(p[0].data.passwordHash, '$2a$10$hash', 'hash carried verbatim');
    eq(p[0].data.googleId, null, 'no googleId');
    eq(p[0].data.emailVerifiedAt, null, 'password-only account is NOT auto-verified');
  }
}

// 2. Brand-new Google account → create, verified, no password.
{
  const p = planUserMigration([sqUser({ google_id: 'g-123', password: '' })], new Map(), new Map());
  eq(p[0].kind, 'create', 'create');
  if (p[0].kind === 'create') {
    eq(p[0].data.passwordHash, null, 'no password');
    eq(p[0].data.googleId, 'g-123', 'googleId set');
    assert(p[0].data.emailVerifiedAt instanceof Date, 'Google account is verified');
  }
}

// 3. Existing Postgres (Google-only) account + SQLite has a password → attach it.
{
  const existing = pgUser({ googleId: 'g-1', passwordHash: null, emailVerifiedAt: new Date() });
  const { byEmail, byGid } = idx([existing]);
  const p = planUserMigration([sqUser({ password: '$2b$12$x', google_id: 'g-1' })], byEmail, byGid);
  eq(p[0].kind, 'update', 'update');
  if (p[0].kind === 'update') {
    eq(p[0].data.passwordHash, '$2b$12$x', 'password attached');
    assert(!('googleId' in p[0].data), 'googleId already present — not rewritten');
    assert(p[0].reasons.includes('attach password'), 'reason recorded');
  }
}

// 4. Existing password account, SQLite adds Google identity → link googleId + verify.
{
  const existing = pgUser({ passwordHash: '$2b$12$x', googleId: null, emailVerifiedAt: null });
  const { byEmail, byGid } = idx([existing]);
  const p = planUserMigration([sqUser({ google_id: 'g-9', password: '$2b$12$x', last_login: 1_700_000_000_000 })], byEmail, byGid);
  eq(p[0].kind, 'update', 'update');
  if (p[0].kind === 'update') {
    eq(p[0].data.googleId, 'g-9', 'googleId linked');
    assert(p[0].data.emailVerifiedAt instanceof Date, 'now verified');
    assert(p[0].data.lastLoginAt instanceof Date, 'newer lastLoginAt taken');
    assert(!('passwordHash' in p[0].data), 'existing password left alone');
  }
}

// 5. Fully-migrated account → noop.
{
  const existing = pgUser({ passwordHash: '$2b$12$x', googleId: 'g-1', emailVerifiedAt: new Date(1_600_000_000_000), name: 'Jane', lastLoginAt: new Date(2_000_000_000_000) });
  const { byEmail, byGid } = idx([existing]);
  const p = planUserMigration([sqUser({ password: '$2b$12$x', google_id: 'g-1', name: 'Jane', last_login: 1_000 })], byEmail, byGid);
  eq(p[0].kind, 'noop', 'nothing to do');
}

// 6. Same email, different googleId → conflict, skipped.
{
  const existing = pgUser({ googleId: 'g-AAA' });
  const { byEmail, byGid } = idx([existing]);
  const p = planUserMigration([sqUser({ google_id: 'g-BBB' })], byEmail, byGid);
  eq(p[0].kind, 'conflict', 'conflict');
}

// 7. SQLite googleId already on a DIFFERENT Postgres user (email changed) → conflict.
{
  const other = pgUser({ id: 'pgOther', email: 'other@example.com', googleId: 'g-7' });
  const { byEmail, byGid } = idx([other]);
  const p = planUserMigration([sqUser({ email: 'a@example.com', google_id: 'g-7' })], byEmail, byGid);
  eq(p[0].kind, 'conflict', 'conflict — googleId owned by another PG user');
}

// 8. createdAt: keep the earliest.
{
  const existing = pgUser({ createdAt: new Date(1_600_000_000_000) });
  const { byEmail, byGid } = idx([existing]);
  const older = planUserMigration([sqUser({ created_at: 1_500_000_000_000, password: '$2b$1' })], byEmail, byGid);
  eq(older[0].kind, 'update', 'update when sqlite older');
  if (older[0].kind === 'update') assert(older[0].data.createdAt instanceof Date, 'earlier createdAt taken');

  const newer = planUserMigration([sqUser({ created_at: 1_900_000_000_000 })], byEmail, byGid);
  eq(newer[0].kind, 'noop', 'no change when sqlite newer & nothing else to add');
}

// 9. dedupeByEmail: case-folded dupes collapse, password/active row wins.
{
  const rows = [
    sqUser({ id: 1, email: 'x@e.com', password: '', last_login: 5 }),
    sqUser({ id: 2, email: 'X@E.com', password: '$2b$hash', last_login: 1 }),
  ];
  const d = dedupeByEmail(rows);
  eq(d.length, 1, 'collapsed to one');
  eq(d[0].id, 2, 'the row with a password wins');
}

// 10. runUserImport dry-run against a fake Prisma: counts, no writes.
{
  const fakePrisma: PrismaLike = {
    user: {
      findMany: async () => [pgUser({ id: 'pgE', email: 'exists@e.com', passwordHash: null })],
      create: async () => { throw new Error('must not create in dry run'); },
      update: async () => { throw new Error('must not update in dry run'); },
    },
  };
  const out = await runUserImport(
    { users: [
      sqUser({ id: 10, email: 'fresh@e.com', password: '$2b$new' }),
      sqUser({ id: 11, email: 'exists@e.com', password: '$2b$add' }),
    ] },
    { prisma: fakePrisma, services: { resolveOrgId: async () => { throw new Error('no'); } }, apply: false }
  );
  eq(out.created, 1, 'one create planned');
  eq(out.updated, 1, 'one update planned');
  eq(out.conflicts, 0, 'no conflicts');
}

  console.log(`ALL TESTS PASSED (${n} assertions)`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
