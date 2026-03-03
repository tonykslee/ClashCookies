ALTER TABLE "WarHistoryAttack"
  ADD COLUMN "warId" INTEGER,
  ADD COLUMN "attacksUsed" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "WarEventLogSubscription"
  ADD COLUMN "warId" INTEGER;

-- Backfill synthetic participant row (attackOrder=0) from legacy participant table.
INSERT INTO "WarHistoryAttack"
  ("clanTag","clanName","opponentClanTag","opponentClanName","warStartTime","warEndTime","warState","playerTag","playerName","playerPosition","attacksUsed","attackOrder","attackNumber","defenderTag","defenderName","defenderPosition","stars","trueStars","destruction","attackSeenAt","createdAt","updatedAt")
SELECT
  p."clanTag",
  p."clanName",
  p."opponentClanTag",
  p."opponentClanName",
  p."warStartTime",
  p."warEndTime",
  p."warState",
  p."playerTag",
  p."playerName",
  p."playerPosition",
  p."attacksUsed",
  0,
  0,
  NULL,
  NULL,
  NULL,
  0,
  0,
  0,
  p."updatedAt",
  p."createdAt",
  p."updatedAt"
FROM "WarHistoryParticipant" p
WHERE NOT EXISTS (
  SELECT 1
  FROM "WarHistoryAttack" a
  WHERE a."clanTag" = p."clanTag"
    AND a."warStartTime" = p."warStartTime"
    AND a."playerTag" = p."playerTag"
    AND a."attackOrder" = 0
);

-- Prefer attacksUsed from legacy participant rows when available.
UPDATE "WarHistoryAttack" a
SET "attacksUsed" = p."attacksUsed"
FROM "WarHistoryParticipant" p
WHERE a."clanTag" = p."clanTag"
  AND a."warStartTime" = p."warStartTime"
  AND a."playerTag" = p."playerTag";

-- Fallback attacksUsed from recorded attack rows when participant row is absent.
WITH attack_counts AS (
  SELECT
    "clanTag",
    "warStartTime",
    "playerTag",
    COUNT(*) FILTER (WHERE "attackNumber" > 0) AS used
  FROM "WarHistoryAttack"
  GROUP BY "clanTag", "warStartTime", "playerTag"
)
UPDATE "WarHistoryAttack" a
SET "attacksUsed" = COALESCE(c.used, 0)
FROM attack_counts c
WHERE a."clanTag" = c."clanTag"
  AND a."warStartTime" = c."warStartTime"
  AND a."playerTag" = c."playerTag"
  AND a."attacksUsed" = 0;

-- Backfill warId from WarClanHistory.
UPDATE "WarHistoryAttack" a
SET "warId" = h."warId"
FROM "WarClanHistory" h
WHERE a."clanTag" = h."clanTag"
  AND a."warStartTime" = h."warStartTime";

UPDATE "WarEventLogSubscription" s
SET "warId" = h."warId"
FROM "WarClanHistory" h
WHERE s."clanTag" = h."clanTag"
  AND s."lastWarStartTime" = h."warStartTime";

CREATE INDEX "WarHistoryAttack_warId_idx"
ON "WarHistoryAttack"("warId");

CREATE INDEX "WarEventLogSubscription_warId_idx"
ON "WarEventLogSubscription"("warId");
