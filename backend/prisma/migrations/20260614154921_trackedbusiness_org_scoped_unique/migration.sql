-- DropIndex
DROP INDEX "tracked_businesses_google_place_id_key";

-- CreateIndex
CREATE UNIQUE INDEX "tracked_businesses_org_id_google_place_id_key" ON "tracked_businesses"("org_id", "google_place_id");

