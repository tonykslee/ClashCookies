-- CreateEnum
CREATE TYPE "ScheduledSyncPostStatus" AS ENUM ('PENDING', 'CLAIMED', 'PUBLISHED', 'FAILED', 'CANCELLED', 'REPLACED');

-- CreateTable
CREATE TABLE "ScheduledSyncPost" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "syncTime" TIMESTAMP(3) NOT NULL,
    "publishAt" TIMESTAMP(3) NOT NULL,
    "timezone" TEXT,
    "status" "ScheduledSyncPostStatus" NOT NULL DEFAULT 'PENDING',
    "claimToken" TEXT,
    "claimedAt" TIMESTAMP(3),
    "publishedMessageId" TEXT,
    "publishedAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "failureCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduledSyncPost_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ScheduledSyncPost_guildId_syncTime_key" ON "ScheduledSyncPost"("guildId", "syncTime");

-- CreateIndex
CREATE INDEX "ScheduledSyncPost_guildId_status_publishAt_idx" ON "ScheduledSyncPost"("guildId", "status", "publishAt");

-- CreateIndex
CREATE INDEX "ScheduledSyncPost_status_publishAt_idx" ON "ScheduledSyncPost"("status", "publishAt");

-- CreateIndex
CREATE INDEX "ScheduledSyncPost_nextAttemptAt_idx" ON "ScheduledSyncPost"("nextAttemptAt");
