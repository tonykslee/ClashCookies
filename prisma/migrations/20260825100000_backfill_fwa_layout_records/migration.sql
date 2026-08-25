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

UPDATE "FwaLayouts" AS fwa
SET "layoutId" = layout."id"
FROM "LayoutRecord" AS layout
WHERE fwa."layoutId" IS NULL
  AND layout."layoutLink" = fwa."LayoutLink";
