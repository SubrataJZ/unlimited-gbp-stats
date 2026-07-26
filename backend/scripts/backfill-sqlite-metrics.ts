/**
 * backfill-sqlite-metrics.ts — one-off SQLite → Postgres metrics backfill
 * (task A6).
 *
 * Imports the JSON produced by
 * unlimited-gbp-stats/server/scripts/export-metrics.js and merges it into
 * Postgres via the same merge logic the extension's live ingest path uses
 * (ingestMetricMonths in metrics-intel.service.ts) — called directly, not
 * over HTTP, so it sidesteps auth/rate-limit/request-size concerns that only
 * matter for the network path.
 *
 * SAFETY: default mode is a dry run that writes nothing. `--apply` performs
 * real writes and must only be run by a human, one `--tenant` at a time
 * first. See the task spec for the full design rationale (section 2c —
 * collectedAt mapping — is the part that prevents data loss).
 *
 * Usage:
 *   npx ts-node scripts/backfill-sqlite-metrics.ts --input <export.json> [--apply] [--tenant <email>]
 */

import fs from 'fs';
import path from 'path';
import type {
  IncomingMetricMonth,
  IncomingMetricsBusiness,
  MetricsIngestSummary,
} from '../src/services/metrics-intel.service';

// ── Raw SQLite row shapes (verbatim from export-metrics.js) ────────────────

export interface SqliteUser {
  id: number;
  email: string;
  google_id: string | null;
}

export interface SqliteBusiness {
  location_code: string;
  user_id: number;
  name: string | null;
}

export interface SqliteMetric {
  id: string;
  user_id: number;
  location_code: string;
  metric_type: string;
  year: number;
  month: number;
  total: number;
  daily: string | null;
  yoy_percent: number | null;
  extra: string | null;
  derived: number; // 0 | 1
  collected_at: number | null; // epoch ms
  synced_at: number | null; // epoch ms
}

export interface ExportFile {
  exportedAt: string;
  users: SqliteUser[];
  businesses: SqliteBusiness[];
  metrics: SqliteMetric[];
}

// ── Minimal Prisma surface this script touches directly (read-only, plus
// whatever the injected `services` do). Kept narrow and hand-typed so the
// dry-run path can be exercised against a stubbed-Prisma fixture in tests,
// same style as backend/tests/metrics-intel.test.ts. ───────────────────────

export interface PrismaLike {
  user: {
    findUnique: (args: any) => Promise<{ id: string; email: string } | null>;
  };
  membership: {
    findFirst: (args: any) => Promise<{ orgId: string } | null>;
  };
  trackedBusiness: {
    findFirst: (args: any) => Promise<{ id: string } | null>;
    findMany: (args: any) => Promise<Array<{ id: string; name: string }>>;
  };
}

export interface BackfillServices {
  resolveOrgId: (userId: string) => Promise<string>;
  ingestMetricMonths: (
    orgId: string,
    businesses: IncomingMetricsBusiness[]
  ) => Promise<MetricsIngestSummary>;
}

export interface RunOptions {
  apply: boolean;
  tenant?: string;
}

export interface TenantReport {
  sqliteUserId: number;
  sqliteEmail: string;
  matched: boolean;
  matchedBy?: 'googleId' | 'email';
  postgresUserId?: string;
  postgresEmail?: string;
  orgId?: string;
  orgWouldBeCreated?: boolean;
  businessCount: number;
  businessesNew: number;
  businessesExisting: number;
  existingAttachments: Array<{
    locationCode: string;
    name: string;
    matchedTrackedBusinessId: string;
    matchedBy: 'googlePlaceId' | 'name';
  }>;
  metricRowCount: number;
  dateRangeMin?: string;
  dateRangeMax?: string;
  derivedCount: number;
  scrapedCount: number;
  extraKeyCounts: Record<string, number>;
  metricTypeCounts: Record<string, number>;
  errors: Array<{ locationCode: string; message: string }>;
  ingestSummary?: MetricsIngestSummary;
}

// ── JSON parsing helpers (SQLite TEXT columns) ──────────────────────────────

function safeParseArray(json: string | null | undefined): number[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function safeParseObject(json: string | null | undefined): Record<string, unknown> {
  if (!json) return {};
  try {
    const v = JSON.parse(json);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Distinct keys present in a metric's `extra` JSON blob (all of them — used
 * for the data-loss inventory in the report, not just the unmapped ones). */
function extraKeysOf(json: string | null | undefined): string[] {
  return Object.keys(safeParseObject(json));
}

// ── 2c. Metric mapping — collectedAt is the field that must never be wrong ─

/**
 * Maps one raw SQLite metrics row to the IncomingMetricMonth shape
 * ingestMetricMonths expects.
 *
 * collectedAt is ALWAYS a Date, never undefined:
 *   collected_at > 0  → new Date(collected_at)
 *   else synced_at > 0 → new Date(synced_at)
 *   else               → new Date(0)   // 1970 — always loses to a real scrape
 *
 * A2's merge rule treats a *missing* collectedAt on either side as
 * "last-write-wins → update", so leaving this undefined would let a backfill
 * row silently overwrite a fresher live scrape. Falling back to epoch 0
 * instead guarantees a backfill row can never beat a scraped row, in either
 * arrival order — see task A6 spec section 2c.
 */
export function mapSqliteMetric(m: SqliteMetric): IncomingMetricMonth {
  const daily = safeParseArray(m.daily);
  const extra = safeParseObject(m.extra);

  const collectedAtMs = typeof m.collected_at === 'number' ? m.collected_at : 0;
  const syncedAtMs = typeof m.synced_at === 'number' ? m.synced_at : 0;

  const collectedAt: Date =
    collectedAtMs > 0
      ? new Date(collectedAtMs)
      : syncedAtMs > 0
      ? new Date(syncedAtMs)
      : new Date(0);

  const mapped: IncomingMetricMonth = {
    metricType: m.metric_type,
    year: m.year,
    month: m.month,
    total: m.total,
    isDerived: m.derived === 1,
    source: 'sqlite-backfill',
    collectedAt,
  };

  if (m.yoy_percent !== null && m.yoy_percent !== undefined) {
    mapped.yoyPercent = m.yoy_percent;
  }
  if (daily.length > 0) {
    mapped.daily = daily;
  }
  if (extra.breakdown !== undefined) {
    mapped.breakdown = extra.breakdown as Record<string, number>;
  }
  if (extra.searchTerms !== undefined) {
    mapped.searchTerms = extra.searchTerms as Array<{ term: string; count: number }>;
  }

  return mapped;
}

// ── 2b. Business grouping ───────────────────────────────────────────────────

export interface TenantBusinessesResult {
  incoming: IncomingMetricsBusiness[];
  metricRowCount: number;
  dateRangeMin?: string;
  dateRangeMax?: string;
  derivedCount: number;
  scrapedCount: number;
  extraKeyCounts: Record<string, number>;
  metricTypeCounts: Record<string, number>;
}

/** Groups one tenant's raw metric rows by (user_id, location_code) into
 * IncomingMetricsBusiness entries, and accumulates the 2d data-loss
 * inventories (extra keys, metric_type values) along the way. */
export function buildTenantBusinesses(
  sqliteUserId: number,
  businesses: SqliteBusiness[],
  metrics: SqliteMetric[]
): TenantBusinessesResult {
  const userMetrics = metrics.filter((m) => m.user_id === sqliteUserId);
  const userBusinesses = businesses.filter((b) => b.user_id === sqliteUserId);

  const byLocation = new Map<string, SqliteMetric[]>();
  for (const m of userMetrics) {
    const arr = byLocation.get(m.location_code) ?? [];
    arr.push(m);
    byLocation.set(m.location_code, arr);
  }

  const extraKeyCounts: Record<string, number> = {};
  const metricTypeCounts: Record<string, number> = {};
  let derivedCount = 0;
  let scrapedCount = 0;
  let minKey: string | undefined;
  let maxKey: string | undefined;

  const incoming: IncomingMetricsBusiness[] = [];

  for (const [locationCode, rows] of byLocation) {
    const bizRow = userBusinesses.find((b) => b.location_code === locationCode);
    const name = bizRow?.name || locationCode;

    const mappedMetrics: IncomingMetricMonth[] = rows.map((m) => {
      metricTypeCounts[m.metric_type] = (metricTypeCounts[m.metric_type] ?? 0) + 1;
      for (const k of extraKeysOf(m.extra)) {
        extraKeyCounts[k] = (extraKeyCounts[k] ?? 0) + 1;
      }
      if (m.derived === 1) derivedCount++;
      else scrapedCount++;

      const key = `${m.year}-${String(m.month).padStart(2, '0')}`;
      if (!minKey || key < minKey) minKey = key;
      if (!maxKey || key > maxKey) maxKey = key;

      return mapSqliteMetric(m);
    });

    incoming.push({
      name,
      googlePlaceId: String(locationCode),
      isOwn: true,
      metrics: mappedMetrics,
    });
  }

  return {
    incoming,
    metricRowCount: userMetrics.length,
    dateRangeMin: minKey,
    dateRangeMax: maxKey,
    derivedCount,
    scrapedCount,
    extraKeyCounts,
    metricTypeCounts,
  };
}

// ── 2a. Tenant mapping — fail loudly, never guess ───────────────────────────

/** googleId first, then email. Never creates a User — an unmatched SQLite
 * user is reported and that tenant's data is skipped entirely (see task
 * spec section 2a). */
export async function findPostgresUser(
  prisma: PrismaLike,
  sqliteUser: SqliteUser
): Promise<{ id: string; email: string; matchedBy: 'googleId' | 'email' } | null> {
  if (sqliteUser.google_id) {
    const byGoogle = await prisma.user.findUnique({
      where: { googleId: sqliteUser.google_id },
      select: { id: true, email: true },
    });
    if (byGoogle) return { id: byGoogle.id, email: byGoogle.email, matchedBy: 'googleId' };
  }
  if (sqliteUser.email) {
    const byEmail = await prisma.user.findUnique({
      where: { email: sqliteUser.email },
      select: { id: true, email: true },
    });
    if (byEmail) return { id: byEmail.id, email: byEmail.email, matchedBy: 'email' };
  }
  return null;
}

// ── Dry-run-only, read-only previews (no writes, ever) ──────────────────────

/** Read-only stand-in for resolveOrgId: looks up an existing membership but
 * never auto-creates an Organization/Membership the way the real
 * resolveOrgId does. Dry run must not write, full stop. */
export async function previewOrgId(
  prisma: PrismaLike,
  userId: string
): Promise<{ orgId: string | null; wouldCreate: boolean }> {
  const membership = await prisma.membership.findFirst({
    where: { userId },
    select: { orgId: true },
  });
  if (membership) return { orgId: membership.orgId, wouldCreate: false };
  return { orgId: null, wouldCreate: true };
}

// Mirrors normalizeForMatch in intel.service.ts (not exported there) so the
// dry-run preview classifies matches identically to what resolveTrackedBusiness
// will actually do on --apply.
function normalizeForMatch(s: string): string {
  return (s || '')
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ');
}

/** Read-only stand-in for resolveTrackedBusiness's lookup half (no
 * create/update). Since SQLite has no address, this degrades to
 * googlePlaceId-exact then name-only fuzzy match — which is why the task
 * spec requires every such existing-business attachment to be surfaced for a
 * human to eyeball before --apply. */
export async function previewBusinessMatch(
  prisma: PrismaLike,
  orgId: string,
  biz: IncomingMetricsBusiness
): Promise<{ isNew: boolean; matchedId?: string; matchedBy?: 'googlePlaceId' | 'name' }> {
  const byGpid = await prisma.trackedBusiness.findFirst({
    where: { orgId, googlePlaceId: biz.googlePlaceId },
    select: { id: true },
  });
  if (byGpid) return { isNew: false, matchedId: byGpid.id, matchedBy: 'googlePlaceId' };

  const candidates = await prisma.trackedBusiness.findMany({
    where: { orgId },
    select: { id: true, name: true },
  });
  const incomingName = normalizeForMatch(biz.name);
  const match = candidates.find((c) => normalizeForMatch(c.name) === incomingName);
  if (match) return { isNew: false, matchedId: match.id, matchedBy: 'name' };

  return { isNew: true };
}

// ── Orchestration ────────────────────────────────────────────────────────────

/**
 * Runs the backfill (dry run or apply) over one export file and returns a
 * per-tenant report. Never touches SQLite. In dry-run mode (`opts.apply ===
 * false`) only read-only Prisma calls are made — `services.resolveOrgId` and
 * `services.ingestMetricMonths` are never invoked.
 *
 * Each business is imported with its own `services.ingestMetricMonths` call
 * (rather than one call per tenant) and wrapped in try/catch, so one bad
 * business cannot abort the rest of a tenant's — or the run's — data.
 */
export async function runBackfill(
  prisma: PrismaLike,
  exportData: ExportFile,
  opts: RunOptions,
  services: BackfillServices
): Promise<TenantReport[]> {
  const reports: TenantReport[] = [];

  let sqliteUsers = exportData.users;
  if (opts.tenant) {
    const wanted = opts.tenant.toLowerCase();
    sqliteUsers = sqliteUsers.filter((u) => (u.email || '').toLowerCase() === wanted);
  }

  for (const su of sqliteUsers) {
    const match = await findPostgresUser(prisma, su);

    if (!match) {
      reports.push({
        sqliteUserId: su.id,
        sqliteEmail: su.email,
        matched: false,
        businessCount: 0,
        businessesNew: 0,
        businessesExisting: 0,
        existingAttachments: [],
        metricRowCount: 0,
        derivedCount: 0,
        scrapedCount: 0,
        extraKeyCounts: {},
        metricTypeCounts: {},
        errors: [],
      });
      continue;
    }

    const grouped = buildTenantBusinesses(su.id, exportData.businesses, exportData.metrics);

    const report: TenantReport = {
      sqliteUserId: su.id,
      sqliteEmail: su.email,
      matched: true,
      matchedBy: match.matchedBy,
      postgresUserId: match.id,
      postgresEmail: match.email,
      businessCount: grouped.incoming.length,
      businessesNew: 0,
      businessesExisting: 0,
      existingAttachments: [],
      metricRowCount: grouped.metricRowCount,
      dateRangeMin: grouped.dateRangeMin,
      dateRangeMax: grouped.dateRangeMax,
      derivedCount: grouped.derivedCount,
      scrapedCount: grouped.scrapedCount,
      extraKeyCounts: grouped.extraKeyCounts,
      metricTypeCounts: grouped.metricTypeCounts,
      errors: [],
    };

    if (!opts.apply) {
      // ── Dry run: read-only preview, no writes ────────────────────────────
      const orgPreview = await previewOrgId(prisma, match.id);
      report.orgId = orgPreview.orgId ?? undefined;
      report.orgWouldBeCreated = orgPreview.wouldCreate;

      if (orgPreview.orgId) {
        const orgId = orgPreview.orgId;
        for (const biz of grouped.incoming) {
          const bizMatch = await previewBusinessMatch(prisma, orgId, biz);
          if (bizMatch.isNew) {
            report.businessesNew++;
          } else {
            report.businessesExisting++;
            report.existingAttachments.push({
              locationCode: biz.googlePlaceId!,
              name: biz.name,
              matchedTrackedBusinessId: bizMatch.matchedId!,
              matchedBy: bizMatch.matchedBy!,
            });
          }
        }
      } else {
        // No org exists yet for this user — every business would be created new.
        report.businessesNew = grouped.incoming.length;
      }
    } else {
      // ── Apply: real writes, one business at a time ──────────────────────
      const orgId = await services.resolveOrgId(match.id);
      report.orgId = orgId;
      report.orgWouldBeCreated = false;

      const summary: MetricsIngestSummary = {
        businessesCreated: 0,
        businessesUpdated: 0,
        metricsCreated: 0,
        metricsUpdated: 0,
        metricsSkipped: 0,
      };

      for (const biz of grouped.incoming) {
        try {
          const s = await services.ingestMetricMonths(orgId, [biz]);
          summary.businessesCreated += s.businessesCreated;
          summary.businessesUpdated += s.businessesUpdated;
          summary.metricsCreated += s.metricsCreated;
          summary.metricsUpdated += s.metricsUpdated;
          summary.metricsSkipped += s.metricsSkipped;
          if (s.businessesCreated > 0) report.businessesNew++;
          else report.businessesExisting++;
        } catch (err: any) {
          report.errors.push({
            locationCode: biz.googlePlaceId ?? biz.name,
            message: err?.message ?? String(err),
          });
        }
      }

      report.ingestSummary = summary;
    }

    reports.push(report);
  }

  return reports;
}

// ── Reporting ────────────────────────────────────────────────────────────────

export function printReport(reports: TenantReport[], applied: boolean): void {
  console.log('='.repeat(70));
  console.log('SQLite -> Postgres metrics backfill report');
  console.log('='.repeat(70));

  let grandBusinesses = 0;
  let grandBusinessesNew = 0;
  let grandBusinessesExisting = 0;
  let grandMetrics = 0;
  let grandDerived = 0;
  let grandScraped = 0;
  let grandErrors = 0;
  let grandSkippedTenants = 0;
  const grandExtraKeys: Record<string, number> = {};
  const grandMetricTypes: Record<string, number> = {};

  for (const r of reports) {
    console.log('');
    console.log(`Tenant: sqlite user #${r.sqliteUserId} <${r.sqliteEmail}>`);

    if (!r.matched) {
      grandSkippedTenants++;
      console.log(
        '  STATUS: NO MATCHING POSTGRES USER -- SKIPPED (no data imported for this tenant)'
      );
      continue;
    }

    console.log(`  matched Postgres user ${r.postgresUserId} <${r.postgresEmail}> by ${r.matchedBy}`);
    console.log(
      `  org: ${r.orgId ?? '(unresolved)'}${r.orgWouldBeCreated ? '  [would be newly created]' : ''}`
    );
    console.log(
      `  businesses: ${r.businessCount}  (new: ${r.businessesNew}, existing-attach: ${r.businessesExisting})`
    );
    for (const a of r.existingAttachments) {
      console.log(
        `    ATTACH -> "${a.name}" (${a.locationCode}) would attach to existing TrackedBusiness ${a.matchedTrackedBusinessId} (matched by ${a.matchedBy})`
      );
    }
    console.log(
      `  metric rows: ${r.metricRowCount}  (derived: ${r.derivedCount}, scraped: ${r.scrapedCount})`
    );
    if (r.dateRangeMin && r.dateRangeMax) {
      console.log(`  date range: ${r.dateRangeMin} .. ${r.dateRangeMax}`);
    }
    console.log(`  metric_type values: ${JSON.stringify(r.metricTypeCounts)}`);
    console.log(`  extra keys seen: ${JSON.stringify(r.extraKeyCounts)}`);
    if (r.ingestSummary) {
      console.log(
        `  ingest result: created=${r.ingestSummary.metricsCreated} updated=${r.ingestSummary.metricsUpdated} skipped=${r.ingestSummary.metricsSkipped}`
      );
    }
    if (r.errors.length > 0) {
      console.log(`  ERRORS (${r.errors.length}):`);
      for (const e of r.errors) console.log(`    ${e.locationCode}: ${e.message}`);
    }

    grandBusinesses += r.businessCount;
    grandBusinessesNew += r.businessesNew;
    grandBusinessesExisting += r.businessesExisting;
    grandMetrics += r.metricRowCount;
    grandDerived += r.derivedCount;
    grandScraped += r.scrapedCount;
    grandErrors += r.errors.length;
    for (const [k, c] of Object.entries(r.extraKeyCounts)) {
      grandExtraKeys[k] = (grandExtraKeys[k] ?? 0) + c;
    }
    for (const [k, c] of Object.entries(r.metricTypeCounts)) {
      grandMetricTypes[k] = (grandMetricTypes[k] ?? 0) + c;
    }
  }

  console.log('');
  console.log('-'.repeat(70));
  console.log('GRAND TOTAL');
  console.log(`  tenants processed: ${reports.length}  (skipped, no match: ${grandSkippedTenants})`);
  console.log(
    `  businesses: ${grandBusinesses}  (new: ${grandBusinessesNew}, existing-attach: ${grandBusinessesExisting})`
  );
  console.log(`  metric rows: ${grandMetrics}  (derived: ${grandDerived}, scraped: ${grandScraped})`);
  console.log(`  metric_type inventory: ${JSON.stringify(grandMetricTypes)}`);
  console.log(`  extra-key inventory: ${JSON.stringify(grandExtraKeys)}`);
  console.log(`  errors: ${grandErrors}`);
  console.log('-'.repeat(70));
  console.log(applied ? 'APPLIED' : 'DRY RUN -- nothing written');
  console.log('='.repeat(70));
}

// ── CLI entry point ──────────────────────────────────────────────────────────

function parseArgs(argv: string[]): RunOptions & { input?: string } {
  const out: RunOptions & { input?: string } = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input') out.input = argv[++i];
    else if (a === '--apply') out.apply = true;
    else if (a === '--tenant') out.tenant = argv[++i];
  }
  return out;
}

/**
 * Lazily loads the real resolveOrgId/ingestMetricMonths — only ever called
 * from --apply. Both service modules `import { prisma } from '../index'`,
 * and index.ts's module-level side effect is to boot a full Express server
 * and start listening on PORT. We want the Prisma-backed functions, not a
 * second HTTP server, so — exactly like backend/tests/metrics-intel.test.ts
 * does for testing — we stub the '../index' module in Node's require cache
 * with our own PrismaClient before requiring the service modules.
 */
function loadRealServices(prismaClient: unknown): BackfillServices {
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
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ingestMetricMonths } = require('../src/services/metrics-intel.service');
  return { resolveOrgId, ingestMetricMonths };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.input) {
    console.error(
      'Usage: npx ts-node scripts/backfill-sqlite-metrics.ts --input <export.json> [--apply] [--tenant <email>]'
    );
    process.exit(1);
  }

  if (args.apply) {
    console.log(
      '*** --apply supplied: this WILL write to Postgres. Ctrl+C now to abort. ***'
    );
  }

  const raw = fs.readFileSync(path.resolve(args.input), 'utf8');
  const exportData: ExportFile = JSON.parse(raw);

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();

  try {
    const services: BackfillServices = args.apply
      ? loadRealServices(prisma)
      : {
          resolveOrgId: async () => {
            throw new Error('resolveOrgId must never be called in dry-run mode');
          },
          ingestMetricMonths: async () => {
            throw new Error('ingestMetricMonths must never be called in dry-run mode');
          },
        };

    const reports = await runBackfill(
      prisma as unknown as PrismaLike,
      exportData,
      { apply: args.apply, tenant: args.tenant },
      services
    );
    printReport(reports, args.apply);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
