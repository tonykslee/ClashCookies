CREATE TABLE "ClanPointsSync" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "clanTag" TEXT NOT NULL,
    "warId" TEXT,
    "warStartTime" TIMESTAMP(3) NOT NULL,
    "syncNum" INTEGER NOT NULL,
    "opponentTag" TEXT NOT NULL,
    "clanPoints" INTEGER NOT NULL,
    "opponentPoints" INTEGER NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClanPointsSync_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ClanPointsSync_guildId_clanTag_warStartTime_key"
ON "ClanPointsSync"("guildId", "clanTag", "warStartTime");

CREATE INDEX "ClanPointsSync_guildId_clanTag_idx"
ON "ClanPointsSync"("guildId", "clanTag");

CREATE INDEX "ClanPointsSync_clanTag_warStartTime_idx"
ON "ClanPointsSync"("clanTag", "warStartTime");

CREATE INDEX "ClanPointsSync_guildId_clanTag_warId_idx"
ON "ClanPointsSync"("guildId", "clanTag", "warId");
