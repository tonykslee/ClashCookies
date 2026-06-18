-- CWL event-instance backfill.
-- Legacy rows are grouped deterministically by season + clanTag because the old schema
-- could not preserve multiple league groups that happened in the same month.

CREATE TABLE "CwlEventInstance" (
    "id" TEXT NOT NULL,
    "season" TEXT NOT NULL,
    "anchorWarTag" TEXT NOT NULL,
    "firstObservedAt" TIMESTAMP(3) NOT NULL,
    "lastObservedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CwlEventInstance_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CwlEventInstance_anchorWarTag_key" ON "CwlEventInstance"("anchorWarTag");
CREATE INDEX "CwlEventInstance_season_lastObservedAt_idx" ON "CwlEventInstance"("season", "lastObservedAt");

CREATE TABLE "CwlEventWarTag" (
    "id" TEXT NOT NULL,
    "eventInstanceId" TEXT NOT NULL,
    "season" TEXT NOT NULL,
    "warTag" TEXT NOT NULL,
    "firstObservedAt" TIMESTAMP(3) NOT NULL,
    "lastObservedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CwlEventWarTag_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CwlEventWarTag_warTag_key" ON "CwlEventWarTag"("warTag");
CREATE INDEX "CwlEventWarTag_eventInstanceId_idx" ON "CwlEventWarTag"("eventInstanceId");
CREATE INDEX "CwlEventWarTag_season_warTag_idx" ON "CwlEventWarTag"("season", "warTag");

ALTER TABLE "CwlEventWarTag"
  ADD CONSTRAINT "CwlEventWarTag_eventInstanceId_fkey"
  FOREIGN KEY ("eventInstanceId") REFERENCES "CwlEventInstance"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CwlEventClan" (
    "id" TEXT NOT NULL,
    "eventInstanceId" TEXT NOT NULL,
    "season" TEXT NOT NULL,
    "clanTag" TEXT NOT NULL,
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "firstObservedAt" TIMESTAMP(3) NOT NULL,
    "lastObservedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CwlEventClan_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CwlEventClan_eventInstanceId_clanTag_key" ON "CwlEventClan"("eventInstanceId", "clanTag");
CREATE INDEX "CwlEventClan_clanTag_isCurrent_idx" ON "CwlEventClan"("clanTag", "isCurrent");
CREATE INDEX "CwlEventClan_season_clanTag_idx" ON "CwlEventClan"("season", "clanTag");

ALTER TABLE "CwlEventClan"
  ADD CONSTRAINT "CwlEventClan_eventInstanceId_fkey"
  FOREIGN KEY ("eventInstanceId") REFERENCES "CwlEventInstance"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CwlPlayerClanSeason" ADD COLUMN "eventInstanceId" TEXT;
ALTER TABLE "CwlSeasonRosterState" ADD COLUMN "eventInstanceId" TEXT;
ALTER TABLE "CurrentCwlRound" ADD COLUMN "eventInstanceId" TEXT;
ALTER TABLE "CwlRoundMemberCurrent" ADD COLUMN "eventInstanceId" TEXT;
ALTER TABLE "CurrentCwlPrepSnapshot" ADD COLUMN "eventInstanceId" TEXT;
ALTER TABLE "CwlRoundHistory" ADD COLUMN "eventInstanceId" TEXT;
ALTER TABLE "CwlRoundMemberHistory" ADD COLUMN "eventInstanceId" TEXT;

WITH legacy_event_scope AS (
  SELECT DISTINCT "season", "clanTag" FROM "CurrentCwlRound"
  UNION
  SELECT DISTINCT "season", "clanTag" FROM "CurrentCwlPrepSnapshot"
  UNION
  SELECT DISTINCT "season", "clanTag" FROM "CwlRoundHistory"
  UNION
  SELECT DISTINCT "season", "cwlClanTag" AS "clanTag" FROM "CwlPlayerClanSeason"
  UNION
  SELECT DISTINCT "season", "clanTag" FROM "CwlSeasonRosterState"
),
legacy_event_observations AS (
  SELECT "season", "clanTag", "sourceUpdatedAt" AS "observedAt" FROM "CurrentCwlRound"
  UNION ALL
  SELECT "season", "clanTag", "sourceUpdatedAt" AS "observedAt" FROM "CurrentCwlPrepSnapshot"
  UNION ALL
  SELECT "season", "clanTag", "sourceUpdatedAt" AS "observedAt" FROM "CwlRoundHistory"
  UNION ALL
  SELECT "season", "cwlClanTag" AS "clanTag", "updatedAt" AS "observedAt" FROM "CwlPlayerClanSeason"
  UNION ALL
  SELECT "season", "clanTag", "reconciledAt" AS "observedAt" FROM "CwlSeasonRosterState"
),
legacy_event_bounds AS (
  SELECT
    scope."season",
    scope."clanTag",
    MIN(obs."observedAt") AS "firstObservedAt",
    MAX(obs."observedAt") AS "lastObservedAt"
  FROM legacy_event_scope scope
  JOIN legacy_event_observations obs
    ON obs."season" = scope."season"
   AND obs."clanTag" = scope."clanTag"
  GROUP BY scope."season", scope."clanTag"
)
INSERT INTO "CwlEventInstance" (
  "id",
  "season",
  "anchorWarTag",
  "firstObservedAt",
  "lastObservedAt",
  "createdAt",
  "updatedAt"
)
SELECT
  'legacy:' || "season" || ':' || "clanTag" AS "id",
  "season",
  'legacy:' || "season" || ':' || "clanTag" AS "anchorWarTag",
  "firstObservedAt",
  "lastObservedAt",
  "firstObservedAt",
  "lastObservedAt"
FROM legacy_event_bounds;

INSERT INTO "CwlEventClan" (
  "id",
  "eventInstanceId",
  "season",
  "clanTag",
  "isCurrent",
  "firstObservedAt",
  "lastObservedAt",
  "createdAt",
  "updatedAt"
)
SELECT
  'legacy:' || "season" || ':' || "clanTag" || ':clan' AS "id",
  'legacy:' || "season" || ':' || "clanTag" AS "eventInstanceId",
  "season",
  "clanTag",
  true,
  "firstObservedAt",
  "lastObservedAt",
  "firstObservedAt",
  "lastObservedAt"
FROM legacy_event_bounds;

UPDATE "CwlPlayerClanSeason"
SET "eventInstanceId" = 'legacy:' || "season" || ':' || "cwlClanTag";

UPDATE "CwlSeasonRosterState"
SET "eventInstanceId" = 'legacy:' || "season" || ':' || "clanTag";

UPDATE "CurrentCwlRound"
SET "eventInstanceId" = 'legacy:' || "season" || ':' || "clanTag";

UPDATE "CwlRoundMemberCurrent"
SET "eventInstanceId" = 'legacy:' || "season" || ':' || "clanTag";

UPDATE "CurrentCwlPrepSnapshot"
SET "eventInstanceId" = 'legacy:' || "season" || ':' || "clanTag";

UPDATE "CwlRoundHistory"
SET "eventInstanceId" = 'legacy:' || "season" || ':' || "clanTag";

UPDATE "CwlRoundMemberHistory"
SET "eventInstanceId" = 'legacy:' || "season" || ':' || "clanTag";

ALTER TABLE "CwlRoundMemberCurrent"
  DROP CONSTRAINT IF EXISTS "CwlRoundMemberCurrent_season_clanTag_fkey";

ALTER TABLE "CwlRoundMemberHistory"
  DROP CONSTRAINT IF EXISTS "CwlRoundMemberHistory_season_clanTag_roundDay_fkey";

ALTER TABLE "CwlPlayerClanSeason" ALTER COLUMN "eventInstanceId" SET NOT NULL;
ALTER TABLE "CwlSeasonRosterState" ALTER COLUMN "eventInstanceId" SET NOT NULL;
ALTER TABLE "CurrentCwlRound" ALTER COLUMN "eventInstanceId" SET NOT NULL;
ALTER TABLE "CwlRoundMemberCurrent" ALTER COLUMN "eventInstanceId" SET NOT NULL;
ALTER TABLE "CurrentCwlPrepSnapshot" ALTER COLUMN "eventInstanceId" SET NOT NULL;
ALTER TABLE "CwlRoundHistory" ALTER COLUMN "eventInstanceId" SET NOT NULL;
ALTER TABLE "CwlRoundMemberHistory" ALTER COLUMN "eventInstanceId" SET NOT NULL;

DROP INDEX IF EXISTS "CwlPlayerClanSeason_season_playerTag_key";
DROP INDEX IF EXISTS "CwlPlayerClanSeason_season_cwlClanTag_idx";

ALTER TABLE "CurrentCwlRound" DROP CONSTRAINT IF EXISTS "CurrentCwlRound_pkey";
DROP INDEX IF EXISTS "CurrentCwlRound_season_clanTag_roundDay_key";
DROP INDEX IF EXISTS "CurrentCwlRound_season_roundDay_idx";

ALTER TABLE "CwlRoundMemberCurrent" DROP CONSTRAINT IF EXISTS "CwlRoundMemberCurrent_pkey";
DROP INDEX IF EXISTS "CwlRoundMemberCurrent_season_clanTag_roundDay_idx";
DROP INDEX IF EXISTS "CwlRoundMemberCurrent_season_playerTag_idx";
DROP INDEX IF EXISTS "CwlRoundMemberCurrent_season_clanTag_subbedIn_idx";

ALTER TABLE "CurrentCwlPrepSnapshot" DROP CONSTRAINT IF EXISTS "CurrentCwlPrepSnapshot_pkey";
DROP INDEX IF EXISTS "CurrentCwlPrepSnapshot_season_clanTag_roundDay_key";
DROP INDEX IF EXISTS "CurrentCwlPrepSnapshot_season_roundDay_idx";

ALTER TABLE "CwlRoundHistory" DROP CONSTRAINT IF EXISTS "CwlRoundHistory_pkey";
DROP INDEX IF EXISTS "CwlRoundHistory_season_clanTag_endTime_idx";

ALTER TABLE "CwlRoundMemberHistory" DROP CONSTRAINT IF EXISTS "CwlRoundMemberHistory_pkey";
DROP INDEX IF EXISTS "CwlRoundMemberHistory_season_clanTag_playerTag_idx";
DROP INDEX IF EXISTS "CwlRoundMemberHistory_season_playerTag_idx";

ALTER TABLE "CwlSeasonRosterState" DROP CONSTRAINT IF EXISTS "CwlSeasonRosterState_pkey";

CREATE UNIQUE INDEX "CwlPlayerClanSeason_eventInstanceId_playerTag_key"
  ON "CwlPlayerClanSeason"("eventInstanceId", "playerTag");

CREATE INDEX "CwlPlayerClanSeason_eventInstanceId_cwlClanTag_idx"
  ON "CwlPlayerClanSeason"("eventInstanceId", "cwlClanTag");

CREATE INDEX "CwlPlayerClanSeason_eventInstanceId_playerTag_idx"
  ON "CwlPlayerClanSeason"("eventInstanceId", "playerTag");

ALTER TABLE "CwlSeasonRosterState"
  ADD CONSTRAINT "CwlSeasonRosterState_pkey"
  PRIMARY KEY ("eventInstanceId", "clanTag");

CREATE INDEX "CwlSeasonRosterState_eventInstanceId_reconciledAt_idx"
  ON "CwlSeasonRosterState"("eventInstanceId", "reconciledAt");

ALTER TABLE "CurrentCwlRound"
  ADD CONSTRAINT "CurrentCwlRound_pkey"
  PRIMARY KEY ("eventInstanceId", "clanTag");

CREATE UNIQUE INDEX "CurrentCwlRound_eventInstanceId_clanTag_roundDay_key"
  ON "CurrentCwlRound"("eventInstanceId", "clanTag", "roundDay");

CREATE INDEX "CurrentCwlRound_eventInstanceId_roundDay_idx"
  ON "CurrentCwlRound"("eventInstanceId", "roundDay");

ALTER TABLE "CwlRoundMemberCurrent"
  ADD CONSTRAINT "CwlRoundMemberCurrent_pkey"
  PRIMARY KEY ("eventInstanceId", "clanTag", "playerTag");

CREATE INDEX "CwlRoundMemberCurrent_eventInstanceId_clanTag_roundDay_idx"
  ON "CwlRoundMemberCurrent"("eventInstanceId", "clanTag", "roundDay");

CREATE INDEX "CwlRoundMemberCurrent_eventInstanceId_playerTag_idx"
  ON "CwlRoundMemberCurrent"("eventInstanceId", "playerTag");

CREATE INDEX "CwlRoundMemberCurrent_eventInstanceId_clanTag_subbedIn_idx"
  ON "CwlRoundMemberCurrent"("eventInstanceId", "clanTag", "subbedIn");

ALTER TABLE "CurrentCwlPrepSnapshot"
  ADD CONSTRAINT "CurrentCwlPrepSnapshot_pkey"
  PRIMARY KEY ("eventInstanceId", "clanTag");

CREATE UNIQUE INDEX "CurrentCwlPrepSnapshot_eventInstanceId_clanTag_roundDay_key"
  ON "CurrentCwlPrepSnapshot"("eventInstanceId", "clanTag", "roundDay");

CREATE INDEX "CurrentCwlPrepSnapshot_eventInstanceId_roundDay_idx"
  ON "CurrentCwlPrepSnapshot"("eventInstanceId", "roundDay");

ALTER TABLE "CwlRoundHistory"
  ADD CONSTRAINT "CwlRoundHistory_pkey"
  PRIMARY KEY ("eventInstanceId", "clanTag", "roundDay");

CREATE INDEX "CwlRoundHistory_eventInstanceId_clanTag_endTime_idx"
  ON "CwlRoundHistory"("eventInstanceId", "clanTag", "endTime");

CREATE INDEX "CwlRoundHistory_eventInstanceId_roundDay_idx"
  ON "CwlRoundHistory"("eventInstanceId", "roundDay");

ALTER TABLE "CwlRoundMemberHistory"
  ADD CONSTRAINT "CwlRoundMemberHistory_pkey"
  PRIMARY KEY ("eventInstanceId", "clanTag", "roundDay", "playerTag");

CREATE INDEX "CwlRoundMemberHistory_eventInstanceId_clanTag_playerTag_idx"
  ON "CwlRoundMemberHistory"("eventInstanceId", "clanTag", "playerTag");

CREATE INDEX "CwlRoundMemberHistory_eventInstanceId_playerTag_idx"
  ON "CwlRoundMemberHistory"("eventInstanceId", "playerTag");

ALTER TABLE "CurrentCwlRound"
  ADD CONSTRAINT "CurrentCwlRound_eventInstanceId_fkey"
  FOREIGN KEY ("eventInstanceId") REFERENCES "CwlEventInstance"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CurrentCwlPrepSnapshot"
  ADD CONSTRAINT "CurrentCwlPrepSnapshot_eventInstanceId_fkey"
  FOREIGN KEY ("eventInstanceId") REFERENCES "CwlEventInstance"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CwlRoundHistory"
  ADD CONSTRAINT "CwlRoundHistory_eventInstanceId_fkey"
  FOREIGN KEY ("eventInstanceId") REFERENCES "CwlEventInstance"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CwlPlayerClanSeason"
  ADD CONSTRAINT "CwlPlayerClanSeason_eventInstanceId_fkey"
  FOREIGN KEY ("eventInstanceId") REFERENCES "CwlEventInstance"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CwlSeasonRosterState"
  ADD CONSTRAINT "CwlSeasonRosterState_eventInstanceId_fkey"
  FOREIGN KEY ("eventInstanceId") REFERENCES "CwlEventInstance"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CwlRoundMemberCurrent"
  ADD CONSTRAINT "CwlRoundMemberCurrent_eventInstanceId_clanTag_fkey"
  FOREIGN KEY ("eventInstanceId", "clanTag") REFERENCES "CurrentCwlRound"("eventInstanceId", "clanTag")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CwlRoundMemberHistory"
  ADD CONSTRAINT "CwlRoundMemberHistory_eventInstanceId_clanTag_roundDay_fkey"
  FOREIGN KEY ("eventInstanceId", "clanTag", "roundDay") REFERENCES "CwlRoundHistory"("eventInstanceId", "clanTag", "roundDay")
  ON DELETE CASCADE ON UPDATE CASCADE;
