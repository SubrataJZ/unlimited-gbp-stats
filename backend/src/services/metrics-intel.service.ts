import { prisma } from '../index';
import { resolveTrackedBusiness } from './intel.service';

// ── Types mirroring the validated request payload ─────────────────────────────

export interface IncomingMetricMonth {
  metricType: string; // trusted; A3 validates the vocabulary at the boundary
  year: number;
  month: number; // 1-12
  total: number;
  daily?: number[];
  yoyPercent?: number | null;
  breakdown?: Record<string, number>;
  searchTerms?: Array<{ term: string; count: number }>;
  isDerived?: boolean;
  source?: string; // default 'extension'
  collectedAt?: Date;
}

export interface IncomingMetricsBusiness {
  name: string;
  googlePlaceId?: string;
  address?: string;
  searchUrl?: string;
  logoUrl?: string;
  isOwn?: boolean;
  metrics: IncomingMetricMonth[];
}

export interface MetricsIngestSummary {
  businessesCreated: number;
  businessesUpdated: number;
  metricsCreated: number;
  metricsUpdated: number;
  metricsSkipped: number; // rejected by the merge rule
}

/**
 * Idempotently ingest an array of businesses' monthly GBP performance metrics
 * into the database for a given organization.
 *
 * Each business is wrapped in its own transaction so one failure does not
 * roll back the entire batch. Mirrors the structure of `ingestIntel` in
 * intel.service.ts.
 */
export async function ingestMetricMonths(
  orgId: string,
  businesses: IncomingMetricsBusiness[]
): Promise<MetricsIngestSummary> {
  const summary: MetricsIngestSummary = {
    businessesCreated: 0,
    businessesUpdated: 0,
    metricsCreated: 0,
    metricsUpdated: 0,
    metricsSkipped: 0,
  };

  for (const biz of businesses) {
    await prisma.$transaction(async (tx) => {
      // ── a. Resolve / upsert TrackedBusiness ──────────────────────────────

      const { trackedBusinessId, isNew: bizIsNew } = await resolveTrackedBusiness(
        tx,
        orgId,
        biz
      );

      if (bizIsNew) {
        summary.businessesCreated++;
      } else {
        summary.businessesUpdated++;
      }

      // ── b. Merge MetricMonth rows ──────────────────────────────────────

      for (const m of biz.metrics ?? []) {
        const existing = await tx.metricMonth.findUnique({
          where: {
            trackedBusinessId_metricType_year_month: {
              trackedBusinessId,
              metricType: m.metricType,
              year: m.year,
              month: m.month,
            },
          },
        });

        const incomingIsDerived = m.isDerived ?? false;

        if (!existing) {
          await tx.metricMonth.create({
            data: {
              trackedBusinessId,
              metricType: m.metricType,
              year: m.year,
              month: m.month,
              total: m.total,
              daily: m.daily ?? undefined,
              yoyPercent: m.yoyPercent ?? undefined,
              breakdown: m.breakdown ?? undefined,
              searchTerms: m.searchTerms ?? undefined,
              isDerived: incomingIsDerived,
              source: m.source ?? 'extension',
              collectedAt: m.collectedAt ?? undefined,
            },
          });
          summary.metricsCreated++;
          continue;
        }

        // Merge rule (see metrics-intel.service.ts task spec, Step 3):
        //  - existing derived, incoming scraped → update (scraped beats derived)
        //  - existing scraped, incoming derived → skip
        //  - same isDerived → compare collectedAt (newer wins; missing/equal → update)
        let shouldUpdate: boolean;

        if (existing.isDerived && !incomingIsDerived) {
          shouldUpdate = true;
        } else if (!existing.isDerived && incomingIsDerived) {
          shouldUpdate = false;
        } else {
          const existingCollectedAt = existing.collectedAt;
          const incomingCollectedAt = m.collectedAt;

          if (!incomingCollectedAt || !existingCollectedAt) {
            shouldUpdate = true;
          } else {
            const incomingTime = incomingCollectedAt.getTime();
            const existingTime = existingCollectedAt.getTime();
            shouldUpdate = incomingTime >= existingTime;
          }
        }

        if (!shouldUpdate) {
          summary.metricsSkipped++;
          continue;
        }

        await tx.metricMonth.update({
          where: {
            trackedBusinessId_metricType_year_month: {
              trackedBusinessId,
              metricType: m.metricType,
              year: m.year,
              month: m.month,
            },
          },
          data: {
            total: m.total,
            daily: m.daily ?? undefined,
            yoyPercent: m.yoyPercent ?? undefined,
            breakdown: m.breakdown ?? undefined,
            searchTerms: m.searchTerms ?? undefined,
            isDerived: incomingIsDerived,
            source: m.source ?? undefined,
            collectedAt: m.collectedAt ?? undefined,
          },
        });
        summary.metricsUpdated++;
      }
    });
  }

  return summary;
}
