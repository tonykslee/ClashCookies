-- CreateEnum
CREATE TYPE "LayoutAlertDeliveryStatus" AS ENUM ('CLAIMED', 'SENT', 'FAILED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "LayoutAlertDeliveryTarget" AS ENUM ('DM', 'CHANNEL');

-- CreateTable
CREATE TABLE "LayoutAlertDelivery" (
    "id" TEXT NOT NULL,
    "layoutId" TEXT NOT NULL,
    "freshnessAnchorAt" TIMESTAMP(3) NOT NULL,
    "target" "LayoutAlertDeliveryTarget" NOT NULL,
    "status" "LayoutAlertDeliveryStatus" NOT NULL,
    "claimToken" TEXT,
    "claimedAt" TIMESTAMP(3),
    "lastAttemptAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMP(3),
    "destinationId" TEXT,
    "discordMessageId" TEXT,
    "failureCode" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LayoutAlertDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LayoutAlertDelivery_layoutId_freshnessAnchorAt_target_key" ON "LayoutAlertDelivery"("layoutId", "freshnessAnchorAt", "target");

-- CreateIndex
CREATE INDEX "LayoutAlertDelivery_status_claimedAt_idx" ON "LayoutAlertDelivery"("status", "claimedAt");

-- CreateIndex
CREATE INDEX "LayoutAlertDelivery_status_lastAttemptAt_idx" ON "LayoutAlertDelivery"("status", "lastAttemptAt");

-- AddForeignKey
ALTER TABLE "LayoutAlertDelivery" ADD CONSTRAINT "LayoutAlertDelivery_layoutId_fkey" FOREIGN KEY ("layoutId") REFERENCES "LayoutRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;
