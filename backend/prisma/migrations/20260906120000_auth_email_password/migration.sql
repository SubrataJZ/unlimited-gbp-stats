-- Email/password auth: make Google identity optional, add password + reset support.

-- google_id becomes nullable (password-only accounts have no Google identity).
-- The existing UNIQUE index on google_id stays; Postgres permits many NULLs under it.
ALTER TABLE "users" ALTER COLUMN "google_id" DROP NOT NULL;

-- New user columns.
ALTER TABLE "users" ADD COLUMN "password_hash" TEXT;
ALTER TABLE "users" ADD COLUMN "email_verified_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "last_login_at" TIMESTAMP(3);

-- Backfill: every existing account authenticated via Google, so its email is verified.
UPDATE "users" SET "email_verified_at" = "created_at" WHERE "google_id" IS NOT NULL;

-- CreateTable
CREATE TABLE "password_resets" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_resets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "password_resets_token_hash_key" ON "password_resets"("token_hash");

-- CreateIndex
CREATE INDEX "password_resets_user_id_idx" ON "password_resets"("user_id");

-- AddForeignKey
ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
