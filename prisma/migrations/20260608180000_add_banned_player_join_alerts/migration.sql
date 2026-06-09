-- CreateTable
CREATE TABLE "BannedPlayerJoinAlert" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "playerTag" VARCHAR(16) NOT NULL,
    "clanTag" VARCHAR(16) NOT NULL,
    "playerName" TEXT NOT NULL,
    "clanName" TEXT NOT NULL,
    "banRecordId" TEXT,
    "alertedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BannedPlayerJoinAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BannedPlayerJoinAlert_guildId_playerTag_idx" ON "BannedPlayerJoinAlert"("guildId", "playerTag");

-- CreateIndex
CREATE INDEX "BannedPlayerJoinAlert_guildId_clanTag_idx" ON "BannedPlayerJoinAlert"("guildId", "clanTag");

-- CreateIndex
CREATE UNIQUE INDEX "BannedPlayerJoinAlert_guildId_playerTag_clanTag_key" ON "BannedPlayerJoinAlert"("guildId", "playerTag", "clanTag");
