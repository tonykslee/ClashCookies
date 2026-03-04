-- Replace CurrentWar.lastWarStartTime with explicit prep/start/end timestamps
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'CurrentWar'
      AND column_name = 'lastWarStartTime'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'CurrentWar'
      AND column_name = 'startTime'
  ) THEN
    ALTER TABLE "CurrentWar" RENAME COLUMN "lastWarStartTime" TO "startTime";
  END IF;
END $$;

ALTER TABLE "CurrentWar"
  ADD COLUMN IF NOT EXISTS "prepStartTime" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "endTime" TIMESTAMP(3);

ALTER TABLE "ClanWarHistory"
  ADD COLUMN IF NOT EXISTS "prepStartTime" TIMESTAMP(3);

DROP INDEX IF EXISTS "CurrentWar_lastWarStartTime_clanTag_lastOpponentTag_idx";
CREATE INDEX IF NOT EXISTS "CurrentWar_startTime_clanTag_lastOpponentTag_idx"
  ON "CurrentWar"("startTime", "clanTag", "lastOpponentTag");