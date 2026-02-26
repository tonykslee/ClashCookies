CREATE TABLE "WarEventLogSubscription" (
  "id" SERIAL NOT NULL,
  "guildId" TEXT NOT NULL,
  "clanTag" TEXT NOT NULL,
  "channelId" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "lastState" TEXT,
  "lastWarStartTime" TIMESTAMP(3),
  "lastOpponentTag" TEXT,
  "lastOpponentName" TEXT,
  "lastClanName" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WarEventLogSubscription_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WarEventLogSubscription_guildId_clanTag_key"
ON "WarEventLogSubscription"("guildId", "clanTag");

CREATE INDEX "WarEventLogSubscription_guildId_enabled_idx"
ON "WarEventLogSubscription"("guildId", "enabled");
