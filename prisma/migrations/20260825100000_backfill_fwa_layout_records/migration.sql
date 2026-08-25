-- Backfill shared layout lifecycle rows without manufacturing historical freshness.
-- The deterministic id is stable for the exact legacy link and safe to rerun.
INSERT INTO "LayoutRecord" (
    "id",
    "layoutLink",
    "imageUrl",
    "submittedAt",
    "lastConfirmedAt",
    "lastConfirmedByDiscordUserId",
    "createdAt",
    "updatedAt"
)
SELECT
    'legacy-layout-' || md5(source."LayoutLink"),
    source."LayoutLink",
    source."ImageUrl",
    NULL,
    NULL,
    NULL,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM (
    SELECT
        "LayoutLink",
        MAX("ImageUrl") FILTER (WHERE "ImageUrl" IS NOT NULL) AS "ImageUrl"
    FROM "FwaLayouts"
    GROUP BY "LayoutLink"
) AS source
WHERE NOT EXISTS (
    SELECT 1
    FROM "LayoutRecord" existing
    WHERE existing."layoutLink" = source."LayoutLink"
)
ON CONFLICT ("layoutLink") DO NOTHING;

-- A pre-existing shared record wins, except that a missing presentation image may
-- be recovered from the legacy rows without changing lifecycle timestamps.
UPDATE "LayoutRecord" AS layout
SET "imageUrl" = source."ImageUrl"
FROM (
    SELECT
        "LayoutLink",
        MAX("ImageUrl") FILTER (WHERE "ImageUrl" IS NOT NULL) AS "ImageUrl"
    FROM "FwaLayouts"
    GROUP BY "LayoutLink"
) AS source
WHERE layout."layoutLink" = source."LayoutLink"
  AND layout."imageUrl" IS NULL
  AND source."ImageUrl" IS NOT NULL;

UPDATE "FwaLayouts" AS fwa
SET "layoutId" = layout."id"
FROM "LayoutRecord" AS layout
WHERE fwa."layoutId" IS NULL
  AND layout."layoutLink" = fwa."LayoutLink";

UPDATE "FwaLayouts" AS fwa
SET
    "LayoutLink" = layout."layoutLink",
    "ImageUrl" = layout."imageUrl"
FROM "LayoutRecord" AS layout
WHERE fwa."layoutId" = layout."id";
