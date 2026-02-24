-- CreateEnum
CREATE TYPE "KickListSource" AS ENUM ('AUTO_INACTIVE', 'MANUAL');

-- CreateTable
CREATE TABLE "PlayerLink" (
    "playerTag" TEXT NOT NULL,
    "discordUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlayerLink_pkey" PRIMARY KEY ("playerTag")
);

-- CreateTable
CREATE TABLE "KickListEntry" (
    "id" SERIAL NOT NULL,
    "guildId" TEXT NOT NULL,
    "playerTag" TEXT NOT NULL,
    "playerName" TEXT,
    "clanTag" TEXT,
    "clanName" TEXT,
    "reason" TEXT NOT NULL,
    "source" "KickListSource" NOT NULL,
    "daysThreshold" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KickListEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KickListEntry_guildId_playerTag_idx" ON "KickListEntry"("guildId", "playerTag");

-- CreateIndex
CREATE INDEX "KickListEntry_guildId_source_idx" ON "KickListEntry"("guildId", "source");

-- CreateIndex
CREATE UNIQUE INDEX "KickListEntry_guildId_playerTag_source_key" ON "KickListEntry"("guildId", "playerTag", "source");
