import { prisma } from '../index';
import { AuthorizationError, NotFoundError } from '../utils/errors';
import logger from '../utils/logger';
import { AuditReview, AuditResult, computeAudit } from './audit.compute';

// Re-export the engine's public types so callers can import from one place.
export * from './audit.compute';

/**
 * Load a tracked business's reviews + latest snapshot and compute its audit.
 *
 * Deep-audit is an Agency/Pro capability — OWNER_READONLY members are denied
 * (the read-only Owner tier gets metrics/graphs, not the competitor deep audit).
 *
 * @throws AuthorizationError when the member's role may not run a deep audit
 * @throws NotFoundError       when the business does not belong to this org
 */
export async function getAuditForBusiness(
  orgId: string,
  trackedBusinessId: string,
  role: 'AGENCY_ADMIN' | 'AGENCY_MEMBER' | 'OWNER_READONLY'
): Promise<AuditResult> {
  if (role === 'OWNER_READONLY') {
    throw new AuthorizationError('The deep review audit is available on Agency/Pro plans only.');
  }

  // Scope the business to the caller's org — never trust the id alone.
  const business = await prisma.trackedBusiness.findFirst({
    where: { id: trackedBusinessId, orgId },
    select: { id: true, name: true },
  });
  if (!business) {
    throw new NotFoundError('Tracked business not found for this organization.');
  }

  const [reviews, latestSnapshot] = await Promise.all([
    prisma.scrapedReview.findMany({
      where: { trackedBusinessId: business.id },
      orderBy: { reviewedAt: 'desc' },
      take: 1000,
      select: {
        rating: true,
        text: true,
        reviewedAt: true,
        isLocalGuide: true,
        hasPhoto: true,
        ownerResponded: true,
        authorReviewCount: true,
      },
    }),
    prisma.profileSnapshot.findFirst({
      where: { trackedBusinessId: business.id },
      orderBy: { capturedOn: 'desc' },
      select: { displayRating: true },
    }),
  ]);

  const result = computeAudit(reviews as AuditReview[], latestSnapshot?.displayRating ?? null);
  logger.info(
    `Audit computed for business ${business.id}: ${result.reviewSampleSize} reviews, ` +
      `${result.velocity.length} velocity points, ${result.velocityAnomalies.length} anomalies`
  );
  return result;
}
