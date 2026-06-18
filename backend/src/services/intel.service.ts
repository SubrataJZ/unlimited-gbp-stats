import { prisma } from '../index';
import logger from '../utils/logger';

/**
 * Resolve (or auto-create) the orgId for a given userId.
 *
 * - Returns the orgId of the user's first Membership, if one exists.
 * - Otherwise creates a new Organization + Membership (AGENCY_ADMIN) and returns its id.
 */
export async function resolveOrgId(userId: string): Promise<string> {
  // Fast-path: existing membership
  const existing = await prisma.membership.findFirst({
    where: { userId },
    select: { orgId: true },
  });

  if (existing) {
    return existing.orgId;
  }

  // Look up user email for the workspace name
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });

  const workspaceName = user?.email
    ? `${user.email}'s workspace`
    : 'Personal workspace';

  // Create org + membership in a single transaction
  const membership = await prisma.$transaction(async (tx) => {
    const org = await tx.organization.create({
      data: { name: workspaceName },
    });

    return tx.membership.create({
      data: {
        userId,
        orgId: org.id,
        role: 'AGENCY_ADMIN',
      },
      select: { orgId: true },
    });
  });

  logger.info(`Auto-created organization "${workspaceName}" for user ${userId}`);
  return membership.orgId;
}

/**
 * Resolve the caller's orgId together with their role in that org. Used by
 * tier-gated reads (e.g. the deep review audit) that must distinguish
 * Agency/Pro members from read-only Owners.
 */
export async function resolveMembership(
  userId: string
): Promise<{ orgId: string; role: 'AGENCY_ADMIN' | 'AGENCY_MEMBER' | 'OWNER_READONLY' }> {
  const orgId = await resolveOrgId(userId);
  const membership = await prisma.membership.findFirst({
    where: { userId, orgId },
    select: { role: true },
  });
  // resolveOrgId guarantees a membership exists (it creates one when absent).
  return { orgId, role: membership!.role };
}

/**
 * Read back all tracked businesses for an org, each with its snapshot timeline
 * and recent reviews. Powers the extension dashboard's Reviews view.
 *
 * Queries ProfileSnapshot / ScrapedReview directly (rather than via relation
 * includes) so it only depends on field names this service already writes.
 */
export async function getIntelForOrg(orgId: string) {
  const businesses = await prisma.trackedBusiness.findMany({
    where: { orgId },
    select: {
      id: true,
      name: true,
      googlePlaceId: true,
      address: true,
      logoUrl: true,
      isOwn: true,
    },
  });

  if (businesses.length === 0) return [];

  const ids = businesses.map((b) => b.id);

  const [snapshots, reviews] = await Promise.all([
    prisma.profileSnapshot.findMany({
      where: { trackedBusinessId: { in: ids } },
      orderBy: { capturedOn: 'asc' },
      select: {
        trackedBusinessId: true,
        capturedOn: true,
        totalReviews: true,
        displayRating: true,
        trueAverage: true,
        reviewsWithPhotos: true,
        localGuideReviews: true,
      },
    }),
    prisma.scrapedReview.findMany({
      where: { trackedBusinessId: { in: ids } },
      orderBy: { reviewedAt: 'desc' },
      take: 1000,
      select: {
        trackedBusinessId: true,
        externalReviewId: true,
        rating: true,
        text: true,
        authorName: true,
        isLocalGuide: true,
        hasPhoto: true,
        ownerResponded: true,
        reviewedAt: true,
      },
    }),
  ]);

  // Group children under each business
  return businesses.map((b) => ({
    ...b,
    snapshots: snapshots.filter((s) => s.trackedBusinessId === b.id),
    reviews: reviews.filter((r) => r.trackedBusinessId === b.id),
  }));
}

// ── Types mirroring the validated request payload ─────────────────────────────

export interface IncomingSnapshot {
  totalReviews: number;
  displayRating?: number;
  trueAverage?: number;
  reviewsWithPhotos?: number;
  localGuideReviews?: number;
  avgReviewerContribution?: number;
  capturedOn?: Date; // already parsed to UTC-midnight Date by controller
}

export interface IncomingReview {
  externalReviewId: string;
  rating: number;
  text?: string; // already truncated to 5000 chars by controller
  reviewedAt?: Date;
  authorName?: string;
  authorId?: string;
  authorReviewCount?: number;
  isLocalGuide?: boolean;
  hasPhoto?: boolean;
  ownerResponded?: boolean;
}

export interface IncomingBusiness {
  name: string;
  googlePlaceId?: string;
  address?: string;
  searchUrl?: string;
  logoUrl?: string;
  isOwn?: boolean;
  snapshot?: IncomingSnapshot;
  reviews?: IncomingReview[];
}

export interface IngestSummary {
  businessesCreated: number;
  businessesUpdated: number;
  snapshotsUpserted: number;
  reviewsCreated: number;
  reviewsUpdated: number;
}

/**
 * Idempotently ingest an array of businesses (competitors + own profile) into
 * the database for a given organization.
 *
 * Each business is wrapped in its own transaction so one failure does not roll
 * back the entire batch.
 */
export async function ingestIntel(
  orgId: string,
  businesses: IncomingBusiness[]
): Promise<IngestSummary> {
  const summary: IngestSummary = {
    businessesCreated: 0,
    businessesUpdated: 0,
    snapshotsUpserted: 0,
    reviewsCreated: 0,
    reviewsUpdated: 0,
  };

  for (const biz of businesses) {
    await prisma.$transaction(async (tx) => {
      // ── a. Resolve / upsert TrackedBusiness ──────────────────────────────

      let trackedBusinessId: string;
      let bizIsNew: boolean;

      if (biz.googlePlaceId) {
        // Compound unique [orgId, googlePlaceId] exists in schema.
        // The generated Prisma client (from an older migration snapshot) does
        // not expose this compound key in WhereUniqueInput, so we use
        // findFirst (scoped to orgId + googlePlaceId) then create-or-update.
        const existing = await tx.trackedBusiness.findFirst({
          where: { orgId, googlePlaceId: biz.googlePlaceId },
          select: { id: true },
        });

        bizIsNew = !existing;

        if (existing) {
          await tx.trackedBusiness.update({
            where: { id: existing.id },
            data: {
              name: biz.name,
              address: biz.address ?? undefined,
              searchUrl: biz.searchUrl ?? undefined,
              logoUrl: biz.logoUrl ?? undefined,
              isOwn: biz.isOwn ?? false,
            },
          });
          trackedBusinessId = existing.id;
        } else {
          const created = await tx.trackedBusiness.create({
            data: {
              orgId,
              googlePlaceId: biz.googlePlaceId,
              name: biz.name,
              address: biz.address,
              searchUrl: biz.searchUrl,
              logoUrl: biz.logoUrl,
              isOwn: biz.isOwn ?? false,
            },
            select: { id: true },
          });
          trackedBusinessId = created.id;
        }
      } else {
        // No googlePlaceId — fall back to name + address lookup
        const existing = await tx.trackedBusiness.findFirst({
          where: { orgId, name: biz.name, address: biz.address ?? null },
          select: { id: true },
        });

        if (existing) {
          bizIsNew = false;
          trackedBusinessId = existing.id;

          await tx.trackedBusiness.update({
            where: { id: trackedBusinessId },
            data: {
              searchUrl: biz.searchUrl ?? undefined,
              logoUrl: biz.logoUrl ?? undefined,
              isOwn: biz.isOwn ?? false,
            },
          });
        } else {
          bizIsNew = true;
          const created = await tx.trackedBusiness.create({
            data: {
              orgId,
              name: biz.name,
              address: biz.address,
              searchUrl: biz.searchUrl,
              logoUrl: biz.logoUrl,
              isOwn: biz.isOwn ?? false,
            },
            select: { id: true },
          });
          trackedBusinessId = created.id;
        }
      }

      if (bizIsNew) {
        summary.businessesCreated++;
      } else {
        summary.businessesUpdated++;
      }

      // ── b. Upsert ProfileSnapshot ─────────────────────────────────────────

      if (biz.snapshot) {
        const snap = biz.snapshot;

        await tx.profileSnapshot.upsert({
          where: {
            trackedBusinessId_capturedOn: {
              trackedBusinessId,
              capturedOn: snap.capturedOn!,
            },
          },
          create: {
            trackedBusinessId,
            capturedOn: snap.capturedOn!,
            totalReviews: snap.totalReviews,
            displayRating: snap.displayRating,
            trueAverage: snap.trueAverage,
            reviewsWithPhotos: snap.reviewsWithPhotos ?? 0,
            localGuideReviews: snap.localGuideReviews ?? 0,
            avgReviewerContribution: snap.avgReviewerContribution,
          },
          update: {
            totalReviews: snap.totalReviews,
            displayRating: snap.displayRating ?? undefined,
            trueAverage: snap.trueAverage ?? undefined,
            reviewsWithPhotos: snap.reviewsWithPhotos ?? undefined,
            localGuideReviews: snap.localGuideReviews ?? undefined,
            avgReviewerContribution: snap.avgReviewerContribution ?? undefined,
          },
        });

        summary.snapshotsUpserted++;
      }

      // ── c. Upsert ScrapedReviews ──────────────────────────────────────────

      for (const rev of biz.reviews ?? []) {
        const existingRev = await tx.scrapedReview.findUnique({
          where: {
            trackedBusinessId_externalReviewId: {
              trackedBusinessId,
              externalReviewId: rev.externalReviewId,
            },
          },
          select: { id: true },
        });

        await tx.scrapedReview.upsert({
          where: {
            trackedBusinessId_externalReviewId: {
              trackedBusinessId,
              externalReviewId: rev.externalReviewId,
            },
          },
          create: {
            trackedBusinessId,
            externalReviewId: rev.externalReviewId,
            rating: rev.rating,
            text: rev.text,
            reviewedAt: rev.reviewedAt,
            authorName: rev.authorName,
            authorId: rev.authorId,
            authorReviewCount: rev.authorReviewCount,
            isLocalGuide: rev.isLocalGuide ?? false,
            hasPhoto: rev.hasPhoto ?? false,
            ownerResponded: rev.ownerResponded ?? false,
          },
          update: {
            rating: rev.rating,
            text: rev.text ?? undefined,
            reviewedAt: rev.reviewedAt ?? undefined,
            authorName: rev.authorName ?? undefined,
            authorId: rev.authorId ?? undefined,
            authorReviewCount: rev.authorReviewCount ?? undefined,
            isLocalGuide: rev.isLocalGuide ?? false,
            hasPhoto: rev.hasPhoto ?? false,
            ownerResponded: rev.ownerResponded ?? false,
          },
        });

        if (existingRev) {
          summary.reviewsUpdated++;
        } else {
          summary.reviewsCreated++;
        }
      }
    });
  }

  return summary;
}
