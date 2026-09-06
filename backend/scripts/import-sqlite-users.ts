/**
 * import-sqlite-users.ts — one-off SQLite -> Postgres USER migration.
 *
 * Consumes the JSON produced by
 * unlimited-gbp-stats/server/scripts/export-users.js and folds every legacy
 * SQLite account into the Postgres `users` table, so identity lives in one
 * place. bcrypt hashes carry across unchanged (bcryptjs $2a$/$2b$ verifies
 * under the backend's `bcrypt`), so existing passwords keep working.
 *
 * Matching is by EMAIL (normalized lower/trim). For a collision:
 *   - Postgres account has no password, SQLite one does  -> attach the hash
 *   - Postgres account has no googleId, SQLite one does   -> link it
 *   - keep the earliest createdAt, the latest lastLoginAt
 *   - a genuine identity clash (same email, different googleId; or the SQLite
 *     googleId already belongs to a different Postgres user) is reported and
 *     SKIPPED for a human to resolve — never guessed.
 *
 * SAFETY: dry run by default (writes nothing, prints the plan). `--apply`
 * performs writes and must be run by a human.
 *
 * Usage (inside the gbp_backend container):
 *   npx ts-node scripts/import-sqlite-users.ts --input <users.json> [--apply]
 */

import fs from 'fs';
import path from 'path';

// ── Raw shapes (verbatim from export-users.js) ────────────────────────────────

export interface SqliteUser {
  id: number;
  email: string;
  password: string; // bcrypt hash, or '' for a Google-only account
  name: string;
  google_id: string | null;
  created_at: number; // epoch ms
  last_login: number; // epoch ms, 0 = never
}

export interface ExportFile {
  exportedAt?: string;
  users: SqliteUser[];
}

// ── Postgres side ────────────────────────────────────────────────────────────

export interface PgUserLite {
  id: string;
  email: string;
  googleId: string | null;
  passwordHash: string | null;
  emailVerifiedAt: Date | null;
  lastLoginAt: Date | null;
  createdAt: Date;
  name: string | null;
}

export interface UserCreateData {
  email: string;
  name: string | null;
  passwordHash: string | null;
  googleId: string | null;
  emailVerifiedAt: Date | null;
  lastLoginAt: Date | null;
  createdAt: Date;
}

export interface UserUpdateData {
  passwordHash?: string;
  googleId?: string;
  emailVerifiedAt?: Date;
  lastLoginAt?: Date;
  createdAt?: Date;
  name?: string;
}

export type PlanEntry =
  | { kind: 'create'; sqliteId: number; email: string; data: UserCreateData }
  | { kind: 'update'; sqliteId: number; email: string; pgUserId: string; data: UserUpdateData; reasons: string[] }
  | { kind: 'noop'; sqliteId: number; email: string; reason: string }
  | { kind: 'conflict'; sqliteId: number; email: string; reason: string };

// ── Pure helpers ─────────────────────────────────────────────────────────────

export function normalizeEmail(email: string): string {
  return String(email || '').trim().toLowerCase();
}

function cleanStr(v: string | null | undefined): string | null {
  const s = String(v ?? '').trim();
  return s || null;
}

function msToDate(ms: number): Date | null {
  return Number.isFinite(ms) && ms > 0 ? new Date(ms) : null;
}

/**
 * Collapse SQLite rows that normalize to the same email (shouldn't happen — the
 * column is UNIQUE and the server lowercases on insert — but be defensive).
 * Prefer the row that carries a password, then the more-recently-active one.
 */
export function dedupeByEmail(users: SqliteUser[]): SqliteUser[] {
  const byEmail = new Map<string, SqliteUser>();
  for (const u of users) {
    const email = normalizeEmail(u.email);
    if (!email) continue;
    const prev = byEmail.get(email);
    if (!prev) {
      byEmail.set(email, u);
      continue;
    }
    const better =
      (!!u.password && !prev.password) ||
      (!!u.password === !!prev.password && (u.last_login || 0) > (prev.last_login || 0));
    if (better) byEmail.set(email, u);
  }
  return [...byEmail.values()];
}

/**
 * Compute the migration plan without touching any database.
 *
 * @param sqliteUsers   rows from the export (will be deduped by email)
 * @param pgByEmail      current Postgres users keyed by normalized email
 * @param pgByGoogleId   current Postgres users keyed by googleId
 */
export function planUserMigration(
  sqliteUsers: SqliteUser[],
  pgByEmail: Map<string, PgUserLite>,
  pgByGoogleId: Map<string, PgUserLite>
): PlanEntry[] {
  const plan: PlanEntry[] = [];

  for (const u of dedupeByEmail(sqliteUsers)) {
    const email = normalizeEmail(u.email);
    const gid = cleanStr(u.google_id);
    const name = cleanStr(u.name);
    const passwordHash = u.password && u.password.trim() ? u.password.trim() : null;
    const createdAt = msToDate(u.created_at) || new Date();
    const lastLoginAt = msToDate(u.last_login);

    const pg = pgByEmail.get(email);
    const gidHolder = gid ? pgByGoogleId.get(gid) : undefined;

    // ── New account ──
    if (!pg) {
      if (gidHolder && normalizeEmail(gidHolder.email) !== email) {
        plan.push({
          kind: 'conflict',
          sqliteId: u.id,
          email,
          reason: `google_id ${gid} already belongs to Postgres user <${gidHolder.email}> — email changed on Google? resolve manually`,
        });
        continue;
      }
      plan.push({
        kind: 'create',
        sqliteId: u.id,
        email,
        data: {
          email,
          name,
          passwordHash,
          googleId: gid,
          // Google verified the address at sign-in; a password-only SQLite
          // account was never verified.
          emailVerifiedAt: gid ? createdAt : null,
          lastLoginAt,
          createdAt,
        },
      });
      continue;
    }

    // ── Existing account: link / backfill fields ──
    if (gid && pg.googleId && pg.googleId !== gid) {
      plan.push({
        kind: 'conflict',
        sqliteId: u.id,
        email,
        reason: `email matches Postgres user ${pg.id} but its googleId (${pg.googleId}) differs from SQLite's (${gid})`,
      });
      continue;
    }
    if (gid && !pg.googleId && gidHolder && gidHolder.id !== pg.id) {
      plan.push({
        kind: 'conflict',
        sqliteId: u.id,
        email,
        reason: `would link googleId ${gid} to ${pg.id}, but it is already on ${gidHolder.id}`,
      });
      continue;
    }

    const data: UserUpdateData = {};
    const reasons: string[] = [];

    if (!pg.passwordHash && passwordHash) {
      data.passwordHash = passwordHash;
      reasons.push('attach password');
    }
    if (!pg.googleId && gid) {
      data.googleId = gid;
      reasons.push('link googleId');
    }
    if (!pg.emailVerifiedAt && gid) {
      data.emailVerifiedAt = createdAt;
      reasons.push('mark verified (Google)');
    }
    if (lastLoginAt && (!pg.lastLoginAt || lastLoginAt > pg.lastLoginAt)) {
      data.lastLoginAt = lastLoginAt;
      reasons.push('newer lastLoginAt');
    }
    if (createdAt < pg.createdAt) {
      data.createdAt = createdAt;
      reasons.push('earlier createdAt');
    }
    if (!pg.name && name) {
      data.name = name;
      reasons.push('fill name');
    }

    if (reasons.length === 0) {
      plan.push({ kind: 'noop', sqliteId: u.id, email, reason: 'already migrated / nothing to add' });
    } else {
      plan.push({ kind: 'update', sqliteId: u.id, email, pgUserId: pg.id, data, reasons });
    }
  }

  return plan;
}

// ── Apply ────────────────────────────────────────────────────────────────────

export interface PrismaLike {
  user: {
    findMany(args: unknown): Promise<PgUserLite[]>;
    create(args: { data: UserCreateData }): Promise<{ id: string }>;
    update(args: { where: { id: string }; data: UserUpdateData }): Promise<{ id: string }>;
  };
}

export interface ImportServices {
  resolveOrgId(userId: string): Promise<string>;
}

export interface ImportResult {
  created: number;
  updated: number;
  noop: number;
  conflicts: number;
  plan: PlanEntry[];
}

export async function runUserImport(
  exportData: ExportFile,
  deps: { prisma: PrismaLike; services: ImportServices; apply: boolean }
): Promise<ImportResult> {
  const { prisma, services, apply } = deps;

  const pgUsers = await prisma.user.findMany({
    select: {
      id: true,
      email: true,
      googleId: true,
      passwordHash: true,
      emailVerifiedAt: true,
      lastLoginAt: true,
      createdAt: true,
      name: true,
    },
  });

  const pgByEmail = new Map<string, PgUserLite>();
  const pgByGoogleId = new Map<string, PgUserLite>();
  for (const p of pgUsers) {
    pgByEmail.set(normalizeEmail(p.email), p);
    if (p.googleId) pgByGoogleId.set(p.googleId, p);
  }

  const plan = planUserMigration(exportData.users || [], pgByEmail, pgByGoogleId);

  const result: ImportResult = { created: 0, updated: 0, noop: 0, conflicts: 0, plan };

  for (const entry of plan) {
    if (entry.kind === 'noop') {
      result.noop++;
      continue;
    }
    if (entry.kind === 'conflict') {
      result.conflicts++;
      console.warn(`  CONFLICT  <${entry.email}> (sqlite #${entry.sqliteId}): ${entry.reason}`);
      continue;
    }
    if (entry.kind === 'create') {
      console.log(`  CREATE    <${entry.email}>${entry.data.googleId ? ' [google]' : ''}${entry.data.passwordHash ? ' [pw]' : ''}`);
      if (apply) {
        const user = await prisma.user.create({ data: entry.data });
        await services.resolveOrgId(user.id);
        result.created++;
      }
      continue;
    }
    // update
    console.log(`  UPDATE    <${entry.email}> -> ${entry.reasons.join(', ')}`);
    if (apply) {
      await prisma.user.update({ where: { id: entry.pgUserId }, data: entry.data });
      await services.resolveOrgId(entry.pgUserId);
      result.updated++;
    }
  }

  if (!apply) {
    result.created = plan.filter((p) => p.kind === 'create').length;
    result.updated = plan.filter((p) => p.kind === 'update').length;
  }

  return result;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { input?: string; apply: boolean } {
  const out: { input?: string; apply: boolean } = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--input') out.input = argv[++i];
    else if (argv[i] === '--apply') out.apply = true;
  }
  return out;
}

/**
 * Pre-seed require.cache for ../src/index with our own PrismaClient so that
 * requiring intel.service (for resolveOrgId) does not boot the Express app.
 * Mirrors backfill-sqlite-metrics.ts's loadRealServices().
 */
function loadRealServices(prismaClient: unknown): ImportServices {
  const indexPath = require.resolve('../src/index');
  if (!require.cache[indexPath]) {
    require.cache[indexPath] = {
      id: indexPath,
      filename: indexPath,
      loaded: true,
      exports: { prisma: prismaClient },
    } as unknown as NodeModule;
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { resolveOrgId } = require('../src/services/intel.service');
  return { resolveOrgId };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) {
    console.error('Usage: npx ts-node scripts/import-sqlite-users.ts --input <users.json> [--apply]');
    process.exit(1);
  }

  console.log(`\n=== SQLite -> Postgres user import — ${args.apply ? 'APPLY MODE' : 'DRY RUN (no writes)'} ===\n`);
  if (args.apply) {
    console.log('*** --apply supplied: this WILL write to Postgres. Ctrl+C now to abort. ***\n');
  }

  const raw = fs.readFileSync(path.resolve(args.input), 'utf8');
  const exportData: ExportFile = JSON.parse(raw);
  console.log(`Loaded ${exportData.users?.length ?? 0} SQLite user row(s).\n`);

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();

  try {
    const services: ImportServices = args.apply
      ? loadRealServices(prisma)
      : { resolveOrgId: async () => { throw new Error('resolveOrgId must not be called in dry run'); } };

    const res = await runUserImport(exportData, { prisma, services, apply: args.apply });

    console.log(
      `\n=== ${args.apply ? 'Applied' : 'Plan'}: ${res.created} create, ${res.updated} update, ${res.noop} unchanged, ${res.conflicts} conflict(s) ===`
    );
    if (res.conflicts > 0) {
      console.log('Resolve the conflicts above by hand, then re-run.');
    }
    if (!args.apply) {
      console.log('\nRe-run with --apply to write these changes.');
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
