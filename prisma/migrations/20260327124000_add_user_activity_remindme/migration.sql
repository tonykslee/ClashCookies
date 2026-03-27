CREATE TYPE "UserActivityReminderType" AS ENUM ('WAR', 'CWL', 'RAIDS', 'GAMES');

CREATE TYPE "UserActivityReminderMethod" AS ENUM ('DM', 'PING_HERE');

CREATE TYPE "UserActivityReminderDeliveryStatus" AS ENUM ('SENT', 'FAILED', 'SKIPPED');

CREATE TABLE "UserActivityReminderRule" (
    "id" TEXT NOT NULL,
    "discordUserId" TEXT NOT NULL,
    "type" "UserActivityReminderType" NOT NULL,
    "playerTag" TEXT NOT NULL,
    "method" "UserActivityReminderMethod" NOT NULL,
    "offsetMinutes" INTEGER NOT NULL,
    "surfaceGuildId" TEXT,
    "surfaceChannelId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserActivityReminderRule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UserActivityReminderDelivery" (
    "id" TEXT NOT NULL,
    "reminderRuleId" TEXT NOT NULL,
    "eventInstanceKey" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "deliveryStatus" "UserActivityReminderDeliveryStatus" NOT NULL DEFAULT 'SENT',
    "deliverySurface" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserActivityReminderDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserActivityReminderRule_discordUserId_type_playerTag_method_offsetMinutes_key" ON "UserActivityReminderRule"("discordUserId", "type", "playerTag", "method", "offsetMinutes");
CREATE INDEX "UserActivityReminderRule_discordUserId_isActive_idx" ON "UserActivityReminderRule"("discordUserId", "isActive");
CREATE INDEX "UserActivityReminderRule_type_playerTag_isActive_idx" ON "UserActivityReminderRule"("type", "playerTag", "isActive");

CREATE UNIQUE INDEX "UserActivityReminderDelivery_reminderRuleId_eventInstanceKey_key" ON "UserActivityReminderDelivery"("reminderRuleId", "eventInstanceKey");
CREATE INDEX "UserActivityReminderDelivery_deliveryStatus_createdAt_idx" ON "UserActivityReminderDelivery"("deliveryStatus", "createdAt");
CREATE INDEX "UserActivityReminderDelivery_reminderRuleId_createdAt_idx" ON "UserActivityReminderDelivery"("reminderRuleId", "createdAt");

ALTER TABLE "UserActivityReminderDelivery" ADD CONSTRAINT "UserActivityReminderDelivery_reminderRuleId_fkey" FOREIGN KEY ("reminderRuleId") REFERENCES "UserActivityReminderRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
