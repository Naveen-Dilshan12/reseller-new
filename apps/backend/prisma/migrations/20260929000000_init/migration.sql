-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'FINANCE', 'RESELLER_ADMIN', 'RESELLER_AGENT');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "ResellerStatus" AS ENUM ('PENDING', 'ACTIVE', 'REJECTED', 'SUSPENDED', 'TERMINATED');

-- CreateEnum
CREATE TYPE "SaasProductStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'COMING_SOON');

-- CreateEnum
CREATE TYPE "IntegrationStatus" AS ENUM ('NOT_CONFIGURED', 'CONFIGURED', 'CONNECTED', 'ERROR', 'DISABLED');

-- CreateEnum
CREATE TYPE "ResellerAccessStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'REVOKED');

-- CreateEnum
CREATE TYPE "IntegrationOperation" AS ENUM ('CREATE_TRIAL', 'LOOKUP_TENANT', 'GET_ACCOUNT_STATUS', 'REQUEST_ACTIVATION', 'GET_ACTIVATION_STATUS', 'HEALTH_CHECK');

-- CreateEnum
CREATE TYPE "CustomerAccountStatus" AS ENUM ('PENDING', 'TRIAL', 'ACTIVE', 'SUSPENDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TrialRequestStatus" AS ENUM ('PENDING', 'SUBMITTED', 'PROVISIONED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ActivationRequestStatus" AS ENUM ('PENDING_REVIEW', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'ACTIVATION_COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ActivationMethod" AS ENUM ('PARTNER_API', 'MANUAL');

-- CreateEnum
CREATE TYPE "SubscriptionEventType" AS ENUM ('PAYMENT_VERIFIED', 'CANCELLED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "SubscriptionEventSource" AS ENUM ('ADMIN', 'SAAS_WEBHOOK', 'ACTIVATION_REQUEST');

-- CreateEnum
CREATE TYPE "CommissionEntryType" AS ENUM ('EARNING', 'CLAWBACK');

-- CreateEnum
CREATE TYPE "CommissionStatus" AS ENUM ('PENDING', 'APPROVED', 'PAYABLE', 'PAID', 'REVERSED');

-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('USER', 'SYSTEM', 'SAAS');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "role" "UserRole" NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "resellerId" TEXT,
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resellers" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "nicOrPassport" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "mobile" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "businessName" TEXT NOT NULL,
    "businessRegistrationNo" TEXT NOT NULL,
    "businessAddress" TEXT NOT NULL,
    "businessPhone" TEXT NOT NULL,
    "businessEmail" TEXT NOT NULL,
    "status" "ResellerStatus" NOT NULL DEFAULT 'PENDING',
    "currentLevel" INTEGER,
    "activeCustomerCount" INTEGER NOT NULL DEFAULT 0,
    "levelUpdatedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "rejectionReason" TEXT,
    "reviewNote" TEXT,
    "approvedAt" TIMESTAMP(3),
    "suspendedAt" TIMESTAMP(3),
    "suspensionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "resellers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reseller_bank_accounts" (
    "id" TEXT NOT NULL,
    "resellerId" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "accountHolderName" TEXT NOT NULL,
    "accountNumberEncrypted" TEXT NOT NULL,
    "accountNumberLast4" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reseller_bank_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saas_products" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "SaasProductStatus" NOT NULL DEFAULT 'INACTIVE',
    "monthlyPrice" DECIMAL(12,2) NOT NULL DEFAULT 5500,
    "currency" TEXT NOT NULL DEFAULT 'LKR',
    "trialAvailable" BOOLEAN NOT NULL DEFAULT false,
    "trialDays" INTEGER,
    "integrationStatus" "IntegrationStatus" NOT NULL DEFAULT 'NOT_CONFIGURED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "saas_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saas_integration_configs" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "baseUrl" TEXT,
    "apiKeyEncrypted" TEXT,
    "signingSecretEncrypted" TEXT,
    "lastCheckedAt" TIMESTAMP(3),
    "lastCheckOk" BOOLEAN,
    "lastError" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "saas_integration_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reseller_product_access" (
    "id" TEXT NOT NULL,
    "resellerId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "status" "ResellerAccessStatus" NOT NULL DEFAULT 'ACTIVE',
    "note" TEXT,
    "grantedById" TEXT,
    "statusChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reseller_product_access_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_logs" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "operation" "IntegrationOperation" NOT NULL,
    "entityId" TEXT,
    "success" BOOLEAN NOT NULL,
    "httpStatus" INTEGER,
    "durationMs" INTEGER,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "processedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" TEXT NOT NULL,
    "resellerId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_accounts" (
    "id" TEXT NOT NULL,
    "resellerId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "externalTenantId" TEXT,
    "externalAccountId" TEXT,
    "status" "CustomerAccountStatus" NOT NULL DEFAULT 'PENDING',
    "activatedAt" TIMESTAMP(3),
    "deactivatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trial_requests" (
    "id" TEXT NOT NULL,
    "resellerId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "customerAccountId" TEXT NOT NULL,
    "status" "TrialRequestStatus" NOT NULL DEFAULT 'PENDING',
    "notes" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "saasReference" TEXT,
    "errorMessage" TEXT,
    "errorRetryable" BOOLEAN,
    "submittedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "requestedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trial_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activation_requests" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "resellerId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "customerAccountId" TEXT NOT NULL,
    "status" "ActivationRequestStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "periodMonth" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'LKR',
    "payerName" TEXT NOT NULL,
    "payerBank" TEXT,
    "transactionRef" TEXT NOT NULL,
    "transferDate" DATE NOT NULL,
    "notes" TEXT,
    "requestedById" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewerId" TEXT,
    "reviewStartedAt" TIMESTAMP(3),
    "paymentVerifiedAt" TIMESTAMP(3),
    "paymentVerifiedById" TEXT,
    "paymentVerificationNote" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decidedById" TEXT,
    "rejectionReason" TEXT,
    "activationMethod" "ActivationMethod",
    "idempotencyKey" TEXT,
    "activationAttempts" INTEGER NOT NULL DEFAULT 0,
    "saasRequestId" TEXT,
    "activationReference" TEXT,
    "activationError" TEXT,
    "activationNote" TEXT,
    "activatedAt" TIMESTAMP(3),
    "activatedById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "subscriptionEventId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "activation_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activation_status_changes" (
    "id" TEXT NOT NULL,
    "activationRequestId" TEXT NOT NULL,
    "fromStatus" "ActivationRequestStatus",
    "toStatus" "ActivationRequestStatus" NOT NULL,
    "action" TEXT NOT NULL,
    "note" TEXT,
    "internal" BOOLEAN NOT NULL DEFAULT false,
    "actorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activation_status_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_slips" (
    "id" TEXT NOT NULL,
    "resellerId" TEXT NOT NULL,
    "activationRequestId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_slips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commission_levels" (
    "level" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "minActiveCustomers" INTEGER NOT NULL,
    "maxActiveCustomers" INTEGER,
    "ratePercent" DECIMAL(5,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "commission_levels_pkey" PRIMARY KEY ("level")
);

-- CreateTable
CREATE TABLE "reseller_level_changes" (
    "id" TEXT NOT NULL,
    "resellerId" TEXT NOT NULL,
    "fromLevel" INTEGER,
    "toLevel" INTEGER,
    "activeCustomerCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reseller_level_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_events" (
    "id" TEXT NOT NULL,
    "customerAccountId" TEXT NOT NULL,
    "type" "SubscriptionEventType" NOT NULL,
    "periodMonth" TEXT NOT NULL,
    "externalRef" TEXT,
    "source" "SubscriptionEventSource" NOT NULL,
    "note" TEXT,
    "recordedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commissions" (
    "id" TEXT NOT NULL,
    "resellerId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "customerAccountId" TEXT NOT NULL,
    "subscriptionEventId" TEXT,
    "entryType" "CommissionEntryType" NOT NULL DEFAULT 'EARNING',
    "periodMonth" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "baseAmount" DECIMAL(12,2) NOT NULL,
    "rate" DECIMAL(5,2) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'LKR',
    "status" "CommissionStatus" NOT NULL DEFAULT 'PENDING',
    "payableAt" TIMESTAMP(3) NOT NULL,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "payoutId" TEXT,
    "paidAt" TIMESTAMP(3),
    "reversedAt" TIMESTAMP(3),
    "reversedById" TEXT,
    "reversalReason" TEXT,
    "reversalOfId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "commissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commission_payouts" (
    "id" TEXT NOT NULL,
    "resellerId" TEXT NOT NULL,
    "totalAmount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'LKR',
    "paymentReference" TEXT NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL,
    "paidById" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commission_payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_settings" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "actorType" "AuditActorType" NOT NULL,
    "actorUserId" TEXT,
    "actorEmail" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "resellerId" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_resellerId_idx" ON "users"("resellerId");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_tokenHash_key" ON "refresh_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "refresh_tokens_userId_idx" ON "refresh_tokens"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "resellers_code_key" ON "resellers"("code");

-- CreateIndex
CREATE UNIQUE INDEX "resellers_nicOrPassport_key" ON "resellers"("nicOrPassport");

-- CreateIndex
CREATE UNIQUE INDEX "resellers_businessRegistrationNo_key" ON "resellers"("businessRegistrationNo");

-- CreateIndex
CREATE INDEX "resellers_status_submittedAt_idx" ON "resellers"("status", "submittedAt");

-- CreateIndex
CREATE UNIQUE INDEX "reseller_bank_accounts_resellerId_key" ON "reseller_bank_accounts"("resellerId");

-- CreateIndex
CREATE UNIQUE INDEX "saas_products_code_key" ON "saas_products"("code");

-- CreateIndex
CREATE INDEX "saas_products_status_idx" ON "saas_products"("status");

-- CreateIndex
CREATE UNIQUE INDEX "saas_integration_configs_productId_key" ON "saas_integration_configs"("productId");

-- CreateIndex
CREATE INDEX "reseller_product_access_productId_status_idx" ON "reseller_product_access"("productId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "reseller_product_access_resellerId_productId_key" ON "reseller_product_access"("resellerId", "productId");

-- CreateIndex
CREATE INDEX "integration_logs_productId_createdAt_idx" ON "integration_logs"("productId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_productId_eventId_key" ON "webhook_events"("productId", "eventId");

-- CreateIndex
CREATE INDEX "customers_resellerId_idx" ON "customers"("resellerId");

-- CreateIndex
CREATE INDEX "customer_accounts_resellerId_status_idx" ON "customer_accounts"("resellerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "customer_accounts_productId_externalTenantId_key" ON "customer_accounts"("productId", "externalTenantId");

-- CreateIndex
CREATE UNIQUE INDEX "customer_accounts_customerId_productId_key" ON "customer_accounts"("customerId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "trial_requests_idempotencyKey_key" ON "trial_requests"("idempotencyKey");

-- CreateIndex
CREATE INDEX "trial_requests_resellerId_status_idx" ON "trial_requests"("resellerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "activation_requests_reference_key" ON "activation_requests"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "activation_requests_idempotencyKey_key" ON "activation_requests"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "activation_requests_subscriptionEventId_key" ON "activation_requests"("subscriptionEventId");

-- CreateIndex
CREATE INDEX "activation_requests_status_submittedAt_idx" ON "activation_requests"("status", "submittedAt");

-- CreateIndex
CREATE INDEX "activation_requests_resellerId_status_idx" ON "activation_requests"("resellerId", "status");

-- CreateIndex
CREATE INDEX "activation_requests_customerAccountId_periodMonth_idx" ON "activation_requests"("customerAccountId", "periodMonth");

-- CreateIndex
CREATE INDEX "activation_requests_productId_saasRequestId_idx" ON "activation_requests"("productId", "saasRequestId");

-- CreateIndex
CREATE INDEX "activation_status_changes_activationRequestId_createdAt_idx" ON "activation_status_changes"("activationRequestId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "bank_slips_storageKey_key" ON "bank_slips"("storageKey");

-- CreateIndex
CREATE INDEX "bank_slips_activationRequestId_idx" ON "bank_slips"("activationRequestId");

-- CreateIndex
CREATE INDEX "bank_slips_sha256_idx" ON "bank_slips"("sha256");

-- CreateIndex
CREATE INDEX "reseller_level_changes_resellerId_createdAt_idx" ON "reseller_level_changes"("resellerId", "createdAt");

-- CreateIndex
CREATE INDEX "subscription_events_customerAccountId_createdAt_idx" ON "subscription_events"("customerAccountId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_events_customerAccountId_type_periodMonth_key" ON "subscription_events"("customerAccountId", "type", "periodMonth");

-- CreateIndex
CREATE UNIQUE INDEX "commissions_reversalOfId_key" ON "commissions"("reversalOfId");

-- CreateIndex
CREATE INDEX "commissions_resellerId_status_idx" ON "commissions"("resellerId", "status");

-- CreateIndex
CREATE INDEX "commissions_resellerId_periodMonth_idx" ON "commissions"("resellerId", "periodMonth");

-- CreateIndex
CREATE INDEX "commissions_customerAccountId_periodMonth_idx" ON "commissions"("customerAccountId", "periodMonth");

-- CreateIndex
CREATE INDEX "commissions_status_payableAt_idx" ON "commissions"("status", "payableAt");

-- CreateIndex
CREATE INDEX "commission_payouts_resellerId_paidAt_idx" ON "commission_payouts"("resellerId", "paidAt");

-- CreateIndex
CREATE INDEX "notifications_userId_readAt_idx" ON "notifications"("userId", "readAt");

-- CreateIndex
CREATE INDEX "audit_logs_entityType_entityId_idx" ON "audit_logs"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "audit_logs_resellerId_createdAt_idx" ON "audit_logs"("resellerId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_actorUserId_createdAt_idx" ON "audit_logs"("actorUserId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_resellerId_fkey" FOREIGN KEY ("resellerId") REFERENCES "resellers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reseller_bank_accounts" ADD CONSTRAINT "reseller_bank_accounts_resellerId_fkey" FOREIGN KEY ("resellerId") REFERENCES "resellers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saas_integration_configs" ADD CONSTRAINT "saas_integration_configs_productId_fkey" FOREIGN KEY ("productId") REFERENCES "saas_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reseller_product_access" ADD CONSTRAINT "reseller_product_access_resellerId_fkey" FOREIGN KEY ("resellerId") REFERENCES "resellers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reseller_product_access" ADD CONSTRAINT "reseller_product_access_productId_fkey" FOREIGN KEY ("productId") REFERENCES "saas_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_logs" ADD CONSTRAINT "integration_logs_productId_fkey" FOREIGN KEY ("productId") REFERENCES "saas_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_productId_fkey" FOREIGN KEY ("productId") REFERENCES "saas_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_resellerId_fkey" FOREIGN KEY ("resellerId") REFERENCES "resellers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_accounts" ADD CONSTRAINT "customer_accounts_resellerId_fkey" FOREIGN KEY ("resellerId") REFERENCES "resellers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_accounts" ADD CONSTRAINT "customer_accounts_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_accounts" ADD CONSTRAINT "customer_accounts_productId_fkey" FOREIGN KEY ("productId") REFERENCES "saas_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trial_requests" ADD CONSTRAINT "trial_requests_resellerId_fkey" FOREIGN KEY ("resellerId") REFERENCES "resellers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trial_requests" ADD CONSTRAINT "trial_requests_productId_fkey" FOREIGN KEY ("productId") REFERENCES "saas_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trial_requests" ADD CONSTRAINT "trial_requests_customerAccountId_fkey" FOREIGN KEY ("customerAccountId") REFERENCES "customer_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activation_requests" ADD CONSTRAINT "activation_requests_resellerId_fkey" FOREIGN KEY ("resellerId") REFERENCES "resellers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activation_requests" ADD CONSTRAINT "activation_requests_productId_fkey" FOREIGN KEY ("productId") REFERENCES "saas_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activation_requests" ADD CONSTRAINT "activation_requests_customerAccountId_fkey" FOREIGN KEY ("customerAccountId") REFERENCES "customer_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activation_requests" ADD CONSTRAINT "activation_requests_subscriptionEventId_fkey" FOREIGN KEY ("subscriptionEventId") REFERENCES "subscription_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activation_status_changes" ADD CONSTRAINT "activation_status_changes_activationRequestId_fkey" FOREIGN KEY ("activationRequestId") REFERENCES "activation_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_slips" ADD CONSTRAINT "bank_slips_resellerId_fkey" FOREIGN KEY ("resellerId") REFERENCES "resellers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_slips" ADD CONSTRAINT "bank_slips_activationRequestId_fkey" FOREIGN KEY ("activationRequestId") REFERENCES "activation_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reseller_level_changes" ADD CONSTRAINT "reseller_level_changes_resellerId_fkey" FOREIGN KEY ("resellerId") REFERENCES "resellers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_events" ADD CONSTRAINT "subscription_events_customerAccountId_fkey" FOREIGN KEY ("customerAccountId") REFERENCES "customer_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commissions" ADD CONSTRAINT "commissions_resellerId_fkey" FOREIGN KEY ("resellerId") REFERENCES "resellers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commissions" ADD CONSTRAINT "commissions_productId_fkey" FOREIGN KEY ("productId") REFERENCES "saas_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commissions" ADD CONSTRAINT "commissions_customerAccountId_fkey" FOREIGN KEY ("customerAccountId") REFERENCES "customer_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commissions" ADD CONSTRAINT "commissions_subscriptionEventId_fkey" FOREIGN KEY ("subscriptionEventId") REFERENCES "subscription_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commissions" ADD CONSTRAINT "commissions_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "commission_payouts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commissions" ADD CONSTRAINT "commissions_reversalOfId_fkey" FOREIGN KEY ("reversalOfId") REFERENCES "commissions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_payouts" ADD CONSTRAINT "commission_payouts_resellerId_fkey" FOREIGN KEY ("resellerId") REFERENCES "resellers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

