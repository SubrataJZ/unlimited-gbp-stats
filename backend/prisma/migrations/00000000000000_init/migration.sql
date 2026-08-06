-- CreateEnum
CREATE TYPE "Role" AS ENUM ('AGENCY_ADMIN', 'AGENCY_MEMBER', 'OWNER_READONLY');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "google_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "avatar_url" TEXT,
    "access_token" TEXT,
    "refresh_token" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_used_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "action" TEXT NOT NULL,
    "resource" TEXT,
    "status" TEXT NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "businesses" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "logo" TEXT,
    "website" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "businesses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviews" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "customerEmail" TEXT,
    "rating" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "flagged" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "locations" (
    "id" TEXT NOT NULL,
    "google_location_id" TEXT NOT NULL,
    "business_name" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metrics" (
    "id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "metric_type" TEXT NOT NULL,
    "value" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "metrics_pkey" PRIMARY KEY ("id")
);

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
CREATE TABLE "metric_months" (
    "id" TEXT NOT NULL,
    "tracked_business_id" TEXT NOT NULL,
    "metric_type" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "daily" JSONB,
    "yoy_percent" DOUBLE PRECISION,
    "breakdown" JSONB,
    "search_terms" JSONB,
    "is_derived" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL DEFAULT 'extension',
    "collected_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "metric_months_pkey" PRIMARY KEY ("id")
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
    "owner_responded" BOOLEAN NOT NULL DEFAULT false,
    "rating" INTEGER NOT NULL,
    "text" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "scraped_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scraped_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_analyses" (
    "id" TEXT NOT NULL,
    "scraped_review_id" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "language" TEXT,
    "sentiment" TEXT,
    "analyzed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_analyses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_concepts" (
    "id" TEXT NOT NULL,
    "tracked_business_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'other',
    "aliases" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "review_concepts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_concept_mentions" (
    "id" TEXT NOT NULL,
    "concept_id" TEXT NOT NULL,
    "scraped_review_id" TEXT NOT NULL,
    "sentiment" TEXT NOT NULL,
    "surface" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_concept_mentions_pkey" PRIMARY KEY ("id")
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
CREATE UNIQUE INDEX "users_google_id_key" ON "users"("google_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "api_keys_prefix_idx" ON "api_keys"("prefix");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_user_id_name_key" ON "api_keys"("user_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_key" ON "refresh_tokens"("token");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE INDEX "audit_logs_user_id_idx" ON "audit_logs"("user_id");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "businesses_slug_key" ON "businesses"("slug");

-- CreateIndex
CREATE INDEX "businesses_userId_idx" ON "businesses"("userId");

-- CreateIndex
CREATE INDEX "reviews_businessId_idx" ON "reviews"("businessId");

-- CreateIndex
CREATE INDEX "reviews_approved_idx" ON "reviews"("approved");

-- CreateIndex
CREATE UNIQUE INDEX "locations_google_location_id_key" ON "locations"("google_location_id");

-- CreateIndex
CREATE INDEX "locations_user_id_idx" ON "locations"("user_id");

-- CreateIndex
CREATE INDEX "metrics_location_id_idx" ON "metrics"("location_id");

-- CreateIndex
CREATE INDEX "metrics_date_idx" ON "metrics"("date");

-- CreateIndex
CREATE UNIQUE INDEX "metrics_location_id_date_metric_type_key" ON "metrics"("location_id", "date", "metric_type");

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
CREATE INDEX "tracked_businesses_org_id_idx" ON "tracked_businesses"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "tracked_businesses_org_id_google_place_id_key" ON "tracked_businesses"("org_id", "google_place_id");

-- CreateIndex
CREATE INDEX "profile_snapshots_tracked_business_id_idx" ON "profile_snapshots"("tracked_business_id");

-- CreateIndex
CREATE UNIQUE INDEX "profile_snapshots_tracked_business_id_captured_on_key" ON "profile_snapshots"("tracked_business_id", "captured_on");

-- CreateIndex
CREATE INDEX "metric_months_tracked_business_id_idx" ON "metric_months"("tracked_business_id");

-- CreateIndex
CREATE INDEX "metric_months_year_month_idx" ON "metric_months"("year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "metric_months_tracked_business_id_metric_type_year_month_key" ON "metric_months"("tracked_business_id", "metric_type", "year", "month");

-- CreateIndex
CREATE INDEX "scraped_reviews_tracked_business_id_idx" ON "scraped_reviews"("tracked_business_id");

-- CreateIndex
CREATE UNIQUE INDEX "scraped_reviews_tracked_business_id_external_review_id_key" ON "scraped_reviews"("tracked_business_id", "external_review_id");

-- CreateIndex
CREATE UNIQUE INDEX "review_analyses_scraped_review_id_key" ON "review_analyses"("scraped_review_id");

-- CreateIndex
CREATE INDEX "review_concepts_tracked_business_id_idx" ON "review_concepts"("tracked_business_id");

-- CreateIndex
CREATE UNIQUE INDEX "review_concepts_tracked_business_id_label_key" ON "review_concepts"("tracked_business_id", "label");

-- CreateIndex
CREATE INDEX "review_concept_mentions_concept_id_idx" ON "review_concept_mentions"("concept_id");

-- CreateIndex
CREATE INDEX "review_concept_mentions_scraped_review_id_idx" ON "review_concept_mentions"("scraped_review_id");

-- CreateIndex
CREATE UNIQUE INDEX "review_concept_mentions_concept_id_scraped_review_id_key" ON "review_concept_mentions"("concept_id", "scraped_review_id");

-- CreateIndex
CREATE UNIQUE INDEX "business_contexts_tracked_business_id_key" ON "business_contexts"("tracked_business_id");

-- CreateIndex
CREATE UNIQUE INDEX "review_replies_scraped_review_id_key" ON "review_replies"("scraped_review_id");

-- CreateIndex
CREATE INDEX "ai_usage_user_id_idx" ON "ai_usage"("user_id");

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "locations" ADD CONSTRAINT "locations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metrics" ADD CONSTRAINT "metrics_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("google_location_id") ON DELETE CASCADE ON UPDATE CASCADE;

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
ALTER TABLE "metric_months" ADD CONSTRAINT "metric_months_tracked_business_id_fkey" FOREIGN KEY ("tracked_business_id") REFERENCES "tracked_businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scraped_reviews" ADD CONSTRAINT "scraped_reviews_tracked_business_id_fkey" FOREIGN KEY ("tracked_business_id") REFERENCES "tracked_businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_analyses" ADD CONSTRAINT "review_analyses_scraped_review_id_fkey" FOREIGN KEY ("scraped_review_id") REFERENCES "scraped_reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_concepts" ADD CONSTRAINT "review_concepts_tracked_business_id_fkey" FOREIGN KEY ("tracked_business_id") REFERENCES "tracked_businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_concept_mentions" ADD CONSTRAINT "review_concept_mentions_concept_id_fkey" FOREIGN KEY ("concept_id") REFERENCES "review_concepts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_concept_mentions" ADD CONSTRAINT "review_concept_mentions_scraped_review_id_fkey" FOREIGN KEY ("scraped_review_id") REFERENCES "scraped_reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_contexts" ADD CONSTRAINT "business_contexts_tracked_business_id_fkey" FOREIGN KEY ("tracked_business_id") REFERENCES "tracked_businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_replies" ADD CONSTRAINT "review_replies_scraped_review_id_fkey" FOREIGN KEY ("scraped_review_id") REFERENCES "scraped_reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

