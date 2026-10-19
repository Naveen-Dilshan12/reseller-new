-- Enforces, at the database level, that a reseller cannot have more than one
-- open demo request for the same product and contact email at a time.
--
-- This closes a race window that the application-level pre-check in
-- demo.service.ts create() cannot close on its own (two concurrent
-- submissions can both pass a SELECT before either has committed its
-- INSERT). The application catches the resulting unique-violation (P2002)
-- and returns the same conflict response as the pre-check.
--
-- "Open" means any status except REJECTED — a previously rejected request
-- must never block a new one. The email side of the key is matched via
-- LOWER(TRIM(...)) so the constraint holds regardless of case/whitespace,
-- independent of whatever normalisation the application layer currently
-- applies before insert.
--
-- This is a partial + expression index, neither of which Prisma's schema
-- language (schema.prisma) can represent — there is deliberately no
-- corresponding `@@index`/`@@unique` there. `prisma migrate dev`/`db push`
-- only ever generate DDL for what schema.prisma declares, so they will not
-- attempt to alter or drop this index; it is purely additive, tracked only
-- through the migration history. This is the same pattern already used by
-- 20260929000100_audit_log_append_only (a trigger function with no
-- schema.prisma representation either), which has already survived two
-- subsequent migrations in this project without any drift.
CREATE UNIQUE INDEX "demo_requests_open_duplicate_key"
ON "demo_requests" ("resellerId", "productId", (LOWER(TRIM("contactEmail"))))
WHERE "status" != 'REJECTED'::"DemoRequestStatus";
