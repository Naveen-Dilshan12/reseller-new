-- Adds the SMS-verified phone number, kept separate from users."phone" (the contact / WhatsApp number).
-- Only a successful SMS one-time-code verification may ever write these two columns.
-- Nothing is backfilled: existing "phone" values may be WhatsApp contacts or unverified application numbers.
-- A UNIQUE index allows any number of NULLs in PostgreSQL, so unverified users do not conflict.

-- AlterTable
ALTER TABLE "users" ADD COLUMN "phoneVerifiedAt" TIMESTAMP(3),
ADD COLUMN "verifiedPhone" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "users_verifiedPhone_key" ON "users"("verifiedPhone");
