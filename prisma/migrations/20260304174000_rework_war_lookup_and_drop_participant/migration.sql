DROP TABLE IF EXISTS "WarHistoryParticipant";

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'WarLookup'
      AND constraint_name = 'WarLookup_warId_fkey'
  ) THEN
    ALTER TABLE "WarLookup" DROP CONSTRAINT "WarLookup_warId_fkey";
  END IF;
END $$;

ALTER TABLE "WarLookup"
  ALTER COLUMN "warId" TYPE TEXT USING "warId"::text;

ALTER TABLE "WarLookup"
  ADD COLUMN IF NOT EXISTS "clanTag" TEXT,
  ADD COLUMN IF NOT EXISTS "opponentTag" TEXT,
  ADD COLUMN IF NOT EXISTS "startTime" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "endTime" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "result" TEXT;

UPDATE "WarLookup" w
SET
  "clanTag" = h."clanTag",
  "opponentTag" = h."opponentTag",
  "startTime" = h."warStartTime",
  "endTime" = h."warEndTime",
  "result" = COALESCE(LOWER(h."actualOutcome"), LOWER(h."expectedOutcome"), 'unknown')
FROM "ClanWarHistory" h
WHERE w."warId" ~ '^[0-9]+$'
  AND h."warId" = w."warId"::INT;

UPDATE "WarLookup"
SET "clanTag" = COALESCE(NULLIF("clanTag", ''), 'UNKNOWN')
WHERE "clanTag" IS NULL OR "clanTag" = '';

UPDATE "WarLookup"
SET "startTime" = COALESCE("startTime", "createdAt")
WHERE "startTime" IS NULL;

ALTER TABLE "WarLookup"
  ALTER COLUMN "clanTag" SET NOT NULL,
  ALTER COLUMN "startTime" SET NOT NULL;

ALTER TABLE "WarLookup"
  DROP COLUMN IF EXISTS "updatedAt";

CREATE INDEX IF NOT EXISTS "WarLookup_clanTag_startTime_idx"
  ON "WarLookup"("clanTag", "startTime");
