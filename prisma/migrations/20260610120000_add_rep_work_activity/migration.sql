CREATE TYPE "RepWorkActivityType" AS ENUM ('BASES_CHECKED', 'MAIL_CHECKED');

CREATE TABLE "RepWorkActivityEvent" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "activityType" "RepWorkActivityType" NOT NULL,
    "discordUserId" TEXT NOT NULL,
    "clanTag" TEXT NOT NULL,
    "syncMessageId" TEXT,
    "sourceMessageId" TEXT NOT NULL,
    "sourceTrackedMessageId" TEXT,
    "warId" TEXT,
    "warStartTime" TIMESTAMP(3),
    "opponentTag" TEXT,
    "eventAt" TIMESTAMP(3) NOT NULL,
    "prepTimeLeftSeconds" INTEGER,
    "metadata" JSONB,
    "dedupeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RepWorkActivityEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RepWorkActivityEvent_dedupeKey_key" ON "RepWorkActivityEvent"("dedupeKey");
CREATE INDEX "RepWorkActivityEvent_guildId_eventAt_idx" ON "RepWorkActivityEvent"("guildId", "eventAt");
CREATE INDEX "RepWorkActivityEvent_guildId_discordUserId_eventAt_idx" ON "RepWorkActivityEvent"("guildId", "discordUserId", "eventAt");
CREATE INDEX "RepWorkActivityEvent_guildId_activityType_eventAt_idx" ON "RepWorkActivityEvent"("guildId", "activityType", "eventAt");
CREATE INDEX "RepWorkActivityEvent_guildId_clanTag_eventAt_idx" ON "RepWorkActivityEvent"("guildId", "clanTag", "eventAt");
CREATE INDEX "RepWorkActivityEvent_syncMessageId_idx" ON "RepWorkActivityEvent"("syncMessageId");
