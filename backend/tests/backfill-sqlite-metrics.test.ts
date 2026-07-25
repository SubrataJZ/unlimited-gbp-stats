/**
 * backfill-sqlite-metrics.test.ts — plain-Node/ts-node assertions for the
 * SQLite -> Postgres backfill script (task A6), same style as
 * backend/tests/metrics-intel.test.ts: assert(), run directly, print
 * "ALL TESTS PASSED" on success.
 *
 * Run:  npx ts-node tests/backfill-sqlite-metrics.test.ts   (from backend/)
 *
 * Does NOT require a live database and does NOT read SQLite — everything is
 * fed as hand-built fixture objects. The script under test never imports
 * '../src/index' unless services.resolveOrgId/ingestMetricMonths are
 * actually invoked (only in --apply mode), so these tests never boot the
 * Express app.
 */
'use strict';

import {
  mapSqliteMetric,
  buildTenantBusinesses,
  runBackfill,
  SqliteMetric,
  SqliteUser,
  SqliteBusiness,
  ExportFile,
  PrismaLike,
  BackfillServices,
} from '../scripts/backfill-sqlite-metrics';

let assertCount = 0;
function assert(cond: unknown, msg: string): void {
  assertCount++;
  if (!cond) {
    throw new Error(`FAILED #${assertCount}: ${msg}`);
  }
}
function eq(a: unknown, b: unknown, msg: string): void {
  assert(a === b, `${msg} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`);
}

function baseMetric(overrides: Partial<SqliteMetric>): SqliteMetric {
  return {
    id: 'loc1_overview_2026-01',
    user_id: 1,
    location_code: 'loc1',
    metric_type: 'overview',
    year: 2026,
    month: 1,
    total: 10,
    daily: '[]',
    yoy_percent: null,
    extra: '{}',
    derived: 0,
    collected_at: 0,
    synced_at: 0,
    ...overrides,
  };
}

async function main() {
  // ── 1. collected_at = 0, synced_at = 0 → mapped collectedAt is new Date(0),
  //       NOT undefined. The single most important test in this file. ────────
  {
    const m = baseMetric({ collected_at: 0, synced_at: 0 });
    const mapped = mapSqliteMetric(m);
    assert(mapped.collectedAt instanceof Date, 'case 1: collectedAt is a Date');
    eq(mapped.collectedAt!.getTime(), 0, 'case 1: collectedAt is epoch 0 when both timestamps are 0');
    assert(mapped.collectedAt !== undefined, 'case 1: collectedAt is never undefined');
  }

  // ── 2. collected_at = 0, synced_at = 1700000000000 → uses synced_at ───────
  {
    const m = baseMetric({ collected_at: 0, synced_at: 1700000000000 });
    const mapped = mapSqliteMetric(m);
    eq(mapped.collectedAt!.getTime(), 1700000000000, 'case 2: falls back to synced_at');
  }

  // ── 2b. collected_at > 0 takes priority over synced_at ─────────────────────
  {
    const m = baseMetric({ collected_at: 1600000000000, synced_at: 1700000000000 });
    const mapped = mapSqliteMetric(m);
    eq(mapped.collectedAt!.getTime(), 1600000000000, 'case 2b: collected_at wins when positive');
  }

  // ── 3. derived = 1 → isDerived: true; source is 'sqlite-backfill' ─────────
  {
    const m = baseMetric({ derived: 1 });
    const mapped = mapSqliteMetric(m);
    eq(mapped.isDerived, true, 'case 3: isDerived true when derived=1');
    eq(mapped.source, 'sqlite-backfill', 'case 3: source is sqlite-backfill');

    const m2 = baseMetric({ derived: 0 });
    const mapped2 = mapSqliteMetric(m2);
    eq(mapped2.isDerived, false, 'case 3: isDerived false when derived=0');
  }

  // ── 4. extra containing breakdown + searchTerms + an unknown key ──────────
  {
    const extra = JSON.stringify({
      breakdown: { direct: 5, discovery: 3 },
      searchTerms: [{ term: 'plumber', count: 2 }],
      searchImpressions: 42, // unknown/unmapped key
    });
    const m = baseMetric({ extra });
    const mapped = mapSqliteMetric(m);
    assert(mapped.breakdown !== undefined, 'case 4: breakdown mapped');
    eq((mapped.breakdown as any).direct, 5, 'case 4: breakdown value correct');
    assert(mapped.searchTerms !== undefined, 'case 4: searchTerms mapped');
    eq(mapped.searchTerms![0].term, 'plumber', 'case 4: searchTerms value correct');

    // The unknown key must appear in the reported extra-key inventory.
    const grouped = buildTenantBusinesses(
      1,
      [{ location_code: 'loc1', user_id: 1, name: 'Loc One' }],
      [m]
    );
    assert(
      'searchImpressions' in grouped.extraKeyCounts,
      'case 4: unknown extra key appears in inventory'
    );
    eq(grouped.extraKeyCounts['searchImpressions'], 1, 'case 4: unknown key counted once');
  }

  // ── 5. A SQLite user with no matching Postgres user → tenant skipped,
  //       reported, and zero calls made to ingestMetricMonths. ──────────────
  {
    let ingestCalls = 0;
    let resolveOrgCalls = 0;

    const prisma: PrismaLike = {
      user: {
        findUnique: async () => null, // nobody matches, by any field
      },
      membership: {
        findFirst: async () => {
          throw new Error('should never be reached for an unmatched tenant');
        },
      },
      trackedBusiness: {
        findFirst: async () => {
          throw new Error('should never be reached for an unmatched tenant');
        },
        findMany: async () => {
          throw new Error('should never be reached for an unmatched tenant');
        },
      },
    };

    const services: BackfillServices = {
      resolveOrgId: async (userId: string) => {
        resolveOrgCalls++;
        return 'org-should-not-happen';
      },
      ingestMetricMonths: async () => {
        ingestCalls++;
        return {
          businessesCreated: 0,
          businessesUpdated: 0,
          metricsCreated: 0,
          metricsUpdated: 0,
          metricsSkipped: 0,
        };
      },
    };

    const users: SqliteUser[] = [{ id: 99, email: 'ghost@example.com', google_id: null }];
    const businesses: SqliteBusiness[] = [{ location_code: 'loc99', user_id: 99, name: 'Ghost Biz' }];
    const metrics: SqliteMetric[] = [
      baseMetric({ user_id: 99, location_code: 'loc99', id: 'loc99_overview_2026-01' }),
    ];
    const exportData: ExportFile = { exportedAt: new Date().toISOString(), users, businesses, metrics };

    // Run with --apply true as well, to prove the skip happens before any
    // service call regardless of dry-run/apply mode.
    const reports = await runBackfill(prisma, exportData, { apply: true }, services);

    eq(reports.length, 1, 'case 5: one tenant report produced');
    eq(reports[0].matched, false, 'case 5: tenant reported as unmatched');
    eq(ingestCalls, 0, 'case 5: ingestMetricMonths never called');
    eq(resolveOrgCalls, 0, 'case 5: resolveOrgId never called');
  }

  // ── 6. Dry run makes zero write calls ──────────────────────────────────────
  {
    let readCalls = 0;
    const writeAttempted: string[] = [];

    const prisma: PrismaLike = {
      user: {
        findUnique: async (args: any) => {
          readCalls++;
          if (args.where.googleId === 'g-123') {
            return { id: 'pg-user-1', email: 'owner@example.com' };
          }
          return null;
        },
      },
      membership: {
        findFirst: async () => {
          readCalls++;
          return { orgId: 'org-1' }; // existing membership — resolveOrgId would not create
        },
      },
      trackedBusiness: {
        findFirst: async () => {
          readCalls++;
          return null; // no existing business by googlePlaceId
        },
        findMany: async () => {
          readCalls++;
          return []; // no existing business by name either
        },
      },
    };

    // Any attempted "write" call throws so the test fails loudly if the dry
    // run path ever reaches a mutating service.
    const services: BackfillServices = {
      resolveOrgId: async () => {
        writeAttempted.push('resolveOrgId');
        return 'should-not-be-called';
      },
      ingestMetricMonths: async () => {
        writeAttempted.push('ingestMetricMonths');
        return {
          businessesCreated: 0,
          businessesUpdated: 0,
          metricsCreated: 0,
          metricsUpdated: 0,
          metricsSkipped: 0,
        };
      },
    };

    const users: SqliteUser[] = [{ id: 1, email: 'owner@example.com', google_id: 'g-123' }];
    const businesses: SqliteBusiness[] = [{ location_code: 'loc1', user_id: 1, name: 'Loc One' }];
    const metrics: SqliteMetric[] = [baseMetric({ user_id: 1, location_code: 'loc1' })];
    const exportData: ExportFile = { exportedAt: new Date().toISOString(), users, businesses, metrics };

    const reports = await runBackfill(prisma, exportData, { apply: false }, services);

    eq(reports.length, 1, 'case 6: one tenant report produced');
    eq(reports[0].matched, true, 'case 6: tenant matched by googleId');
    eq(reports[0].matchedBy, 'googleId', 'case 6: matched field is googleId');
    eq(reports[0].businessCount, 1, 'case 6: one business grouped');
    eq(reports[0].businessesNew, 1, 'case 6: business reported as new (no existing match found)');
    eq(writeAttempted.length, 0, 'case 6: dry run never calls a mutating service');
    assert(readCalls > 0, 'case 6: dry run does use read-only Prisma calls');
  }

  console.log(`ALL TESTS PASSED (${assertCount} assertions)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
