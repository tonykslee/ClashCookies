ALTER TABLE "AutoRoleGuildConfig" ADD COLUMN IF NOT EXISTS "clanRoleRemovalDelayMinutes" INTEGER;

CREATE TABLE IF NOT EXISTS "AutoRolePendingRemoval" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "discordUserId" TEXT NOT NULL,
    "discordRoleId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "firstMissingAt" TIMESTAMP(3) NOT NULL,
    "lastCheckedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutoRolePendingRemoval_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AutoRolePendingRemoval_guildId_discordUserId_discordRoleId_ruleId_key"
    ON "AutoRolePendingRemoval"("guildId", "discordUserId", "discordRoleId", "ruleId");
CREATE INDEX IF NOT EXISTS "AutoRolePendingRemoval_guildId_discordUserId_idx"
    ON "AutoRolePendingRemoval"("guildId", "discordUserId");
CREATE INDEX IF NOT EXISTS "AutoRolePendingRemoval_guildId_firstMissingAt_idx"
    ON "AutoRolePendingRemoval"("guildId", "firstMissingAt");
