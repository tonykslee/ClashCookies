ALTER TABLE "PlayerLink"
ALTER COLUMN "discordUserId" DROP NOT NULL;

CREATE INDEX "PlayerLink_discordUserId_idx"
  ON "PlayerLink"("discordUserId");

CREATE TABLE "UnlinkedAlertConfig" (
  "guildId" TEXT NOT NULL,
  "channelId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "UnlinkedAlertConfig_pkey" PRIMARY KEY ("guildId")
);

CREATE TABLE "UnlinkedPlayer" (
  "guildId" TEXT NOT NULL,
  "playerTag" TEXT NOT NULL,
  "playerName" TEXT NOT NULL,
  "clanTag" TEXT NOT NULL,
  "clanName" TEXT NOT NULL,
  "alertedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "UnlinkedPlayer_pkey" PRIMARY KEY ("guildId", "playerTag")
);

CREATE INDEX "UnlinkedPlayer_guildId_clanTag_idx"
  ON "UnlinkedPlayer"("guildId", "clanTag");

CREATE INDEX "UnlinkedPlayer_guildId_alertedAt_idx"
  ON "UnlinkedPlayer"("guildId", "alertedAt");
