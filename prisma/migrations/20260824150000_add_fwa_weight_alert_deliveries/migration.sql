CREATE TYPE "FwaWeightAlertDeliveryStatus" AS ENUM ('CLAIMED', 'SENT', 'FAILED');

CREATE TABLE "FwaWeightAlertDelivery" (
    "id" TEXT NOT NULL,
    "clanTag" TEXT NOT NULL,
    "weightSubmitDate" TIMESTAMP(3) NOT NULL,
    "status" "FwaWeightAlertDeliveryStatus" NOT NULL DEFAULT 'CLAIMED',
    "claimToken" TEXT,
    "claimedAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "discordMessageId" TEXT,
    "failureCode" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FwaWeightAlertDelivery_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "FwaWeightAlertDelivery_clanTag_fkey"
      FOREIGN KEY ("clanTag") REFERENCES "TrackedClan"("tag") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "FwaWeightAlertDelivery_clanTag_weightSubmitDate_key"
    ON "FwaWeightAlertDelivery"("clanTag", "weightSubmitDate");
CREATE INDEX "FwaWeightAlertDelivery_status_claimedAt_idx"
    ON "FwaWeightAlertDelivery"("status", "claimedAt");
CREATE INDEX "FwaWeightAlertDelivery_clanTag_createdAt_idx"
    ON "FwaWeightAlertDelivery"("clanTag", "createdAt");
