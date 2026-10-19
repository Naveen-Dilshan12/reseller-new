-- READ-ONLY pre-checks for migrations 20261016090000 and 20261016090100. NOT part of the migration history.
-- Run only against a database you have approved, ideally a restored copy of production.

-- 1. Roles that block migration A (FINANCE / RESELLER_AGENT must be 0 rows, or resolved by hand first)
SELECT "role", "status", count(*) FROM "users" GROUP BY 1, 2 ORDER BY 1, 2;

-- 1b. Legacy ADMIN users (migration A aborts unless each has been reviewed and ACK_LEGACY_ADMIN_FULL_ACCESS is set)
SELECT "id", "email", "status", "lastLoginAt" FROM "users" WHERE "role"::text = 'ADMIN';
SELECT "key" FROM "platform_settings" WHERE "key" = 'ACK_LEGACY_ADMIN_FULL_ACCESS';

-- 2. Drift: any of these objects already existing (e.g. from an earlier `db push`) makes the migrations fail loudly
SELECT table_name, column_name FROM information_schema.columns
 WHERE table_name = 'users' AND column_name IN ('emailVerified', 'phoneVerifiedAt', 'verifiedPhone');
SELECT table_name FROM information_schema.tables
 WHERE table_name IN ('password_reset_tokens', 'email_verification_tokens');
SELECT indexname FROM pg_indexes WHERE indexname = 'users_verifiedPhone_key';

-- 3. Migration history. Nothing is assumed about what production has applied: the list below is every directory in
--    prisma/migrations at the time of writing (tests/migration-precheck-coverage.test.ts fails if it drifts from disk).
--    The five that may be pending are 20261013000300 .. 20261016090100; `prisma migrate deploy` runs ALL of whichever are
--    not applied, not only A and B.
-- 3a. State of each expected migration on THIS database. Anything marked STOP means: do not deploy, resolve by hand.
WITH expected(ord, migration_name) AS (VALUES
  (1, '20260929000000_init'),
  (2, '20260929000100_audit_log_append_only'),
  (3, '20261013000300_customer_code'),
  (4, '20261014120000_demo_requests'),
  (5, '20261014130000_demo_requests_open_duplicate_index'),
  (6, '20261016090000_reconcile_user_roles_and_auth_tokens'),
  (7, '20261016090100_user_verified_phone'))
SELECT e.ord, e.migration_name,
       CASE WHEN m.migration_name IS NULL THEN 'NOT APPLIED - would run on deploy'
            WHEN m.rolled_back_at IS NOT NULL THEN 'ROLLED BACK - STOP'
            WHEN m.finished_at IS NULL THEN 'FAILED OR UNFINISHED - STOP'
            ELSE 'applied' END AS state,
       m.finished_at
  FROM expected e LEFT JOIN "_prisma_migrations" m ON m.migration_name = e.migration_name
 ORDER BY e.ord, m.started_at;

-- 3b. Migrations recorded in the database that this checkout does not contain (production may be on a different version). Expect 0 rows.
SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"
 WHERE migration_name NOT IN (
  '20260929000000_init',
  '20260929000100_audit_log_append_only',
  '20261013000300_customer_code',
  '20261014120000_demo_requests',
  '20261014130000_demo_requests_open_duplicate_index',
  '20261016090000_reconcile_user_roles_and_auth_tokens',
  '20261016090100_user_verified_phone')
 ORDER BY started_at;

-- 3c. Gaps: an expected migration that is NOT applied although a LATER one is. Expect 0 rows; any row means the history does not match this code.
WITH expected(ord, migration_name) AS (VALUES
  (1, '20260929000000_init'),
  (2, '20260929000100_audit_log_append_only'),
  (3, '20261013000300_customer_code'),
  (4, '20261014120000_demo_requests'),
  (5, '20261014130000_demo_requests_open_duplicate_index'),
  (6, '20261016090000_reconcile_user_roles_and_auth_tokens'),
  (7, '20261016090100_user_verified_phone')),
applied AS (SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)
SELECT e.ord, e.migration_name AS missing_but_later_ones_applied
  FROM expected e
 WHERE e.migration_name NOT IN (SELECT migration_name FROM applied)
   AND EXISTS (SELECT 1 FROM expected l JOIN applied a ON a.migration_name = l.migration_name WHERE l.ord > e.ord)
 ORDER BY e.ord;

-- 3d. Raw history, for the record.
SELECT migration_name, started_at, finished_at, rolled_back_at, applied_steps_count FROM "_prisma_migrations" ORDER BY started_at;

-- 4. Anything else depending on the UserRole type (should be only users.role)
SELECT c.relname, a.attname FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
 JOIN pg_type t ON t.oid = a.atttypid WHERE t.typname = 'UserRole' AND a.attnum > 0 AND NOT a.attisdropped;

-- 5. Information only: accounts that rely on the legacy-access rule
SELECT count(*) AS legacy_sellers, min("createdAt"), max("createdAt") FROM "users" WHERE "role"::text IN ('RESELLER_ADMIN', 'SELLER');

-- 5a. Cutoff vs real data (ACCOUNT_VERIFICATION_REQUIRED_FROM). The proposed value is NOT stored in this file: pass it in, e.g.
--       psql -v ON_ERROR_STOP=1 -v cutoff='<the exact ISO-8601 value with offset>' -f precheck-account-verification.sql
--     If `cutoff` is not supplied psql sends a syntax error and these queries do not run. Uses only columns that exist BEFORE migration A.
--     Non-admin accounts created at or after the cutoff get NO legacy access: they must verify by SMS/email, which no existing account has done.
--     Expected for a safe cutoff: needs_verification_users = 0 and cutoff_after_newest_user = true, re-checked immediately before go-live.
--     Format validity (scripts/check-deploy-config.cjs) proves none of this.
WITH c AS (SELECT (:'cutoff'::timestamptz AT TIME ZONE 'UTC') AS at_utc)
SELECT :'cutoff'::timestamptz AS cutoff, (:'cutoff'::timestamptz AT TIME ZONE 'Asia/Colombo') AS cutoff_colombo, now() AS database_now,
       count(*) FILTER (WHERE u."createdAt" <  c.at_utc) AS legacy_users,
       count(*) FILTER (WHERE u."createdAt" >= c.at_utc) AS needs_verification_users,
       max(u."createdAt") AS newest_non_admin_user,
       coalesce(max(u."createdAt") < min(c.at_utc), true) AS cutoff_after_newest_user
  FROM "users" u CROSS JOIN c
 WHERE u."role"::text NOT IN ('SUPER_ADMIN', 'ADMIN');

-- 5b. The accounts that would be locked out by that cutoff (expect 0 rows). Contains emails: handle as personal data.
WITH c AS (SELECT (:'cutoff'::timestamptz AT TIME ZONE 'UTC') AS at_utc)
SELECT u."id", u."email", u."role", u."status", u."createdAt"
  FROM "users" u CROSS JOIN c
 WHERE u."role"::text NOT IN ('SUPER_ADMIN', 'ADMIN') AND u."createdAt" >= c.at_utc
 ORDER BY u."createdAt";

-- 6. NOT a check. Only after reviewing every legacy ADMIN user from 1b, an operator who accepts that they will gain
--    users:manage, resellers:bank-reveal, integrations:manage and settings:manage records that decision with:
--    INSERT INTO "platform_settings" ("key", "value", "updatedAt")
--    VALUES ('ACK_LEGACY_ADMIN_FULL_ACCESS', 'reviewed by <name> on <date>', now());
