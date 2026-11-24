CREATE TYPE "FwaAccountabilityNotificationEventType" AS ENUM ('BASES_CHECKED', 'MAIL_POSTED', 'MAIL_CONFIRMED');
CREATE TYPE "FwaAccountabilityNotificationStatus" AS ENUM ('CLAIMED', 'SENT', 'FAILED', 'UNKNOWN');

CREATE TABLE "FwaAccountabilityNotification" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "clanTag" TEXT NOT NULL,
    "eventType" "FwaAccountabilityNotificationEventType" NOT NULL,
    "eventKey" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "status" "FwaAccountabilityNotificationStatus" NOT NULL DEFAULT 'CLAIMED',
    "claimToken" TEXT,
    "claimedAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "channelId" TEXT,
    "messageId" TEXT,
    "messageUrl" TEXT,
    "failureCode" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FwaAccountabilityNotification_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FwaAccountabilityNotification_guildId_eventType_eventKey_key"
    ON "FwaAccountabilityNotification"("guildId", "eventType", "eventKey");
CREATE INDEX "FwaAccountabilityNotification_guildId_clanTag_eventType_idx"
    ON "FwaAccountabilityNotification"("guildId", "clanTag", "eventType");
CREATE INDEX "FwaAccountabilityNotification_status_claimedAt_idx"
    ON "FwaAccountabilityNotification"("status", "claimedAt");
