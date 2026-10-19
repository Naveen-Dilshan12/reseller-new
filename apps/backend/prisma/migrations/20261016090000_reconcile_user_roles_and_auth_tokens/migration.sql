-- Reconciles schema.prisma with the migration history. These objects were added to the schema without a migration:
--   * UserRole shrinks from (SUPER_ADMIN, ADMIN, FINANCE, RESELLER_ADMIN, RESELLER_AGENT) to (ADMIN, SELLER)
--   * users."emailVerified"
--   * password_reset_tokens, email_verification_tokens
--
-- The whole file runs as ONE transaction (Prisma sends it as a single multi-statement command), so any failure,
-- including the role guard below, rolls everything back and leaves the database unchanged.
--
-- Role mapping:  SUPER_ADMIN -> ADMIN,  ADMIN -> ADMIN,  RESELLER_ADMIN -> SELLER.
--
-- Two guards keep the conversion from silently changing anyone's access:
--  1. FINANCE, RESELLER_AGENT (or any other role) have no approved mapping: the migration aborts if such users exist.
--  2. The new ADMIN role holds EVERY permission, while the legacy ADMIN role lacked users:manage, resellers:bank-reveal,
--     integrations:manage and settings:manage. Converting legacy ADMIN users therefore widens their access. The migration
--     aborts while any legacy ADMIN user exists, unless an operator has consciously recorded the decision by inserting the
--     row  platform_settings(key = 'ACK_LEGACY_ADMIN_FULL_ACCESS')  after reviewing each such user (activate, deactivate
--     or demote them first as appropriate). SUPER_ADMIN already had every permission, so its mapping widens nothing.
--
-- "emailVerified" is deliberately NOT backfilled: existing accounts must not be recorded as having proven their email.
-- (How legacy accounts keep access is handled in application code, not in data.)

-- Guards
DO $$
DECLARE
  unmapped text;
  legacy_admins integer;
BEGIN
  SELECT string_agg("role"::text || ' x' || n, ', ') INTO unmapped
  FROM (SELECT "role", count(*) AS n FROM "users"
        WHERE "role"::text NOT IN ('SUPER_ADMIN', 'ADMIN', 'RESELLER_ADMIN')
        GROUP BY "role") t;
  IF unmapped IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot convert user roles: no approved mapping for % . Resolve these users manually, then re-run.', unmapped;
  END IF;

  SELECT count(*) INTO legacy_admins FROM "users" WHERE "role"::text = 'ADMIN';
  IF legacy_admins > 0
     AND NOT EXISTS (SELECT 1 FROM "platform_settings" WHERE "key" = 'ACK_LEGACY_ADMIN_FULL_ACCESS') THEN
    RAISE EXCEPTION '% legacy ADMIN user(s) would gain users:manage, resellers:bank-reveal, integrations:manage and settings:manage. Review them, then insert platform_settings key ACK_LEGACY_ADMIN_FULL_ACCESS to confirm, and re-run.', legacy_admins;
  END IF;
END $$;

-- AlterEnum: swap the type (PostgreSQL cannot drop enum values in place)
CREATE TYPE "UserRole_new" AS ENUM ('ADMIN', 'SELLER');
ALTER TABLE "users" ALTER COLUMN "role" TYPE "UserRole_new" USING (
  CASE "role"::text
    WHEN 'SUPER_ADMIN' THEN 'ADMIN'
    WHEN 'ADMIN' THEN 'ADMIN'
    WHEN 'RESELLER_ADMIN' THEN 'SELLER'
  END
)::"UserRole_new";
ALTER TYPE "UserRole" RENAME TO "UserRole_old";
ALTER TYPE "UserRole_new" RENAME TO "UserRole";
DROP TYPE "UserRole_old";

-- AlterTable
ALTER TABLE "users" ADD COLUMN "emailVerified" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_verification_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "usedAt" TIMESTAMP(3),
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_verification_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_tokenHash_key" ON "password_reset_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "password_reset_tokens_userId_idx" ON "password_reset_tokens"("userId");

-- CreateIndex
CREATE INDEX "email_verification_tokens_userId_createdAt_idx" ON "email_verification_tokens"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
