ALTER TABLE "TrackedClan"
  ADD COLUMN IF NOT EXISTS "mailConfig" JSONB;

WITH latest AS (
  SELECT DISTINCT ON (UPPER(REPLACE(cw."clanTag", '#', '')))
    UPPER(REPLACE(cw."clanTag", '#', '')) AS clan_norm,
    cw."mailConfig"
  FROM "CurrentWar" cw
  WHERE cw."mailConfig" IS NOT NULL
  ORDER BY UPPER(REPLACE(cw."clanTag", '#', '')), cw."updatedAt" DESC
)
UPDATE "TrackedClan" tc
SET "mailConfig" = latest."mailConfig"
FROM latest
WHERE UPPER(REPLACE(tc."tag", '#', '')) = latest.clan_norm
  AND tc."mailConfig" IS NULL;

ALTER TABLE "CurrentWar"
  DROP COLUMN IF EXISTS "mailConfig";
