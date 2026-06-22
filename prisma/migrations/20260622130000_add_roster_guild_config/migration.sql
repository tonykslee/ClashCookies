-- Add guild-scoped default roster board columns.
CREATE TABLE "RosterGuildConfig" (
  "guildId" TEXT NOT NULL,
  "defaultDisplayColumns" TEXT[] NOT NULL,
  "updatedByDiscordUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "RosterGuildConfig_pkey" PRIMARY KEY ("guildId")
);
