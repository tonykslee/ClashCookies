CREATE TABLE "FillerAccount" (
  "id" TEXT NOT NULL,
  "guildId" TEXT NOT NULL,
  "playerTag" TEXT NOT NULL,
  "createdByDiscordUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "FillerAccount_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FillerAccount_guildId_playerTag_key"
ON "FillerAccount"("guildId", "playerTag");

CREATE INDEX "FillerAccount_guildId_idx"
ON "FillerAccount"("guildId");

CREATE INDEX "FillerAccount_playerTag_idx"
ON "FillerAccount"("playerTag");
