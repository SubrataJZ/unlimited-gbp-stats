-- Plans + license keys.

-- CreateEnum
CREATE TYPE "Plan" AS ENUM ('FREE', 'PRO', 'AGENCY');

-- Organization.plan: String? -> Plan (default FREE). Convert any legacy values.
ALTER TABLE "organizations" ADD COLUMN "plan_new" "Plan" NOT NULL DEFAULT 'FREE';
UPDATE "organizations" SET "plan_new" = 'PRO'    WHERE "plan" IS NOT NULL AND upper("plan") LIKE 'PRO%';
UPDATE "organizations" SET "plan_new" = 'AGENCY' WHERE "plan" IS NOT NULL AND upper("plan") LIKE 'AGENCY%';
ALTER TABLE "organizations" DROP COLUMN "plan";
ALTER TABLE "organizations" RENAME COLUMN "plan_new" TO "plan";

ALTER TABLE "organizations" ADD COLUMN "plan_expires_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "license_keys" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "plan" "Plan" NOT NULL,
    "duration_days" INTEGER NOT NULL DEFAULT 365,
    "note" TEXT,
    "redeemed_by_org_id" TEXT,
    "redeemed_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "license_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "license_keys_code_key" ON "license_keys"("code");

-- CreateIndex
CREATE INDEX "license_keys_redeemed_by_org_id_idx" ON "license_keys"("redeemed_by_org_id");

-- AddForeignKey
ALTER TABLE "license_keys" ADD CONSTRAINT "license_keys_redeemed_by_org_id_fkey" FOREIGN KEY ("redeemed_by_org_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
