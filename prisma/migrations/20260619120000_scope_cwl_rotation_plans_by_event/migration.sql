-- Scope CWL rotation plans to one authoritative CWL event instance.

ALTER TABLE "CwlRotationPlan" ADD COLUMN "eventInstanceId" TEXT;

WITH ranked_candidates AS (
  SELECT
    plan."id" AS "planId",
    clan."eventInstanceId",
    ROW_NUMBER() OVER (
      PARTITION BY plan."id"
      ORDER BY
        CASE WHEN clan."firstObservedAt" <= plan."createdAt" THEN 0 ELSE 1 END ASC,
        CASE WHEN clan."firstObservedAt" <= plan."createdAt" THEN clan."firstObservedAt" END DESC,
        CASE WHEN clan."firstObservedAt" > plan."createdAt" THEN clan."firstObservedAt" END ASC,
        clan."lastObservedAt" ASC,
        clan."eventInstanceId" ASC
    ) AS "candidateRank"
  FROM "CwlRotationPlan" plan
  JOIN "CwlEventClan" clan
    ON clan."clanTag" = plan."clanTag"
   AND clan."season" = plan."season"
)
UPDATE "CwlRotationPlan" plan
SET "eventInstanceId" = ranked."eventInstanceId"
FROM ranked_candidates ranked
WHERE ranked."planId" = plan."id"
  AND ranked."candidateRank" = 1;

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
  'legacy-rotation:' || orphan."season" || ':' || orphan."clanTag" AS "id",
  orphan."season",
  'legacy-rotation:' || orphan."season" || ':' || orphan."clanTag" AS "anchorWarTag",
  orphan."firstCreatedAt",
  orphan."lastUpdatedAt",
  orphan."firstCreatedAt",
  orphan."lastUpdatedAt"
FROM (
  SELECT
    plan."season",
    plan."clanTag",
    MIN(plan."createdAt") AS "firstCreatedAt",
    MAX(plan."updatedAt") AS "lastUpdatedAt"
  FROM "CwlRotationPlan" plan
  WHERE plan."eventInstanceId" IS NULL
  GROUP BY plan."season", plan."clanTag"
) orphan
ON CONFLICT ("anchorWarTag") DO NOTHING;

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
  'legacy-rotation:' || orphan."season" || ':' || orphan."clanTag" || ':clan' AS "id",
  'legacy-rotation:' || orphan."season" || ':' || orphan."clanTag" AS "eventInstanceId",
  orphan."season",
  orphan."clanTag",
  NOT EXISTS (
    SELECT 1
    FROM "CwlEventClan" current_clan
    WHERE current_clan."clanTag" = orphan."clanTag"
      AND current_clan."isCurrent" = true
  ) AS "isCurrent",
  orphan."firstCreatedAt",
  orphan."lastUpdatedAt",
  orphan."firstCreatedAt",
  orphan."lastUpdatedAt"
FROM (
  SELECT
    plan."season",
    plan."clanTag",
    MIN(plan."createdAt") AS "firstCreatedAt",
    MAX(plan."updatedAt") AS "lastUpdatedAt"
  FROM "CwlRotationPlan" plan
  WHERE plan."eventInstanceId" IS NULL
  GROUP BY plan."season", plan."clanTag"
) orphan
ON CONFLICT ("eventInstanceId", "clanTag") DO NOTHING;

UPDATE "CwlRotationPlan" plan
SET "eventInstanceId" = 'legacy-rotation:' || plan."season" || ':' || plan."clanTag"
WHERE plan."eventInstanceId" IS NULL;

WITH ranked_active AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "eventInstanceId", "clanTag"
      ORDER BY "version" DESC, "updatedAt" DESC, "id" DESC
    ) AS "activeRank"
  FROM "CwlRotationPlan"
  WHERE "isActive" = true
)
UPDATE "CwlRotationPlan" plan
SET "isActive" = false
FROM ranked_active ranked
WHERE ranked."id" = plan."id"
  AND ranked."activeRank" > 1;

ALTER TABLE "CwlRotationPlan" ALTER COLUMN "eventInstanceId" SET NOT NULL;

DROP INDEX IF EXISTS "CwlRotationPlan_clanTag_season_version_key";
DROP INDEX IF EXISTS "CwlRotationPlan_clanTag_season_isActive_idx";

CREATE UNIQUE INDEX "CwlRotationPlan_eventInstanceId_clanTag_version_key"
  ON "CwlRotationPlan"("eventInstanceId", "clanTag", "version");

CREATE INDEX "CwlRotationPlan_eventInstanceId_clanTag_isActive_idx"
  ON "CwlRotationPlan"("eventInstanceId", "clanTag", "isActive");

CREATE INDEX "CwlRotationPlan_season_clanTag_idx"
  ON "CwlRotationPlan"("season", "clanTag");

CREATE UNIQUE INDEX "CwlRotationPlan_active_event_clan_key"
  ON "CwlRotationPlan"("eventInstanceId", "clanTag")
  WHERE "isActive" = true;

ALTER TABLE "CwlRotationPlan"
  ADD CONSTRAINT "CwlRotationPlan_eventInstanceId_fkey"
  FOREIGN KEY ("eventInstanceId") REFERENCES "CwlEventInstance"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CwlRotationPlan"
  ADD CONSTRAINT "CwlRotationPlan_eventInstanceId_clanTag_fkey"
  FOREIGN KEY ("eventInstanceId", "clanTag") REFERENCES "CwlEventClan"("eventInstanceId", "clanTag")
  ON DELETE CASCADE ON UPDATE CASCADE;
