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

-- Enforce one active ban per player target within a guild.
CREATE UNIQUE INDEX "BanRecord_active_player_unique" ON "BanRecord"("guildId", "playerTag")
WHERE "targetKind" = 'PLAYER' AND "removedAt" IS NULL;

-- Enforce one active ban per discord user target within a guild.
CREATE UNIQUE INDEX "BanRecord_active_user_unique" ON "BanRecord"("guildId", "discordUserId")
WHERE "targetKind" = 'USER' AND "removedAt" IS NULL;
