-- CreateEnum
CREATE TYPE "DemoRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'DEMO_CREATED', 'CONFIRMED');

-- CreateTable
CREATE TABLE "demo_requests" (
    "id" TEXT NOT NULL,
    "resellerId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "status" "DemoRequestStatus" NOT NULL DEFAULT 'PENDING',
    "businessName" TEXT NOT NULL,
    "contactName" TEXT NOT NULL,
    "contactEmail" TEXT NOT NULL,
    "contactPhone" TEXT NOT NULL,
    "notes" TEXT,
    "requestedById" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "shopName" TEXT,
    "planName" TEXT,
    "loginUrl" TEXT,
    "shopUrl" TEXT,
    "accessUsername" TEXT,
    "accessInstructions" TEXT,
    "demoCreatedAt" TIMESTAMP(3),
    "demoCreatedById" TEXT,
    "welcomeMessage" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "confirmedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "demo_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "demo_request_status_changes" (
    "id" TEXT NOT NULL,
    "demoRequestId" TEXT NOT NULL,
    "fromStatus" "DemoRequestStatus",
    "toStatus" "DemoRequestStatus" NOT NULL,
    "action" TEXT NOT NULL,
    "note" TEXT,
    "internal" BOOLEAN NOT NULL DEFAULT false,
    "actorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "demo_request_status_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "demo_requests_resellerId_status_idx" ON "demo_requests"("resellerId", "status");

-- CreateIndex
CREATE INDEX "demo_requests_productId_status_idx" ON "demo_requests"("productId", "status");

-- CreateIndex
CREATE INDEX "demo_requests_status_submittedAt_idx" ON "demo_requests"("status", "submittedAt");

-- CreateIndex
CREATE INDEX "demo_requests_resellerId_productId_contactEmail_status_idx" ON "demo_requests"("resellerId", "productId", "contactEmail", "status");

-- CreateIndex
CREATE INDEX "demo_request_status_changes_demoRequestId_createdAt_idx" ON "demo_request_status_changes"("demoRequestId", "createdAt");

-- AddForeignKey
ALTER TABLE "demo_requests" ADD CONSTRAINT "demo_requests_resellerId_fkey" FOREIGN KEY ("resellerId") REFERENCES "resellers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "demo_requests" ADD CONSTRAINT "demo_requests_productId_fkey" FOREIGN KEY ("productId") REFERENCES "saas_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "demo_request_status_changes" ADD CONSTRAINT "demo_request_status_changes_demoRequestId_fkey" FOREIGN KEY ("demoRequestId") REFERENCES "demo_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
