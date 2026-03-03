ALTER TABLE "CurrentWar"
  ADD COLUMN "currentSyncNum" INTEGER;

UPDATE "CurrentWar" c
SET "currentSyncNum" = h."syncNumber"
FROM "ClanWarHistory" h
WHERE c."currentSyncNum" IS NULL
  AND c."warId" IS NOT NULL
  AND h."warId" = c."warId"
  AND h."syncNumber" IS NOT NULL;

UPDATE "CurrentWar" c
SET "currentSyncNum" = h."syncNumber"
FROM "ClanWarHistory" h
WHERE c."currentSyncNum" IS NULL
  AND c."lastWarStartTime" IS NOT NULL
  AND h."warStartTime" = c."lastWarStartTime"
  AND UPPER(REPLACE(COALESCE(h."clanTag", ''), '#', '')) = UPPER(REPLACE(COALESCE(c."clanTag", ''), '#', ''))
  AND h."syncNumber" IS NOT NULL;
