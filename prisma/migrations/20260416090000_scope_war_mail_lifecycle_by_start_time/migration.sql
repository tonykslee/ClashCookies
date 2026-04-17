-- Add a stable row id and active-war identity fields to WarMailLifecycle.
ALTER TABLE "WarMailLifecycle"
  ADD COLUMN IF NOT EXISTS "id" TEXT;

ALTER TABLE "WarMailLifecycle"
  ADD COLUMN IF NOT EXISTS "warStartTime" TIMESTAMP(3);

ALTER TABLE "WarMailLifecycle"
  ADD COLUMN IF NOT EXISTS "opponentTag" TEXT;

-- Backfill a deterministic row id for existing lifecycle rows.
UPDATE "WarMailLifecycle"
SET "id" = 'wl_' || md5(
  COALESCE("guildId", '') || ':' ||
  COALESCE("clanTag", '') || ':' ||
  COALESCE("warId"::text, '') || ':' ||
  COALESCE("channelId", '') || ':' ||
  COALESCE("messageId", '') || ':' ||
  COALESCE(to_char("createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS'), '')
)
WHERE "id" IS NULL;

-- Prefer the stricter ClanPointsSync war-start identity when it exists.
WITH matched_sync AS (
  SELECT DISTINCT ON (wml."id")
    wml."id" AS lifecycle_id,
    cps."warStartTime" AS war_start_time,
    cps."opponentTag" AS opponent_tag
  FROM "WarMailLifecycle" wml
  JOIN "ClanPointsSync" cps
    ON cps."guildId" = wml."guildId"
   AND cps."clanTag" = wml."clanTag"
   AND cps."warId" = wml."warId"::text
  ORDER BY wml."id", cps."warStartTime" DESC, cps."syncFetchedAt" DESC, cps."updatedAt" DESC
)
UPDATE "WarMailLifecycle" wml
SET
  "warStartTime" = matched_sync.war_start_time,
  "opponentTag" = COALESCE(wml."opponentTag", matched_sync.opponent_tag)
FROM matched_sync
WHERE wml."id" = matched_sync.lifecycle_id
  AND wml."warStartTime" IS NULL;

-- Fall back to CurrentWar for any rows we could not match to a points sync row.
UPDATE "WarMailLifecycle" wml
SET
  "warStartTime" = cw."startTime",
  "opponentTag" = COALESCE(wml."opponentTag", cw."opponentTag")
FROM "CurrentWar" cw
WHERE cw."guildId" = wml."guildId"
  AND cw."clanTag" = wml."clanTag"
  AND cw."warId" = wml."warId"
  AND wml."warStartTime" IS NULL;

ALTER TABLE "WarMailLifecycle"
  DROP CONSTRAINT IF EXISTS "WarMailLifecycle_pkey";

ALTER TABLE "WarMailLifecycle"
  ALTER COLUMN "id" SET NOT NULL,
  ALTER COLUMN "warId" DROP NOT NULL;

ALTER TABLE "WarMailLifecycle"
  ADD CONSTRAINT "WarMailLifecycle_pkey" PRIMARY KEY ("id");

CREATE UNIQUE INDEX IF NOT EXISTS "WarMailLifecycle_guildId_clanTag_warStartTime_key"
  ON "WarMailLifecycle"("guildId", "clanTag", "warStartTime");

CREATE INDEX IF NOT EXISTS "WarMailLifecycle_guildId_clanTag_status_idx"
  ON "WarMailLifecycle"("guildId", "clanTag", "status");

CREATE INDEX IF NOT EXISTS "WarMailLifecycle_clanTag_warId_idx"
  ON "WarMailLifecycle"("clanTag", "warId");

CREATE INDEX IF NOT EXISTS "WarMailLifecycle_guildId_clanTag_warStartTime_idx"
  ON "WarMailLifecycle"("guildId", "clanTag", "warStartTime");
