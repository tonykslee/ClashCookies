-- CreateEnum
CREATE TYPE "BanTargetKind" AS ENUM ('PLAYER', 'USER');

-- CreateTable
CREATE TABLE "BanRecord" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "targetKind" "BanTargetKind" NOT NULL,
    "playerTag" VARCHAR(16),
    "discordUserId" TEXT,
    "reason" TEXT,
    "bannedByDiscordUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "removedAt" TIMESTAMP(3),
    "removedByDiscordUserId" TEXT,
    "removeReason" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BanRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BanRecord_guildId_targetKind_idx" ON "BanRecord"("guildId", "targetKind");

-- CreateIndex
CREATE INDEX "BanRecord_guildId_playerTag_idx" ON "BanRecord"("guildId", "playerTag");

-- CreateIndex
CREATE INDEX "BanRecord_guildId_discordUserId_idx" ON "BanRecord"("guildId", "discordUserId");

-- CreateIndex
CREATE INDEX "BanRecord_guildId_removedAt_expiresAt_idx" ON "BanRecord"("guildId", "removedAt", "expiresAt");
