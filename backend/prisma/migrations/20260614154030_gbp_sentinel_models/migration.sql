-- CreateEnum
CREATE TYPE "Role" AS ENUM ('AGENCY_ADMIN', 'AGENCY_MEMBER', 'OWNER_READONLY');

-- CreateTable
CREATE TABLE "reports" (
    "id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "report_type" TEXT NOT NULL,
    "date_range_start" DATE NOT NULL,
    "date_range_end" DATE NOT NULL,
    "html_content" TEXT NOT NULL,
    "pdf_content" BYTEA,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),
    "download_url" TEXT,
    "recipient_email" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "yoy_comparisons" (
    "id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "metric_type" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "current_value" INTEGER NOT NULL,
    "prior_year_value" INTEGER,
    "yoy_percent" DOUBLE PRECISION,
    "calculated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "yoy_comparisons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "plan" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "role" "Role" NOT NULL,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tracked_businesses" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "google_place_id" TEXT,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "search_url" TEXT,
    "logo_url" TEXT,
    "is_own" BOOLEAN NOT NULL DEFAULT false,
    "location_id" TEXT,

    CONSTRAINT "tracked_businesses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "profile_snapshots" (
    "id" TEXT NOT NULL,
    "tracked_business_id" TEXT NOT NULL,
    "captured_on" DATE NOT NULL,
    "total_reviews" INTEGER NOT NULL,
    "display_rating" DOUBLE PRECISION,
    "true_average" DOUBLE PRECISION,
    "reviews_with_photos" INTEGER NOT NULL DEFAULT 0,
    "local_guide_reviews" INTEGER NOT NULL DEFAULT 0,
    "avg_reviewer_contribution" DOUBLE PRECISION,

    CONSTRAINT "profile_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scraped_reviews" (
    "id" TEXT NOT NULL,
    "tracked_business_id" TEXT NOT NULL,
    "external_review_id" TEXT NOT NULL,
    "author_name" TEXT,
    "author_id" TEXT,
    "author_review_count" INTEGER,
    "is_local_guide" BOOLEAN NOT NULL DEFAULT false,
    "has_photo" BOOLEAN NOT NULL DEFAULT false,
    "rating" INTEGER NOT NULL,
    "text" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "scraped_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scraped_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_contexts" (
    "id" TEXT NOT NULL,
    "tracked_business_id" TEXT NOT NULL,
    "tone" TEXT,
    "services" TEXT,
    "owner_name" TEXT,
    "signature" TEXT,

    CONSTRAINT "business_contexts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_replies" (
    "id" TEXT NOT NULL,
    "scraped_review_id" TEXT NOT NULL,
    "draft_text" TEXT NOT NULL,
    "final_text" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "model" TEXT,
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "review_replies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_usage" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "tokens_in" INTEGER NOT NULL DEFAULT 0,
    "tokens_out" INTEGER NOT NULL DEFAULT 0,
    "cost_usd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reports_location_id_idx" ON "reports"("location_id");

-- CreateIndex
CREATE INDEX "reports_generated_at_idx" ON "reports"("generated_at");

-- CreateIndex
CREATE INDEX "reports_expires_at_idx" ON "reports"("expires_at");

-- CreateIndex
CREATE INDEX "yoy_comparisons_location_id_idx" ON "yoy_comparisons"("location_id");

-- CreateIndex
CREATE INDEX "yoy_comparisons_year_month_idx" ON "yoy_comparisons"("year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "yoy_comparisons_location_id_metric_type_year_month_key" ON "yoy_comparisons"("location_id", "metric_type", "year", "month");

-- CreateIndex
CREATE INDEX "memberships_org_id_idx" ON "memberships"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_user_id_org_id_key" ON "memberships"("user_id", "org_id");

-- CreateIndex
CREATE UNIQUE INDEX "tracked_businesses_google_place_id_key" ON "tracked_businesses"("google_place_id");

-- CreateIndex
CREATE INDEX "tracked_businesses_org_id_idx" ON "tracked_businesses"("org_id");

-- CreateIndex
CREATE INDEX "profile_snapshots_tracked_business_id_idx" ON "profile_snapshots"("tracked_business_id");

-- CreateIndex
CREATE UNIQUE INDEX "profile_snapshots_tracked_business_id_captured_on_key" ON "profile_snapshots"("tracked_business_id", "captured_on");

-- CreateIndex
CREATE INDEX "scraped_reviews_tracked_business_id_idx" ON "scraped_reviews"("tracked_business_id");

-- CreateIndex
CREATE UNIQUE INDEX "scraped_reviews_tracked_business_id_external_review_id_key" ON "scraped_reviews"("tracked_business_id", "external_review_id");

-- CreateIndex
CREATE UNIQUE INDEX "business_contexts_tracked_business_id_key" ON "business_contexts"("tracked_business_id");

-- CreateIndex
CREATE UNIQUE INDEX "review_replies_scraped_review_id_key" ON "review_replies"("scraped_review_id");

-- CreateIndex
CREATE INDEX "ai_usage_user_id_idx" ON "ai_usage"("user_id");

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("google_location_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "yoy_comparisons" ADD CONSTRAINT "yoy_comparisons_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("google_location_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracked_businesses" ADD CONSTRAINT "tracked_businesses_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profile_snapshots" ADD CONSTRAINT "profile_snapshots_tracked_business_id_fkey" FOREIGN KEY ("tracked_business_id") REFERENCES "tracked_businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scraped_reviews" ADD CONSTRAINT "scraped_reviews_tracked_business_id_fkey" FOREIGN KEY ("tracked_business_id") REFERENCES "tracked_businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_contexts" ADD CONSTRAINT "business_contexts_tracked_business_id_fkey" FOREIGN KEY ("tracked_business_id") REFERENCES "tracked_businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_replies" ADD CONSTRAINT "review_replies_scraped_review_id_fkey" FOREIGN KEY ("scraped_review_id") REFERENCES "scraped_reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

