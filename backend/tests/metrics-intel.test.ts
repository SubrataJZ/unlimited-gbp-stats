/**
 * metrics-intel.test.ts — plain-Node/ts-node assertions for the metrics merge
 * rule in metrics-intel.service.ts (no test runner is configured in
 * backend/package.json, so this follows the style of
 * unlimited-gbp-stats/review-date.test.js: assert(), run directly, print
 * "ALL TESTS PASSED" on success).
 *
 * Run:  npx ts-node tests/metrics-intel.test.ts   (from backend/)
 *
 * Does NOT require a live database. Before importing the services under
 * test, this stubs out `../index` (the Express/Prisma bootstrap module) in
 * Node's require cache with a fake `{ prisma }` backed by an in-memory
 * store, so importing intel.service.ts / metrics-intel.service.ts never
 * spins up the server or touches a real Postgres connection.
 */
'use strict';

import path from 'path';

let assertCount = 0;
function assert(cond: unknown, msg: string): void {
  assertCount++;
  if (!cond) {
    throw new Error(`FAILED #${assertCount}: ${msg}`);
  }
}
function eq(a: unknown, b: unknown, msg: string): void {
  assert(
    a === b,
    `${msg} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`
  );
}

// ── In-memory fake Prisma ───────────────────────────────────────────────────

interface FakeTrackedBusiness {
  id: string;
  orgId: string;
  googlePlaceId: string | null;
  name: string;
  address: string | null;
  searchUrl: string | null;
  logoUrl: string | null;
  isOwn: boolean;
}

interface FakeMetricMonth {
  id: string;
  trackedBusinessId: string;
  metricType: string;
  year: number;
  month: number;
  total: number;
  daily: unknown;
  yoyPercent: number | null;
  breakdown: unknown;
  searchTerms: unknown;
  isDerived: boolean;
  source: string;
  collectedAt: Date | null;
}

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter++;
  return `${prefix}_${idCounter}`;
}

function makeFakePrisma() {
  const businesses: FakeTrackedBusiness[] = [];
  const metrics: FakeMetricMonth[] = [];

  const tx = {
    trackedBusiness: {
      async findFirst(args: any) {
        const { orgId, googlePlaceId, name, address } = args.where;
        const match = businesses.find((b) => {
          if (b.orgId !== orgId) return false;
          if (googlePlaceId !== undefined && b.googlePlaceId !== googlePlaceId) return false;
          if (name !== undefined && b.name !== name) return false;
          if (address !== undefined && b.address !== (address ?? null)) return false;
          return true;
        });
        if (!match) return null;
        return { id: match.id };
      },
      async findMany(args: any) {
        const { orgId } = args.where;
        return businesses
          .filter((b) => b.orgId === orgId)
          .map((b) => ({ id: b.id, googlePlaceId: b.googlePlaceId, name: b.name, address: b.address }));
      },
      async create(args: any) {
        const b: FakeTrackedBusiness = {
          id: nextId('biz'),
          orgId: args.data.orgId,
          googlePlaceId: args.data.googlePlaceId ?? null,
          name: args.data.name,
          address: args.data.address ?? null,
          searchUrl: args.data.searchUrl ?? null,
          logoUrl: args.data.logoUrl ?? null,
          isOwn: args.data.isOwn ?? false,
        };
        businesses.push(b);
        return { id: b.id };
      },
      async update(args: any) {
        const b = businesses.find((x) => x.id === args.where.id);
        if (!b) throw new Error('fake trackedBusiness.update: not found');
        Object.assign(b, args.data);
        return b;
      },
    },
    metricMonth: {
      async findUnique(args: any) {
        const key = args.where.trackedBusinessId_metricType_year_month;
        const m = metrics.find(
          (x) =>
            x.trackedBusinessId === key.trackedBusinessId &&
            x.metricType === key.metricType &&
            x.year === key.year &&
            x.month === key.month
        );
        return m ?? null;
      },
      async create(args: any) {
        const m: FakeMetricMonth = {
          id: nextId('metric'),
          trackedBusinessId: args.data.trackedBusinessId,
          metricType: args.data.metricType,
          year: args.data.year,
          month: args.data.month,
          total: args.data.total,
          daily: args.data.daily ?? null,
          yoyPercent: args.data.yoyPercent ?? null,
          breakdown: args.data.breakdown ?? null,
          searchTerms: args.data.searchTerms ?? null,
          isDerived: args.data.isDerived ?? false,
          source: args.data.source ?? 'extension',
          collectedAt: args.data.collectedAt ?? null,
        };
        metrics.push(m);
        return m;
      },
      async update(args: any) {
        const key = args.where.trackedBusinessId_metricType_year_month;
        const m = metrics.find(
          (x) =>
            x.trackedBusinessId === key.trackedBusinessId &&
            x.metricType === key.metricType &&
            x.year === key.year &&
            x.month === key.month
        );
        if (!m) throw new Error('fake metricMonth.update: not found');
        // Mirror `?? undefined` semantics: keys absent from data leave the
        // stored value untouched.
        for (const [k, v] of Object.entries(args.data)) {
          if (v !== undefined) (m as any)[k] = v;
        }
        return m;
      },
    },
  };

  const prisma = {
    $transaction: async (fn: (tx: any) => Promise<unknown>) => fn(tx),
  };

  return { prisma, businesses, metrics };
}

// ── Stub `../index` in the require cache before importing the services ─────

const fake = makeFakePrisma();
const indexPath = require.resolve(path.join(__dirname, '..', 'src', 'index'));
(require.cache as any)[indexPath] = {
  id: indexPath,
  filename: indexPath,
  loaded: true,
  exports: { prisma: fake.prisma },
};

// Now safe to import — both pull `{ prisma }` from '../index', which resolves
// to the cache entry just installed above.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ingestMetricMonths } = require('../src/services/metrics-intel.service');

async function main() {
  // ── 1. Same payload ingested twice → one row, second call updates ────────
  {
    const biz = {
      name: 'Test Business One',
      googlePlaceId: 'gpid-1',
      metrics: [{ metricType: 'overview', year: 2026, month: 1, total: 100 }],
    };

    const s1 = await ingestMetricMonths('org-1', [biz]);
    eq(s1.metricsCreated, 1, 'case 1: first call creates');
    eq(s1.metricsUpdated, 0, 'case 1: first call has no updates');

    const rowsAfterFirst = fake.metrics.filter((m) => m.metricType === 'overview' && m.year === 2026 && m.month === 1);
    eq(rowsAfterFirst.length, 1, 'case 1: exactly one row after first call');

    const s2 = await ingestMetricMonths('org-1', [biz]);
    eq(s2.metricsCreated, 0, 'case 1: second call creates nothing');
    eq(s2.metricsUpdated, 1, 'case 1: second call updates the existing row');

    const rowsAfterSecond = fake.metrics.filter((m) => m.metricType === 'overview' && m.year === 2026 && m.month === 1);
    eq(rowsAfterSecond.length, 1, 'case 1: still exactly one row after second call');
  }

  // ── 2. Derived incoming does not overwrite an existing scraped row ──────
  {
    const scraped = {
      name: 'Test Business Two',
      googlePlaceId: 'gpid-2',
      metrics: [{ metricType: 'calls', year: 2026, month: 2, total: 50, isDerived: false }],
    };
    const s1 = await ingestMetricMonths('org-2', [scraped]);
    eq(s1.metricsCreated, 1, 'case 2: scraped row created');

    const derived = {
      name: 'Test Business Two',
      googlePlaceId: 'gpid-2',
      metrics: [{ metricType: 'calls', year: 2026, month: 2, total: 999, isDerived: true }],
    };
    const s2 = await ingestMetricMonths('org-2', [derived]);
    eq(s2.metricsSkipped, 1, 'case 2: derived incoming is skipped');
    eq(s2.metricsUpdated, 0, 'case 2: derived incoming does not update');

    const row = fake.metrics.find((m) => m.metricType === 'calls' && m.year === 2026 && m.month === 2)!;
    eq(row.total, 50, 'case 2: stored total is unchanged (still scraped value)');
    eq(row.isDerived, false, 'case 2: stored row is still marked scraped');
  }

  // ── 3. Scraped incoming does overwrite an existing derived row ──────────
  {
    const derived = {
      name: 'Test Business Three',
      googlePlaceId: 'gpid-3',
      metrics: [{ metricType: 'bookings', year: 2026, month: 3, total: 10, isDerived: true }],
    };
    const s1 = await ingestMetricMonths('org-3', [derived]);
    eq(s1.metricsCreated, 1, 'case 3: derived row created');

    const scraped = {
      name: 'Test Business Three',
      googlePlaceId: 'gpid-3',
      metrics: [{ metricType: 'bookings', year: 2026, month: 3, total: 12, isDerived: false }],
    };
    const s2 = await ingestMetricMonths('org-3', [scraped]);
    eq(s2.metricsUpdated, 1, 'case 3: scraped incoming updates the derived row');
    eq(s2.metricsSkipped, 0, 'case 3: nothing skipped');

    const row = fake.metrics.find((m) => m.metricType === 'bookings' && m.year === 2026 && m.month === 3)!;
    eq(row.total, 12, 'case 3: stored total is the scraped value');
    eq(row.isDerived, false, 'case 3: stored row is now marked scraped');
  }

  // ── 4. Older collectedAt is skipped; newer collectedAt updates ──────────
  {
    const base = {
      name: 'Test Business Four',
      googlePlaceId: 'gpid-4',
    };
    const t2 = new Date('2026-01-15T00:00:00Z');
    const t1 = new Date('2026-01-10T00:00:00Z'); // older than t2
    const t3 = new Date('2026-01-20T00:00:00Z'); // newer than t2

    const s1 = await ingestMetricMonths('org-4', [
      { ...base, metrics: [{ metricType: 'directions', year: 2026, month: 4, total: 30, collectedAt: t2 }] },
    ]);
    eq(s1.metricsCreated, 1, 'case 4: initial row created with collectedAt=t2');

    const sOlder = await ingestMetricMonths('org-4', [
      { ...base, metrics: [{ metricType: 'directions', year: 2026, month: 4, total: 999, collectedAt: t1 }] },
    ]);
    eq(sOlder.metricsSkipped, 1, 'case 4: older collectedAt is skipped');
    eq(sOlder.metricsUpdated, 0, 'case 4: older collectedAt does not update');

    const rowAfterOlder = fake.metrics.find((m) => m.metricType === 'directions' && m.year === 2026 && m.month === 4)!;
    eq(rowAfterOlder.total, 30, 'case 4: total unchanged after older collectedAt attempt');

    const sNewer = await ingestMetricMonths('org-4', [
      { ...base, metrics: [{ metricType: 'directions', year: 2026, month: 4, total: 40, collectedAt: t3 }] },
    ]);
    eq(sNewer.metricsUpdated, 1, 'case 4: newer collectedAt updates');
    eq(sNewer.metricsSkipped, 0, 'case 4: newer collectedAt is not skipped');

    const rowAfterNewer = fake.metrics.find((m) => m.metricType === 'directions' && m.year === 2026 && m.month === 4)!;
    eq(rowAfterNewer.total, 40, 'case 4: total updated after newer collectedAt');
  }

  // ── 5. Two metric types × two months → 4 rows, 1 business ───────────────
  {
    const biz = {
      name: 'Test Business Five',
      googlePlaceId: 'gpid-5',
      metrics: [
        { metricType: 'website_clicks', year: 2026, month: 1, total: 1 },
        { metricType: 'website_clicks', year: 2026, month: 2, total: 2 },
        { metricType: 'chat_clicks', year: 2026, month: 1, total: 3 },
        { metricType: 'chat_clicks', year: 2026, month: 2, total: 4 },
      ],
    };

    const s = await ingestMetricMonths('org-5', [biz]);
    eq(s.businessesCreated, 1, 'case 5: exactly one business created');
    eq(s.businessesUpdated, 0, 'case 5: no business updates');
    eq(s.metricsCreated, 4, 'case 5: four metric rows created');

    const bizRow = fake.businesses.find((b) => b.googlePlaceId === 'gpid-5')!;
    const rows = fake.metrics.filter((m) => m.trackedBusinessId === bizRow.id);
    eq(rows.length, 4, 'case 5: exactly four rows stored for this business');
  }

  console.log(`ALL TESTS PASSED (${assertCount} assertions)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
