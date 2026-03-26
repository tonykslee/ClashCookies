CREATE TYPE "ReminderType" AS ENUM ('WAR_CWL', 'RAIDS', 'GAMES', 'EVENT');

CREATE TYPE "ReminderTargetClanType" AS ENUM ('FWA', 'CWL');

CREATE TYPE "ReminderDispatchStatus" AS ENUM ('SENT', 'FAILED');

CREATE TABLE "Reminder" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "type" "ReminderType" NOT NULL,
    "channelId" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdByUserId" TEXT NOT NULL,
    "updatedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Reminder_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ReminderTimeOffset" (
    "id" SERIAL NOT NULL,
    "reminderId" TEXT NOT NULL,
    "offsetSeconds" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReminderTimeOffset_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ReminderTargetClan" (
    "id" SERIAL NOT NULL,
    "reminderId" TEXT NOT NULL,
    "clanTag" TEXT NOT NULL,
    "clanType" "ReminderTargetClanType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReminderTargetClan_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ReminderFireLog" (
    "id" TEXT NOT NULL,
    "reminderId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "clanTag" TEXT NOT NULL,
    "reminderType" "ReminderType" NOT NULL,
    "offsetSeconds" INTEGER NOT NULL,
    "eventIdentity" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "dispatchStatus" "ReminderDispatchStatus" NOT NULL DEFAULT 'SENT',
    "messageId" TEXT,
    "errorMessage" TEXT,
    "dispatchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReminderFireLog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReminderTimeOffset_reminderId_offsetSeconds_key" ON "ReminderTimeOffset"("reminderId", "offsetSeconds");
CREATE UNIQUE INDEX "ReminderTargetClan_reminderId_clanTag_clanType_key" ON "ReminderTargetClan"("reminderId", "clanTag", "clanType");
CREATE UNIQUE INDEX "ReminderFireLog_dedupeKey_key" ON "ReminderFireLog"("dedupeKey");

CREATE INDEX "Reminder_guildId_type_idx" ON "Reminder"("guildId", "type");
CREATE INDEX "Reminder_guildId_isEnabled_idx" ON "Reminder"("guildId", "isEnabled");
CREATE INDEX "Reminder_createdAt_idx" ON "Reminder"("createdAt");
CREATE INDEX "ReminderTimeOffset_offsetSeconds_idx" ON "ReminderTimeOffset"("offsetSeconds");
CREATE INDEX "ReminderTargetClan_clanTag_idx" ON "ReminderTargetClan"("clanTag");
CREATE INDEX "ReminderTargetClan_clanType_clanTag_idx" ON "ReminderTargetClan"("clanType", "clanTag");
CREATE INDEX "ReminderFireLog_reminderId_dispatchedAt_idx" ON "ReminderFireLog"("reminderId", "dispatchedAt");
CREATE INDEX "ReminderFireLog_guildId_dispatchedAt_idx" ON "ReminderFireLog"("guildId", "dispatchedAt");
CREATE INDEX "ReminderFireLog_guildId_clanTag_dispatchedAt_idx" ON "ReminderFireLog"("guildId", "clanTag", "dispatchedAt");

ALTER TABLE "ReminderTimeOffset" ADD CONSTRAINT "ReminderTimeOffset_reminderId_fkey" FOREIGN KEY ("reminderId") REFERENCES "Reminder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReminderTargetClan" ADD CONSTRAINT "ReminderTargetClan_reminderId_fkey" FOREIGN KEY ("reminderId") REFERENCES "Reminder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReminderFireLog" ADD CONSTRAINT "ReminderFireLog_reminderId_fkey" FOREIGN KEY ("reminderId") REFERENCES "Reminder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
