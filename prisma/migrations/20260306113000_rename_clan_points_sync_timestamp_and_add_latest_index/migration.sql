ALTER TABLE "ClanPointsSync"
RENAME COLUMN "syncedAt" TO "syncFetchedAt";

CREATE INDEX "ClanPointsSync_guildId_clanTag_warStartTime_idx"
ON "ClanPointsSync"("guildId", "clanTag", "warStartTime" DESC);
