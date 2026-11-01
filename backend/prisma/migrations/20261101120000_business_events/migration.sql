-- Business notes: a date, a title, a description and an emoji, per tracked business.
CREATE TABLE "business_events" (
    "id" TEXT NOT NULL,
    "tracked_business_id" TEXT NOT NULL,
    "event_date" DATE NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "description" VARCHAR(2000),
    "emoji" VARCHAR(16) NOT NULL,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "business_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "business_events_tracked_business_id_event_date_idx" ON "business_events"("tracked_business_id", "event_date");

ALTER TABLE "business_events" ADD CONSTRAINT "business_events_tracked_business_id_fkey"
    FOREIGN KEY ("tracked_business_id") REFERENCES "tracked_businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
