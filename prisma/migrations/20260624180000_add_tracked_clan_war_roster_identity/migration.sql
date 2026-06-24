-- Persist tracked-war identity so roster refreshes can stay scoped to the live war instance.
ALTER TABLE "FwaTrackedClanWarRosterCurrent"
ADD COLUMN IF NOT EXISTS "sourceWarId" INTEGER,
ADD COLUMN IF NOT EXISTS "sourceWarStartTime" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "sourceWarEndTime" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "sourceWarState" TEXT,
ADD COLUMN IF NOT EXISTS "sourceCurrentWarUpdatedAt" TIMESTAMP(3);

WITH latest_current_war AS (
  SELECT DISTINCT ON ("clanTag")
    "clanTag",
    "warId",
    "startTime",
    "endTime",
    "state",
    "updatedAt"
  FROM "CurrentWar"
  ORDER BY "clanTag", "updatedAt" DESC, "startTime" DESC NULLS LAST
)
UPDATE "FwaTrackedClanWarRosterCurrent" AS roster
SET
  "sourceWarId" = current_war."warId",
  "sourceWarStartTime" = current_war."startTime",
  "sourceWarEndTime" = current_war."endTime",
  "sourceWarState" = current_war."state",
  "sourceCurrentWarUpdatedAt" = current_war."updatedAt"
FROM latest_current_war AS current_war
WHERE current_war."clanTag" = roster."clanTag";

CREATE INDEX IF NOT EXISTS "FwaTrackedClanWarRosterCurrent_sourceWarId_idx"
  ON "FwaTrackedClanWarRosterCurrent"("sourceWarId");

CREATE INDEX IF NOT EXISTS "FwaTrackedClanWarRosterCurrent_sourceWarStartTime_idx"
  ON "FwaTrackedClanWarRosterCurrent"("sourceWarStartTime");
