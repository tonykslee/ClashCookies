DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='CurrentWar' AND column_name='currentSyncNum')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='CurrentWar' AND column_name='syncNum') THEN
    ALTER TABLE "CurrentWar" RENAME COLUMN "currentSyncNum" TO "syncNum";
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='CurrentWar' AND column_name='lastClanStars')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='CurrentWar' AND column_name='clanStars') THEN
    ALTER TABLE "CurrentWar" RENAME COLUMN "lastClanStars" TO "clanStars";
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='CurrentWar' AND column_name='lastOpponentStars')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='CurrentWar' AND column_name='opponentStars') THEN
    ALTER TABLE "CurrentWar" RENAME COLUMN "lastOpponentStars" TO "opponentStars";
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='CurrentWar' AND column_name='lastState')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='CurrentWar' AND column_name='state') THEN
    ALTER TABLE "CurrentWar" RENAME COLUMN "lastState" TO "state";
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='CurrentWar' AND column_name='lastOpponentTag')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='CurrentWar' AND column_name='opponentTag') THEN
    ALTER TABLE "CurrentWar" RENAME COLUMN "lastOpponentTag" TO "opponentTag";
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='CurrentWar' AND column_name='lastOpponentName')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='CurrentWar' AND column_name='opponentName') THEN
    ALTER TABLE "CurrentWar" RENAME COLUMN "lastOpponentName" TO "opponentName";
  END IF;
END $$;

DROP INDEX IF EXISTS "CurrentWar_startTime_clanTag_lastOpponentTag_idx";
CREATE INDEX IF NOT EXISTS "CurrentWar_startTime_clanTag_opponentTag_idx"
  ON "CurrentWar"("startTime", "clanTag", "opponentTag");
