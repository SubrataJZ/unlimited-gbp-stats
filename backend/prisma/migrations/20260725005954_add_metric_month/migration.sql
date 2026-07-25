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
-- CreateIndex
CREATE INDEX "metric_months_tracked_business_id_idx" ON "metric_months"("tracked_business_id");
-- CreateIndex
CREATE INDEX "metric_months_year_month_idx" ON "metric_months"("year", "month");
-- CreateIndex
CREATE UNIQUE INDEX "metric_months_tracked_business_id_metric_type_year_month_key" ON "metric_months"("tracked_business_id", "metric_type", "year", "month");
-- AddForeignKey
ALTER TABLE "metric_months" ADD CONSTRAINT "metric_months_tracked_business_id_fkey" FOREIGN KEY ("tracked_business_id") REFERENCES "tracked_businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
