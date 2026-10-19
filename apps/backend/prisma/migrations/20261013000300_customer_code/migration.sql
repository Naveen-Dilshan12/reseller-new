-- AlterTable
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "customer_code" TEXT;

-- CreateSequence
CREATE SEQUENCE IF NOT EXISTS customer_code_seq START 1;

-- Backfill existing rows
UPDATE "customers"
SET "customer_code" = 'CUS-' || LPAD(nextval('customer_code_seq')::text, 6, '0')
WHERE "customer_code" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "customers_customer_code_key" ON "customers"("customer_code");
