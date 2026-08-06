-- Multilingual review-concept analyser.
-- Purely additive: three new tables, no column or constraint changes to any
-- existing table, so this is safe to apply to the live database ahead of the
-- code that reads it.

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

-- AddForeignKey
ALTER TABLE "review_analyses" ADD CONSTRAINT "review_analyses_scraped_review_id_fkey" FOREIGN KEY ("scraped_review_id") REFERENCES "scraped_reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_concepts" ADD CONSTRAINT "review_concepts_tracked_business_id_fkey" FOREIGN KEY ("tracked_business_id") REFERENCES "tracked_businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_concept_mentions" ADD CONSTRAINT "review_concept_mentions_concept_id_fkey" FOREIGN KEY ("concept_id") REFERENCES "review_concepts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_concept_mentions" ADD CONSTRAINT "review_concept_mentions_scraped_review_id_fkey" FOREIGN KEY ("scraped_review_id") REFERENCES "scraped_reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;
