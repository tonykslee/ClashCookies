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
        clan."lastObservedAt" DESC,
        clan."eventInstanceId" DESC
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

CREATE TEMP TABLE "_CwlRotationOrphanGroup" AS
WITH orphan_groups AS (
  SELECT
    plan."season",
    plan."clanTag",
    'legacy-rotation:' || plan."season" || ':' || plan."clanTag" AS "eventInstanceId",
    MIN(plan."createdAt") AS "firstCreatedAt",
    MAX(plan."updatedAt") AS "lastUpdatedAt"
  FROM "CwlRotationPlan" plan
  WHERE plan."eventInstanceId" IS NULL
  GROUP BY plan."season", plan."clanTag"
),
ranked_orphans AS (
  SELECT
    orphan.*,
    ROW_NUMBER() OVER (
      PARTITION BY orphan."clanTag"
      ORDER BY
        orphan."lastUpdatedAt" DESC,
        orphan."firstCreatedAt" DESC,
        orphan."season" DESC,
        orphan."eventInstanceId" DESC
    ) AS "orphanRank"
  FROM orphan_groups orphan
)
SELECT
  orphan."season",
  orphan."clanTag",
  orphan."eventInstanceId",
  orphan."firstCreatedAt",
  orphan."lastUpdatedAt",
  orphan."orphanRank"
FROM ranked_orphans orphan;

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
  orphan."eventInstanceId" AS "id",
  orphan."season",
  orphan."eventInstanceId" AS "anchorWarTag",
  orphan."firstCreatedAt",
  orphan."lastUpdatedAt",
  orphan."firstCreatedAt",
  orphan."lastUpdatedAt"
FROM "_CwlRotationOrphanGroup" orphan
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
  orphan."eventInstanceId",
  orphan."season",
  orphan."clanTag",
  CASE
    WHEN orphan."orphanRank" = 1
      AND NOT EXISTS (
        SELECT 1
        FROM "CwlEventClan" current_clan
        WHERE current_clan."clanTag" = orphan."clanTag"
          AND current_clan."isCurrent" = true
      )
    THEN true
    ELSE false
  END AS "isCurrent",
  orphan."firstCreatedAt",
  orphan."lastUpdatedAt",
  orphan."firstCreatedAt",
  orphan."lastUpdatedAt"
FROM "_CwlRotationOrphanGroup" orphan
ON CONFLICT ("eventInstanceId", "clanTag") DO NOTHING;

UPDATE "CwlRotationPlan" plan
SET "eventInstanceId" = orphan."eventInstanceId"
FROM "_CwlRotationOrphanGroup" orphan
WHERE plan."eventInstanceId" IS NULL
  AND plan."season" = orphan."season"
  AND plan."clanTag" = orphan."clanTag";

DROP TABLE "_CwlRotationOrphanGroup";

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
