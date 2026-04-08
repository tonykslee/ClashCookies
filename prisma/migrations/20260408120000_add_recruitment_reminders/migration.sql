CREATE TABLE "RecruitmentReminderRule" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "discordUserId" TEXT NOT NULL,
    "clanTag" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "nextReminderAt" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastSentAt" TIMESTAMP(3),
    "clanNameSnapshot" TEXT,
    "templateSubject" TEXT,
    "templateBody" TEXT NOT NULL,
    "templateImageUrls" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RecruitmentReminderRule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RecruitmentReminderDelivery" (
    "id" TEXT NOT NULL,
    "reminderRuleId" TEXT NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "errorDetails" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RecruitmentReminderDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RecruitmentReminderRule_guildId_discordUserId_clanTag_platform_key"
ON "RecruitmentReminderRule"("guildId", "discordUserId", "clanTag", "platform");

CREATE INDEX "RecruitmentReminderRule_guildId_discordUserId_isActive_idx"
ON "RecruitmentReminderRule"("guildId", "discordUserId", "isActive");

CREATE INDEX "RecruitmentReminderRule_guildId_nextReminderAt_isActive_idx"
ON "RecruitmentReminderRule"("guildId", "nextReminderAt", "isActive");

CREATE INDEX "RecruitmentReminderRule_guildId_clanTag_platform_idx"
ON "RecruitmentReminderRule"("guildId", "clanTag", "platform");

CREATE UNIQUE INDEX "RecruitmentReminderDelivery_reminderRuleId_scheduledFor_key"
ON "RecruitmentReminderDelivery"("reminderRuleId", "scheduledFor");

CREATE INDEX "RecruitmentReminderDelivery_status_createdAt_idx"
ON "RecruitmentReminderDelivery"("status", "createdAt");

CREATE INDEX "RecruitmentReminderDelivery_reminderRuleId_createdAt_idx"
ON "RecruitmentReminderDelivery"("reminderRuleId", "createdAt");

ALTER TABLE "RecruitmentReminderDelivery"
ADD CONSTRAINT "RecruitmentReminderDelivery_reminderRuleId_fkey"
FOREIGN KEY ("reminderRuleId") REFERENCES "RecruitmentReminderRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
