-- Persist restart-safe Home Away reminder schedules and immutable recipient payloads.
CREATE TYPE "HomeAwaySyncAlertScheduleStatus" AS ENUM ('PENDING', 'CLAIMED', 'EVALUATED', 'COMPLETED', 'EXPIRED', 'CANCELLED');
CREATE TYPE "HomeAwaySyncAlertDeliveryStatus" AS ENUM ('PENDING', 'CLAIMED', 'SENT', 'FAILED', 'EXPIRED');

CREATE TABLE "HomeAwaySyncAlertSchedule" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "scheduledSyncPostId" TEXT NOT NULL,
    "syncTime" TIMESTAMP(3) NOT NULL,
    "fireAt" TIMESTAMP(3) NOT NULL,
    "status" "HomeAwaySyncAlertScheduleStatus" NOT NULL DEFAULT 'PENDING',
    "claimToken" TEXT,
    "claimedAt" TIMESTAMP(3),
    "evaluatedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "failureCode" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HomeAwaySyncAlertSchedule_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HomeAwaySyncAlertSchedule_scheduledSyncPostId_key"
    ON "HomeAwaySyncAlertSchedule"("scheduledSyncPostId");
CREATE UNIQUE INDEX "HomeAwaySyncAlertSchedule_guildId_syncTime_key"
    ON "HomeAwaySyncAlertSchedule"("guildId", "syncTime");
CREATE INDEX "HomeAwaySyncAlertSchedule_status_fireAt_idx"
    ON "HomeAwaySyncAlertSchedule"("status", "fireAt");
CREATE INDEX "HomeAwaySyncAlertSchedule_guildId_status_syncTime_idx"
    ON "HomeAwaySyncAlertSchedule"("guildId", "status", "syncTime");

CREATE TABLE "HomeAwaySyncAlertDelivery" (
    "id" TEXT NOT NULL,
    "alertScheduleId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "discordUserId" TEXT NOT NULL,
    "messageContent" TEXT NOT NULL,
    "status" "HomeAwaySyncAlertDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "claimToken" TEXT,
    "claimedAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "failureCode" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HomeAwaySyncAlertDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HomeAwaySyncAlertDelivery_alertScheduleId_discordUserId_key"
    ON "HomeAwaySyncAlertDelivery"("alertScheduleId", "discordUserId");
CREATE INDEX "HomeAwaySyncAlertDelivery_alertScheduleId_status_nextAttemptAt_idx"
    ON "HomeAwaySyncAlertDelivery"("alertScheduleId", "status", "nextAttemptAt");
CREATE INDEX "HomeAwaySyncAlertDelivery_guildId_status_nextAttemptAt_idx"
    ON "HomeAwaySyncAlertDelivery"("guildId", "status", "nextAttemptAt");
