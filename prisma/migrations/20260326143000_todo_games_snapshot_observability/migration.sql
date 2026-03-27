ALTER TABLE "TodoPlayerSnapshot"
ADD COLUMN IF NOT EXISTS "gamesChampionTotal" INTEGER,
ADD COLUMN IF NOT EXISTS "gamesSeasonBaseline" INTEGER,
ADD COLUMN IF NOT EXISTS "gamesCycleKey" TEXT;

CREATE INDEX IF NOT EXISTS "TodoPlayerSnapshot_gamesCycleKey_idx"
ON "TodoPlayerSnapshot" ("gamesCycleKey");
