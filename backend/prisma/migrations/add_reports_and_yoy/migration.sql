-- CreateTable Report
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

-- CreateTable YoYComparison
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

-- CreateIndex
CREATE INDEX "reports_location_id_idx" ON "reports"("location_id");

-- CreateIndex
CREATE INDEX "reports_generated_at_idx" ON "reports"("generated_at");

-- CreateIndex
CREATE INDEX "reports_expires_at_idx" ON "reports"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "yoy_comparisons_location_id_metric_type_year_month_key" ON "yoy_comparisons"("location_id", "metric_type", "year", "month");

-- CreateIndex
CREATE INDEX "yoy_comparisons_location_id_idx" ON "yoy_comparisons"("location_id");

-- CreateIndex
CREATE INDEX "yoy_comparisons_year_month_idx" ON "yoy_comparisons"("year", "month");

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("google_location_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "yoy_comparisons" ADD CONSTRAINT "yoy_comparisons_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("google_location_id") ON DELETE CASCADE ON UPDATE CASCADE;
