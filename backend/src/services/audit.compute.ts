/**
 * Review Audit — Phase 3 computation engine (pure core).
 *
 * Turns the raw ScrapedReview / ProfileSnapshot rows that the extension ingests
 * into the velocity timeline + authenticity signals that power the deep-audit
 * view and (Phase 4) the server-side report.
 *
 * IMPORTANT — neutral framing. Every "signal" here is an INTERNAL aggregate, not
 * a determination of fraud. Naming, the `disclaimer` field, and any caller-facing
 * copy must stay neutral ("internal signal", "not a determination of authenticity")
 * — never a public "fake/bought reviews" accusation.
 *
 * Every function in this file is pure (array in → object out, no DB, no clock
 * beyond the caller-supplied `now`) so the engine is unit-testable in isolation.
 * The DB-bound entry point lives in audit.service.ts.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

/** Normalised review shape the pure functions operate on. */
export interface AuditReview {
  rating: number;
  text: string | null;
  reviewedAt: Date | null;
  isLocalGuide: boolean;
  hasPhoto: boolean;
  ownerResponded: boolean;
  authorReviewCount: number | null;
}

export interface VelocityPoint {
  month: string; // 'YYYY-MM'
  monthlyCount: number; // reviews dated within this month
  cumulativeCount: number; // running total up to and including this month
  rollingAvgRating: number | null; // running mean rating up to and including this month
}

export interface VelocityAnomaly {
  month: string;
  monthlyCount: number;
  baseline: number; // median monthly count across active months
  ratio: number; // monthlyCount / baseline (rounded to 2dp)
}

export interface RatingDistribution {
  1: number;
  2: number;
  3: number;
  4: number;
  5: number;
}

export interface AuthenticitySignals {
  scrapedReviewCount: number;
  displayRating: number | null; // rating Google shows on the profile
  trueAverage: number | null; // mean of the scraped review ratings
  ratingDelta: number | null; // trueAverage − displayRating
  ratingDistribution: RatingDistribution;
  localGuidePct: number; // % of reviews authored by Local Guides
  withPhotoPct: number; // % of reviews that include a photo
  noTextPct: number; // % of reviews with no text body (rating-only)
  ownerResponseRate: number; // % of reviews with an owner response
  avgReviewerContribution: number | null; // avg reviews-per-reviewer (network signal)
  singleReviewAuthorPct: number | null; // % of authors whose total contribution is 1 review
}

export interface KeywordFreq {
  term: string;
  count: number;
}

export interface AuditResult {
  generatedAt: string;
  reviewSampleSize: number; // reviews actually available to the engine (may be < totalReviews)
  datedSampleSize: number; // reviews carrying a usable reviewedAt (drives the timeline)
  dateRange: { from: string | null; to: string | null };
  velocity: VelocityPoint[];
  velocityAnomalies: VelocityAnomaly[];
  signals: AuthenticitySignals;
  keywords: { unigrams: KeywordFreq[]; bigrams: KeywordFreq[] };
  disclaimer: string;
}

const DISCLAIMER =
  'These are internal aggregate signals computed from a sample of public reviews. ' +
  'They are not a determination of review authenticity or fraud.';

// ── Small helpers ───────────────────────────────────────────────────────────

const round = (n: number, dp = 2): number => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

const pct = (count: number, total: number): number =>
  total === 0 ? 0 : round((count / total) * 100, 1);

const monthKey = (d: Date): string =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

const median = (nums: number[]): number => {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};

// ── Velocity timeline ─────────────────────────────────────────────────────────

/**
 * Monthly velocity timeline. Only reviews with a `reviewedAt` contribute.
 * Months with zero reviews between the first and last dated review are filled
 * in so the cumulative line and any charting stays continuous.
 */
export function computeVelocityTimeline(reviews: AuditReview[]): VelocityPoint[] {
  const dated = reviews
    .filter((r) => r.reviewedAt instanceof Date && !isNaN(r.reviewedAt.getTime()))
    .sort((a, b) => a.reviewedAt!.getTime() - b.reviewedAt!.getTime());

  if (dated.length === 0) return [];

  // Bucket counts + rating sums by month.
  const monthly = new Map<string, { count: number; ratingSum: number }>();
  for (const r of dated) {
    const key = monthKey(r.reviewedAt!);
    const bucket = monthly.get(key) ?? { count: 0, ratingSum: 0 };
    bucket.count += 1;
    bucket.ratingSum += r.rating;
    monthly.set(key, bucket);
  }

  // Walk every month from first to last so gaps render as zero-count points.
  const first = dated[0].reviewedAt!;
  const last = dated[dated.length - 1].reviewedAt!;
  const cursor = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1));
  const end = new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), 1));

  const out: VelocityPoint[] = [];
  let cumulativeCount = 0;
  let cumulativeRatingSum = 0;
  while (cursor <= end) {
    const key = monthKey(cursor);
    const bucket = monthly.get(key);
    const monthlyCount = bucket?.count ?? 0;
    cumulativeCount += monthlyCount;
    cumulativeRatingSum += bucket?.ratingSum ?? 0;
    out.push({
      month: key,
      monthlyCount,
      cumulativeCount,
      rollingAvgRating: cumulativeCount > 0 ? round(cumulativeRatingSum / cumulativeCount, 2) : null,
    });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return out;
}

/**
 * Flag months whose review count is an outlier versus the typical (median) active
 * month. Neutral signal: a burst may be a marketing push, press mention, or noise.
 */
export function computeVelocityAnomalies(
  timeline: VelocityPoint[],
  { minRatio = 3, minCount = 3 }: { minRatio?: number; minCount?: number } = {}
): VelocityAnomaly[] {
  const activeCounts = timeline.filter((p) => p.monthlyCount > 0).map((p) => p.monthlyCount);
  if (activeCounts.length < 3) return []; // too little history to judge a baseline

  const baseline = median(activeCounts) || 1;
  return timeline
    .filter((p) => p.monthlyCount >= minCount && p.monthlyCount / baseline >= minRatio)
    .map((p) => ({
      month: p.month,
      monthlyCount: p.monthlyCount,
      baseline: round(baseline, 2),
      ratio: round(p.monthlyCount / baseline, 2),
    }));
}

// ── Authenticity signals ────────────────────────────────────────────────────

export function computeAuthenticitySignals(
  reviews: AuditReview[],
  displayRating: number | null
): AuthenticitySignals {
  const n = reviews.length;

  const ratingDistribution: RatingDistribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let ratingSum = 0;
  let localGuides = 0;
  let withPhoto = 0;
  let noText = 0;
  let ownerResponses = 0;

  const contributions: number[] = [];
  let singleReviewAuthors = 0;
  let authorsWithCount = 0;

  for (const r of reviews) {
    if (r.rating >= 1 && r.rating <= 5) {
      ratingDistribution[r.rating as 1 | 2 | 3 | 4 | 5] += 1;
      ratingSum += r.rating;
    }
    if (r.isLocalGuide) localGuides += 1;
    if (r.hasPhoto) withPhoto += 1;
    if (!r.text || r.text.trim().length === 0) noText += 1;
    if (r.ownerResponded) ownerResponses += 1;
    if (typeof r.authorReviewCount === 'number' && r.authorReviewCount > 0) {
      contributions.push(r.authorReviewCount);
      authorsWithCount += 1;
      if (r.authorReviewCount === 1) singleReviewAuthors += 1;
    }
  }

  const trueAverage = n > 0 ? round(ratingSum / n, 2) : null;
  const avgReviewerContribution =
    contributions.length > 0
      ? round(contributions.reduce((s, c) => s + c, 0) / contributions.length, 2)
      : null;

  return {
    scrapedReviewCount: n,
    displayRating,
    trueAverage,
    ratingDelta: trueAverage != null && displayRating != null ? round(trueAverage - displayRating, 2) : null,
    ratingDistribution,
    localGuidePct: pct(localGuides, n),
    withPhotoPct: pct(withPhoto, n),
    noTextPct: pct(noText, n),
    ownerResponseRate: pct(ownerResponses, n),
    avgReviewerContribution,
    singleReviewAuthorPct: authorsWithCount > 0 ? pct(singleReviewAuthors, authorsWithCount) : null,
  };
}

// ── Keyword frequencies ───────────────────────────────────────────────────────

// Minimal English stopword set — enough to keep the top-terms list meaningful
// without pulling in a dependency.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'was', 'were', 'with', 'this', 'that', 'they', 'them',
  'have', 'has', 'had', 'not', 'but', 'you', 'your', 'our', 'their', 'his', 'her',
  'from', 'all', 'any', 'can', 'will', 'would', 'should', 'could', 'been', 'being',
  'who', 'what', 'when', 'where', 'which', 'how', 'why', 'too', 'very', 'just', 'than',
  'then', 'there', 'here', 'out', 'about', 'into', 'over', 'also', 'more', 'most',
  'some', 'such', 'only', 'own', 'same', 'each', 'few', 'other', 'its', 'it’s',
  'i', 'me', 'my', 'we', 'us', 'he', 'she', 'it', 'is', 'be', 'do', 'did', 'does',
  'a', 'an', 'of', 'to', 'in', 'on', 'at', 'as', 'by', 'or', 'if', 'so', 'up',
  'get', 'got', 'them', 'were', 'because', 'while', 'after', 'before', 'again',
]);

const tokenize = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9'’\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !/^\d+$/.test(t) && !STOPWORDS.has(t));

/**
 * Top 1-word and 2-word frequencies across review text. Untrusted text is only
 * ever measured (counted) here — never interpreted or executed.
 */
export function computeKeywords(
  reviews: AuditReview[],
  { topN = 20 }: { topN?: number } = {}
): { unigrams: KeywordFreq[]; bigrams: KeywordFreq[] } {
  const uni = new Map<string, number>();
  const bi = new Map<string, number>();

  for (const r of reviews) {
    if (!r.text) continue;
    const tokens = tokenize(r.text);
    for (let i = 0; i < tokens.length; i++) {
      uni.set(tokens[i], (uni.get(tokens[i]) ?? 0) + 1);
      if (i + 1 < tokens.length) {
        const gram = `${tokens[i]} ${tokens[i + 1]}`;
        bi.set(gram, (bi.get(gram) ?? 0) + 1);
      }
    }
  }

  const topTerms = (m: Map<string, number>): KeywordFreq[] =>
    [...m.entries()]
      .filter(([, count]) => count > 1) // drop hapax noise
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, topN)
      .map(([term, count]) => ({ term, count }));

  return { unigrams: topTerms(uni), bigrams: topTerms(bi) };
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export function computeAudit(
  reviews: AuditReview[],
  displayRating: number | null,
  now: Date = new Date()
): AuditResult {
  const velocity = computeVelocityTimeline(reviews);
  const velocityAnomalies = computeVelocityAnomalies(velocity);
  const dated = reviews.filter(
    (r) => r.reviewedAt instanceof Date && !isNaN(r.reviewedAt.getTime())
  );
  const sortedDates = dated
    .map((r) => r.reviewedAt!.getTime())
    .sort((a, b) => a - b);

  return {
    generatedAt: now.toISOString(),
    reviewSampleSize: reviews.length,
    datedSampleSize: dated.length,
    dateRange: {
      from: sortedDates.length ? new Date(sortedDates[0]).toISOString().slice(0, 10) : null,
      to: sortedDates.length ? new Date(sortedDates[sortedDates.length - 1]).toISOString().slice(0, 10) : null,
    },
    velocity,
    velocityAnomalies,
    signals: computeAuthenticitySignals(reviews, displayRating),
    keywords: computeKeywords(reviews),
    disclaimer: DISCLAIMER,
  };
}
