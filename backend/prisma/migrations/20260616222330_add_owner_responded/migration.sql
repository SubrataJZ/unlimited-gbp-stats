-- AlterTable: add owner_responded column to scraped_reviews
ALTER TABLE "scraped_reviews" ADD COLUMN "owner_responded" BOOLEAN NOT NULL DEFAULT false;
