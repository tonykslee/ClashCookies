ALTER TABLE "TrackedClan"
  ADD COLUMN IF NOT EXISTS "notifyChannelId" TEXT,
  ADD COLUMN IF NOT EXISTS "notifyRole" TEXT,
  ADD COLUMN IF NOT EXISTS "notifyEnabled" BOOLEAN NOT NULL DEFAULT false;

-- Backfill from CurrentWar (latest row per clan tag) when present.
WITH latest AS (
  SELECT DISTINCT ON (UPPER(REPLACE(cw."clanTag", '#', '')))
    UPPER(REPLACE(cw."clanTag", '#', '')) AS clan_norm,
    cw."channelId",
    cw."notifyRole",
    cw."notify"
  FROM "CurrentWar" cw
  ORDER BY UPPER(REPLACE(cw."clanTag", '#', '')), cw."updatedAt" DESC
)
UPDATE "TrackedClan" tc
SET
  "notifyChannelId" = COALESCE(tc."notifyChannelId", latest."channelId"),
  "notifyRole" = COALESCE(tc."notifyRole", latest."notifyRole"),
  "notifyEnabled" = CASE
    WHEN tc."notifyEnabled" IS TRUE THEN TRUE
    ELSE COALESCE(latest."notify", FALSE)
  END
FROM latest
WHERE UPPER(REPLACE(tc."tag", '#', '')) = latest.clan_norm;
