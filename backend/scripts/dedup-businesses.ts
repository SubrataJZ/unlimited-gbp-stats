/**
 * Dedup script — merge duplicate TrackedBusiness rows within each org.
 *
 * Duplicates arise when the same business was scraped via different surfaces
 * (listing card slug, Maps CID, Search local-id) before the ID-unification
 * fix shipped in commit 91610d9 (2026-06-20).
 *
 * Strategy:
 *   1. Group rows by (orgId, normalized-name, normalized-address).
 *   2. Choose a canonical row: prefer numeric CID (all digits), then oldest.
 *   3. Re-parent ScrapedReview, ProfileSnapshot, BusinessContext to canonical.
 *      ScrapedReview has @@unique([trackedBusinessId, externalReviewId]) so we
 *      skip any review whose externalReviewId already exists on the canonical.
 *   4. Delete the non-canonical rows (cascade handles foreign keys except the
 *      unique-constrained children we already moved).
 *
 * Run dry-run first (safe, no writes):
 *   npx ts-node scripts/dedup-businesses.ts
 *
 * Apply:
 *   npx ts-node scripts/dedup-businesses.ts --apply
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const DRY_RUN = !process.argv.includes('--apply');

function normalize(s: string | null | undefined): string {
  return (s || '')
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ');
}

function isNumericCid(gpid: string | null | undefined): boolean {
  return !!gpid && /^\d{10,}$/.test(gpid);
}

async function main() {
  console.log(`\n=== TrackedBusiness dedup — ${DRY_RUN ? 'DRY RUN (no writes)' : 'APPLY MODE'} ===\n`);

  const all = await prisma.trackedBusiness.findMany({
    select: {
      id: true,
      orgId: true,
      googlePlaceId: true,
      name: true,
      address: true,
      createdAt: true,
      _count: {
        select: { scrapedReviews: true, snapshots: true },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  // Group by (orgId, normalized-name, normalized-address)
  const groups = new Map<string, typeof all>();
  for (const row of all) {
    const key = `${row.orgId}||${normalize(row.name)}||${normalize(row.address)}`;
    const grp = groups.get(key) ?? [];
    grp.push(row);
    groups.set(key, grp);
  }

  const dupGroups = [...groups.values()].filter((g) => g.length > 1);

  if (dupGroups.length === 0) {
    console.log('No duplicates found. Nothing to do.');
    return;
  }

  console.log(`Found ${dupGroups.length} duplicate group(s):\n`);

  let totalMerged = 0;

  for (const group of dupGroups) {
    // Pick canonical: numeric CID wins, else oldest (already sorted asc)
    const canonical =
      group.find((r) => isNumericCid(r.googlePlaceId)) ?? group[0];
    const dupes = group.filter((r) => r.id !== canonical.id);

    console.log(`Group: "${group[0].name}" (orgId ${group[0].orgId})`);
    console.log(
      `  KEEP  ${canonical.id} gpid=${canonical.googlePlaceId ?? 'null'}  reviews=${canonical._count.scrapedReviews}  snaps=${canonical._count.snapshots}`
    );
    for (const d of dupes) {
      console.log(
        `  MERGE ${d.id} gpid=${d.googlePlaceId ?? 'null'}  reviews=${d._count.scrapedReviews}  snaps=${d._count.snapshots}`
      );
    }

    if (DRY_RUN) {
      totalMerged += dupes.length;
      console.log('  → skipped (dry run)\n');
      continue;
    }

    // APPLY: run each merge in a transaction
    for (const dupe of dupes) {
      await prisma.$transaction(async (tx) => {
        // 1. Re-parent ScrapedReviews (skip if externalReviewId already on canonical)
        const existingExtIds = await tx.scrapedReview
          .findMany({
            where: { trackedBusinessId: canonical.id },
            select: { externalReviewId: true },
          })
          .then((rows) => new Set(rows.map((r) => r.externalReviewId)));

        const dupeReviews = await tx.scrapedReview.findMany({
          where: { trackedBusinessId: dupe.id },
          select: { id: true, externalReviewId: true },
        });

        const toMove = dupeReviews.filter((r) => !existingExtIds.has(r.externalReviewId));
        const toSkip = dupeReviews.length - toMove.length;

        if (toMove.length > 0) {
          await tx.scrapedReview.updateMany({
            where: { id: { in: toMove.map((r) => r.id) } },
            data: { trackedBusinessId: canonical.id },
          });
        }

        console.log(
          `  reviews: moved ${toMove.length}, skipped (dup externalId) ${toSkip}`
        );

        // 2. Re-parent ProfileSnapshots (skip if capturedOn already on canonical)
        const existingDates = await tx.profileSnapshot
          .findMany({
            where: { trackedBusinessId: canonical.id },
            select: { capturedOn: true },
          })
          .then((rows) => new Set(rows.map((r) => r.capturedOn.toISOString())));

        const dupeSnaps = await tx.profileSnapshot.findMany({
          where: { trackedBusinessId: dupe.id },
          select: { id: true, capturedOn: true },
        });

        const snapsToMove = dupeSnaps.filter(
          (s) => !existingDates.has(s.capturedOn.toISOString())
        );
        const snapsToSkip = dupeSnaps.length - snapsToMove.length;

        if (snapsToMove.length > 0) {
          await tx.profileSnapshot.updateMany({
            where: { id: { in: snapsToMove.map((s) => s.id) } },
            data: { trackedBusinessId: canonical.id },
          });
        }

        console.log(
          `  snapshots: moved ${snapsToMove.length}, skipped (dup date) ${snapsToSkip}`
        );

        // 3. Re-parent BusinessContext (1:1 relation; keep canonical's if it has one)
        const canonicalCtx = await tx.businessContext.findUnique({
          where: { trackedBusinessId: canonical.id },
        });
        if (!canonicalCtx) {
          const dupeCtx = await tx.businessContext.findUnique({
            where: { trackedBusinessId: dupe.id },
          });
          if (dupeCtx) {
            await tx.businessContext.update({
              where: { trackedBusinessId: dupe.id },
              data: { trackedBusinessId: canonical.id },
            });
            console.log('  context: moved to canonical');
          }
        } else {
          console.log('  context: canonical already has one, dupe context will cascade-delete');
        }

        // 4. Backfill canonical's googlePlaceId if it's still a slug
        if (!isNumericCid(canonical.googlePlaceId) && isNumericCid(dupe.googlePlaceId)) {
          await tx.trackedBusiness.update({
            where: { id: canonical.id },
            data: { googlePlaceId: dupe.googlePlaceId },
          });
          console.log(`  backfilled canonical gpid → ${dupe.googlePlaceId}`);
        }

        // 5. Delete the dupe row (remaining children cascade)
        await tx.trackedBusiness.delete({ where: { id: dupe.id } });
        console.log(`  deleted dupe ${dupe.id}`);
      });

      totalMerged++;
    }

    console.log();
  }

  console.log(
    `\nDone. ${DRY_RUN ? 'Would merge' : 'Merged'} ${totalMerged} duplicate row(s).`
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
