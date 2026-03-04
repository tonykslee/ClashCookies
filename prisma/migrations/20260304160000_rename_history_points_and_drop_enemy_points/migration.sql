DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'ClanWarHistory'
      AND column_name = 'fwaPointsGained'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'ClanWarHistory'
      AND column_name = 'pointsAfterWar'
  ) THEN
    ALTER TABLE "ClanWarHistory" RENAME COLUMN "fwaPointsGained" TO "pointsAfterWar";
  END IF;
END $$;

ALTER TABLE "ClanWarHistory"
  DROP COLUMN IF EXISTS "enemyPoints";

-- Backfill missing actualOutcome for historical rows where stars are already known.
UPDATE "ClanWarHistory"
SET "actualOutcome" = CASE
  WHEN "clanStars" IS NULL OR "opponentStars" IS NULL THEN COALESCE("actualOutcome", 'UNKNOWN')
  WHEN "clanStars" > "opponentStars" THEN 'WIN'
  WHEN "clanStars" < "opponentStars" THEN 'LOSE'
  ELSE 'TIE'
END
WHERE "actualOutcome" IS NULL;
