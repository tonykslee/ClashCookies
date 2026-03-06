-- Backfill missing warId values before making warId part of primary key.
WITH max_ids AS (
  SELECT GREATEST(
    COALESCE((SELECT MAX("warId") FROM "ClanWarHistory"), 0),
    COALESCE((SELECT MAX("warId") FROM "CurrentWar"), 0),
    COALESCE((SELECT MAX("warId") FROM "WarAttacks"), 0)
  ) AS max_war_id
), numbered AS (
  SELECT
    ctid,
    ROW_NUMBER() OVER (ORDER BY "createdAt" ASC, "updatedAt" ASC) AS rn
  FROM "WarAttacks"
  WHERE "warId" IS NULL
)
UPDATE "WarAttacks" wa
SET "warId" = mi.max_war_id + n.rn
FROM numbered n
CROSS JOIN max_ids mi
WHERE wa.ctid = n.ctid;

-- Remove any accidental duplicates on the target composite key before adding PK.
DELETE FROM "WarAttacks" a
USING "WarAttacks" b
WHERE a.ctid < b.ctid
  AND a."warId" = b."warId"
  AND a."playerTag" = b."playerTag"
  AND a."attackNumber" = b."attackNumber";

ALTER TABLE "WarAttacks" DROP CONSTRAINT IF EXISTS "WarAttacks_pkey";
ALTER TABLE "WarAttacks" DROP CONSTRAINT IF EXISTS "WarAttacks_warId_playerTag_attackNumber_key";
ALTER TABLE "WarAttacks" ALTER COLUMN "warId" SET NOT NULL;
ALTER TABLE "WarAttacks" ADD CONSTRAINT "WarAttacks_pkey" PRIMARY KEY ("warId","playerTag","attackNumber");
CREATE UNIQUE INDEX IF NOT EXISTS "WarAttacks_clanTag_warStartTime_playerTag_attackOrder_key"
  ON "WarAttacks"("clanTag","warStartTime","playerTag","attackOrder");
ALTER TABLE "WarAttacks" DROP COLUMN IF EXISTS "id";

CREATE INDEX IF NOT EXISTS "BotSetting_updatedAt_idx" ON "BotSetting"("updatedAt");
CREATE INDEX IF NOT EXISTS "RecruitmentCooldown_expiresAt_idx" ON "RecruitmentCooldown"("expiresAt");

DROP INDEX IF EXISTS "WarEvent_clanTag_createdAt_idx";
CREATE INDEX "WarEvent_clanTag_createdAt_idx" ON "WarEvent"("clanTag","createdAt" DESC);
