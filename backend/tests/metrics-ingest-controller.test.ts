/**
 * metrics-ingest-controller.test.ts — plain-Node/ts-node assertions for
 * POST /api/ingest/metrics (task A3): validation + auth-guard + controller
 * logic in metrics-ingest.controller.ts, tested as plain functions.
 *
 * Same style as backend/tests/metrics-intel.test.ts and
 * backend/tests/backfill-sqlite-metrics.test.ts: assert(), run directly,
 * print "ALL TESTS PASSED" on success. No live DB, no live HTTP server —
 * the Express req/res objects are hand-built fakes and `../index` (the
 * Express/Prisma bootstrap module) is stubbed in Node's require cache with
 * an in-memory fake Prisma before the controller is imported.
 *
 * Run:  npx ts-node tests/metrics-ingest-controller.test.ts   (from backend/)
 */
'use strict';

import path from 'path';
import { Request, Response, NextFunction } from 'express';

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
//
// Covers everything the controller's downstream calls touch:
//   - resolveOrgId (intel.service.ts)     -> membership.findFirst, user.findUnique
//   - ingestMetricMonths (metrics-intel.service.ts) -> $transaction, trackedBusiness.*, metricMonth.*
//   - logAudit (audit.middleware.ts)      -> auditLog.create (errors are swallowed internally)

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
  const auditLogEntries: any[] = [];
  let transactionCalls = 0;

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
        for (const [k, v] of Object.entries(args.data)) {
          if (v !== undefined) (m as any)[k] = v;
        }
        return m;
      },
    },
  };

  const prisma = {
    $transaction: async (fn: (t: any) => Promise<unknown>) => {
      transactionCalls++;
      return fn(tx);
    },
    membership: {
      async findFirst(_args: any) {
        // Every test user already has a membership -> resolveOrgId short-circuits
        // to this orgId without needing prisma.user.findUnique/create.
        return { orgId: 'org-test' };
      },
    },
    user: {
      async findUnique(_args: any) {
        return { email: 'test@example.com' };
      },
    },
    auditLog: {
      async create(args: any) {
        auditLogEntries.push(args.data);
        return args.data;
      },
    },
  };

  return { prisma, businesses, metrics, auditLogEntries, transactionCallsRef: () => transactionCalls };
}

// ── Stub `../index` in the require cache before importing the controller ───

const fake = makeFakePrisma();
const indexPath = require.resolve(path.join(__dirname, '..', 'src', 'index'));
(require.cache as any)[indexPath] = {
  id: indexPath,
  filename: indexPath,
  loaded: true,
  exports: { prisma: fake.prisma },
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ingestMetrics } = require('../src/controllers/metrics-ingest.controller');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ValidationError, AuthenticationError } = require('../src/utils/errors');

// ── Fake Express req/res/next ───────────────────────────────────────────────

function fakeReq(body: unknown, opts: { authed?: boolean } = {}): Request {
  const authed = opts.authed ?? true;
  const req: any = {
    body,
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
    get: (_header: string) => undefined,
  };
  if (authed) {
    req.user = { id: 'user-1', email: 'test@example.com' };
    req.apiKey = 'zx_abc...';
  }
  return req as Request;
}

function fakeRes(): Response & { _status?: number; _json?: any } {
  const res: any = {
    status(code: number) {
      res._status = code;
      return res;
    },
    json(payload: any) {
      res._json = payload;
      return res;
    },
  };
  return res as Response & { _status?: number; _json?: any };
}

/** Invoke the asyncHandler-wrapped controller and capture whatever next() got. */
async function invoke(body: unknown, opts: { authed?: boolean } = {}) {
  const req = fakeReq(body, opts);
  const res = fakeRes();
  let capturedError: unknown;
  const next: NextFunction = (err?: unknown) => {
    capturedError = err;
  };
  await ingestMetrics(req, res, next);
  // asyncHandler resolves the promise internally via Promise.resolve(fn(...)).catch(next);
  // give the microtask queue a tick so a rejected promise's .catch(next) has run.
  await new Promise((resolve) => setImmediate(resolve));
  return { req, res, error: capturedError };
}

function validPayload() {
  return {
    businesses: [
      {
        name: 'Acme Dental',
        googlePlaceId: 'gpid-acme',
        metrics: [
          { metricType: 'overview', year: 2026, month: 7, total: 1234 },
        ],
      },
    ],
  };
}

async function main() {
  const transactionsBefore1 = fake.transactionCallsRef();

  // ── 1. Missing req.user (legacy static key path) → AuthenticationError,
  //       and ingestMetricMonths (via $transaction) is never called. ────────
  {
    const before = fake.transactionCallsRef();
    const { error } = await invoke(validPayload(), { authed: false });
    assert(error instanceof AuthenticationError, 'case 1: AuthenticationError thrown for missing req.user');
    eq(fake.transactionCallsRef(), before, 'case 1: ingestMetricMonths (transaction) never called');
  }

  // ── 2. Unknown metricType ("views" — the old controller's vocabulary) ───
  {
    const payload = {
      businesses: [
        {
          name: 'Acme Dental',
          metrics: [{ metricType: 'views', year: 2026, month: 7, total: 10 }],
        },
      ],
    };
    const { error } = await invoke(payload);
    assert(error instanceof ValidationError, 'case 2: ValidationError thrown for unknown metricType');
    assert(
      typeof (error as Error).message === 'string' && (error as Error).message.includes('views'),
      'case 2: error message names the offending value ("views")'
    );
  }

  // ── 3. month: 13, month: 0, total: -1 each → ValidationError ────────────
  {
    const badMonth13 = {
      businesses: [
        { name: 'B', metrics: [{ metricType: 'overview', year: 2026, month: 13, total: 1 }] },
      ],
    };
    const r1 = await invoke(badMonth13);
    assert(r1.error instanceof ValidationError, 'case 3: month=13 -> ValidationError');

    const badMonth0 = {
      businesses: [
        { name: 'B', metrics: [{ metricType: 'overview', year: 2026, month: 0, total: 1 }] },
      ],
    };
    const r2 = await invoke(badMonth0);
    assert(r2.error instanceof ValidationError, 'case 3: month=0 -> ValidationError');

    const badTotal = {
      businesses: [
        { name: 'B', metrics: [{ metricType: 'overview', year: 2026, month: 1, total: -1 }] },
      ],
    };
    const r3 = await invoke(badTotal);
    assert(r3.error instanceof ValidationError, 'case 3: total=-1 -> ValidationError');
  }

  // ── 4. collectedAt absent -> Date roughly equal to now (Date, > epoch 0) ─
  {
    const payload = {
      businesses: [
        {
          name: 'Collected At Absent Co',
          googlePlaceId: 'gpid-caa',
          metrics: [{ metricType: 'overview', year: 2026, month: 5, total: 7 }],
        },
      ],
    };
    const before = Date.now();
    const { error, res } = await invoke(payload);
    const after = Date.now();
    assert(error === undefined, `case 4: no error thrown (got ${error})`);
    eq(res._status, 200, 'case 4: responds 200');

    const row = fake.metrics.find(
      (m) => m.metricType === 'overview' && m.year === 2026 && m.month === 5 &&
        fake.businesses.find((b) => b.id === m.trackedBusinessId)?.googlePlaceId === 'gpid-caa'
    )!;
    assert(row !== undefined, 'case 4: row was persisted');
    assert(row.collectedAt instanceof Date, 'case 4: collectedAt is a Date');
    assert(row.collectedAt!.getTime() > 0, 'case 4: collectedAt is after epoch 0');
    assert(
      row.collectedAt!.getTime() >= before - 1000 && row.collectedAt!.getTime() <= after + 1000,
      'case 4: collectedAt is roughly now'
    );
  }

  // ── 5. collectedAt present but garbage ("not-a-date") -> falls back to a
  //       Date, does not throw. ───────────────────────────────────────────
  {
    const payload = {
      businesses: [
        {
          name: 'Garbage Date Co',
          googlePlaceId: 'gpid-gd',
          metrics: [
            {
              metricType: 'calls',
              year: 2026,
              month: 6,
              total: 3,
              collectedAt: 'not-a-date',
            },
          ],
        },
      ],
    };
    const { error, res } = await invoke(payload);
    assert(error === undefined, `case 5: no error thrown for garbage collectedAt (got ${error})`);
    eq(res._status, 200, 'case 5: responds 200');

    const row = fake.metrics.find(
      (m) => m.metricType === 'calls' && m.year === 2026 && m.month === 6 &&
        fake.businesses.find((b) => b.id === m.trackedBusinessId)?.googlePlaceId === 'gpid-gd'
    )!;
    assert(row !== undefined, 'case 5: row was persisted');
    assert(row.collectedAt instanceof Date, 'case 5: collectedAt falls back to a Date');
    assert(!isNaN(row.collectedAt!.getTime()), 'case 5: fallback Date is valid (not Invalid Date)');
  }

  // ── 6. daily of length 32 -> ValidationError ─────────────────────────────
  {
    const payload = {
      businesses: [
        {
          name: 'Daily Overflow Co',
          metrics: [
            {
              metricType: 'overview',
              year: 2026,
              month: 7,
              total: 5,
              daily: Array.from({ length: 32 }, (_, i) => i),
            },
          ],
        },
      ],
    };
    const { error } = await invoke(payload);
    assert(error instanceof ValidationError, 'case 6: daily.length=32 -> ValidationError');
  }

  // ── 7. Valid two-business payload -> ingestMetricMonths called once with
  //       both, response is { ok: true, summary }. ────────────────────────
  {
    const payload = {
      businesses: [
        {
          name: 'Two Biz A',
          googlePlaceId: 'gpid-two-a',
          metrics: [{ metricType: 'overview', year: 2026, month: 1, total: 10 }],
        },
        {
          name: 'Two Biz B',
          googlePlaceId: 'gpid-two-b',
          metrics: [{ metricType: 'calls', year: 2026, month: 2, total: 20 }],
        },
      ],
    };
    const transactionsBefore = fake.transactionCallsRef();
    const { error, res } = await invoke(payload);
    assert(error === undefined, `case 7: no error thrown (got ${error})`);
    eq(res._status, 200, 'case 7: responds 200');
    assert(res._json?.ok === true, 'case 7: response has ok: true');
    assert(res._json?.summary !== undefined, 'case 7: response has a summary');
    eq(res._json.summary.businessesCreated, 2, 'case 7: both businesses created');
    eq(res._json.summary.metricsCreated, 2, 'case 7: both metrics created');
    // ingestMetricMonths is called once per invocation (loops internally over
    // businesses); one call to ingestMetrics -> one call to the service ->
    // one $transaction per business (2 businesses -> 2 transaction calls).
    eq(
      fake.transactionCallsRef() - transactionsBefore,
      2,
      'case 7: one $transaction per business (both businesses processed in this single ingestMetricMonths call)'
    );
  }

  console.log(`ALL TESTS PASSED (${assertCount} assertions)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
