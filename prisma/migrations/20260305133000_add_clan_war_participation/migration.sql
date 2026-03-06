CREATE TABLE "ClanWarParticipation" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "warId" TEXT NOT NULL,
    "clanTag" TEXT NOT NULL,
    "opponentTag" TEXT,
    "playerTag" TEXT NOT NULL,
    "playerName" TEXT,
    "townHall" INTEGER,
    "attacksUsed" INTEGER NOT NULL,
    "attacksMissed" INTEGER NOT NULL,
    "starsEarned" INTEGER NOT NULL,
    "trueStars" INTEGER NOT NULL,
    "missedBoth" BOOLEAN NOT NULL,
    "firstAttackAt" TIMESTAMP(3),
    "attackDelayMinutes" INTEGER,
    "attackWindowMissed" BOOLEAN,
    "matchType" TEXT NOT NULL,
    "warStartTime" TIMESTAMP(3) NOT NULL,
    "warEndTime" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClanWarParticipation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ClanWarParticipation_guildId_warId_playerTag_key"
ON "ClanWarParticipation"("guildId", "warId", "playerTag");

CREATE INDEX "ClanWarParticipation_guildId_clanTag_warStartTime_idx"
ON "ClanWarParticipation"("guildId", "clanTag", "warStartTime");

CREATE INDEX "ClanWarParticipation_guildId_playerTag_idx"
ON "ClanWarParticipation"("guildId", "playerTag");

CREATE INDEX "ClanWarParticipation_warId_idx"
ON "ClanWarParticipation"("warId");

CREATE INDEX "ClanWarParticipation_guildId_clanTag_matchType_missedBoth_warStartTime_idx"
ON "ClanWarParticipation"("guildId", "clanTag", "matchType", "missedBoth", "warStartTime");
