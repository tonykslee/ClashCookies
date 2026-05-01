CREATE TYPE "AutoRoleRuleType" AS ENUM ('VERIFIED', 'FAMILY', 'CLAN', 'CLAN_ROLE', 'TOWN_HALL', 'LABEL');

CREATE TABLE "AutoRoleGuildConfig" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "killSwitchEnabled" BOOLEAN NOT NULL DEFAULT false,
    "removeStaleManagedRoles" BOOLEAN NOT NULL DEFAULT false,
    "applyNicknames" BOOLEAN NOT NULL DEFAULT false,
    "nicknameTemplate" TEXT,
    "trustedLinksAllowed" BOOLEAN NOT NULL DEFAULT true,
    "verifiedOnlyMode" BOOLEAN NOT NULL DEFAULT false,
    "syncEnabled" BOOLEAN NOT NULL DEFAULT false,
    "syncIntervalMinutes" INTEGER,
    "verifiedRoleId" TEXT,
    "familyRoleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutoRoleGuildConfig_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AutoRoleRule" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "type" "AutoRoleRuleType" NOT NULL,
    "targetValue" TEXT NOT NULL,
    "discordRoleId" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 1000,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutoRoleRule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AutoRoleUserExclusion" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "discordUserId" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutoRoleUserExclusion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AutoRoleRoleExclusion" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "discordRoleId" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutoRoleRoleExclusion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AutoRoleMemberState" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "discordUserId" TEXT NOT NULL,
    "lastEvaluatedAt" TIMESTAMP(3),
    "lastAppliedAt" TIMESTAMP(3),
    "lastResultHash" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutoRoleMemberState_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AutoRoleSyncRun" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "evaluatedCount" INTEGER,
    "appliedCount" INTEGER,
    "removedCount" INTEGER,
    "skippedCount" INTEGER,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutoRoleSyncRun_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AutoRoleGuildConfig_guildId_key" ON "AutoRoleGuildConfig"("guildId");
CREATE UNIQUE INDEX "AutoRoleRule_guildId_type_targetValue_discordRoleId_key" ON "AutoRoleRule"("guildId", "type", "targetValue", "discordRoleId");
CREATE UNIQUE INDEX "AutoRoleUserExclusion_guildId_discordUserId_key" ON "AutoRoleUserExclusion"("guildId", "discordUserId");
CREATE UNIQUE INDEX "AutoRoleRoleExclusion_guildId_discordRoleId_key" ON "AutoRoleRoleExclusion"("guildId", "discordRoleId");
CREATE UNIQUE INDEX "AutoRoleMemberState_guildId_discordUserId_key" ON "AutoRoleMemberState"("guildId", "discordUserId");

CREATE INDEX "AutoRoleGuildConfig_enabled_killSwitchEnabled_idx" ON "AutoRoleGuildConfig"("enabled", "killSwitchEnabled");
CREATE INDEX "AutoRoleRule_guildId_enabled_priority_idx" ON "AutoRoleRule"("guildId", "enabled", "priority");
CREATE INDEX "AutoRoleRule_guildId_type_idx" ON "AutoRoleRule"("guildId", "type");
CREATE INDEX "AutoRoleUserExclusion_guildId_createdAt_idx" ON "AutoRoleUserExclusion"("guildId", "createdAt");
CREATE INDEX "AutoRoleRoleExclusion_guildId_createdAt_idx" ON "AutoRoleRoleExclusion"("guildId", "createdAt");
CREATE INDEX "AutoRoleMemberState_guildId_lastEvaluatedAt_idx" ON "AutoRoleMemberState"("guildId", "lastEvaluatedAt");
CREATE INDEX "AutoRoleSyncRun_guildId_startedAt_idx" ON "AutoRoleSyncRun"("guildId", "startedAt");
CREATE INDEX "AutoRoleSyncRun_guildId_status_startedAt_idx" ON "AutoRoleSyncRun"("guildId", "status", "startedAt");
