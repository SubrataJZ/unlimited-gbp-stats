/**
 * Shapes the sync bundle (getSyncBundleForOrg) into what the web dashboard
 * needs: monthly numbers, the latest rating, and a few recent reviews per
 * business. Pure — no Prisma — so it is testable without a database.
 *
 * The full bundle can carry thousands of reviews (DC Chinese restaurant: 3100);
 * a phone only needs the newest few, so they are cut here, not in the browser.
 */

export const RECENT_REVIEWS = 5;
const REVIEW_TEXT_CHARS = 300;

interface BundleBusiness {
  id: string;
  name: string;
  googlePlaceId: string | null;
  isOwn: boolean;
  metrics: Array<{ metricType: string; year: number; month: number; total: number; isDerived: boolean }>;
  snapshots: Array<{ capturedOn: Date | string; totalReviews: number; displayRating: number | null }>;
  reviews: Array<{
    rating: number;
    text: string | null;
    authorName: string | null;
    ownerResponded: boolean;
    reviewedAt: Date | string | null;
  }>;
}

export interface DashboardBusiness {
  id: string;
  name: string;
  isOwn: boolean;
  /** [metricType, year, month, total, isEstimate] — compact; a business can have hundreds */
  metrics: Array<[string, number, number, number, boolean]>;
  rating: number | null;
  totalReviews: number | null;
  reviews: Array<{ rating: number; text: string; author: string; at: string | null; replied: boolean }>;
}

const time = (d: Date | string | null) => (d ? new Date(d).getTime() : 0);

export function shapeDashboard(bundle: BundleBusiness[]): DashboardBusiness[] {
  return bundle
    .map((b) => {
      const latest = [...b.snapshots].sort((x, y) => time(y.capturedOn) - time(x.capturedOn))[0];
      const reviews = [...b.reviews]
        .sort((x, y) => time(y.reviewedAt) - time(x.reviewedAt))
        .slice(0, RECENT_REVIEWS)
        .map((r) => ({
          rating: r.rating,
          text: (r.text || '').slice(0, REVIEW_TEXT_CHARS),
          author: r.authorName || 'Anonymous',
          at: r.reviewedAt ? new Date(r.reviewedAt).toISOString() : null,
          replied: r.ownerResponded,
        }));
      return {
        id: b.id,
        name: b.name,
        isOwn: b.isOwn,
        metrics: b.metrics.map(
          (m) => [m.metricType, m.year, m.month, m.total, m.isDerived] as [string, number, number, number, boolean]
        ),
        rating: latest?.displayRating ?? null,
        totalReviews: latest?.totalReviews ?? null,
        reviews,
      };
    })
    // Own businesses first, then those with performance data, then by name.
    .sort((a, b) =>
      Number(b.isOwn) - Number(a.isOwn) ||
      Number(b.metrics.length > 0) - Number(a.metrics.length > 0) ||
      a.name.localeCompare(b.name)
    );
}
