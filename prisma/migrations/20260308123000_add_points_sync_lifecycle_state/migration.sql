ALTER TABLE "ClanPointsSync"
  ADD COLUMN IF NOT EXISTS "lastSuccessfulPointsApiFetchAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastFetchReason" TEXT,
  ADD COLUMN IF NOT EXISTS "confirmedByClanMail" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "needsValidation" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "lastKnownPoints" INTEGER,
  ADD COLUMN IF NOT EXISTS "lastKnownMatchType" TEXT,
  ADD COLUMN IF NOT EXISTS "lastKnownOutcome" TEXT,
  ADD COLUMN IF NOT EXISTS "lastKnownSyncNumber" INTEGER;

UPDATE "ClanPointsSync"
SET
  "lastSuccessfulPointsApiFetchAt" = COALESCE("lastSuccessfulPointsApiFetchAt", "syncFetchedAt", "updatedAt"),
  "lastKnownPoints" = COALESCE("lastKnownPoints", "clanPoints"),
  "lastKnownOutcome" = COALESCE("lastKnownOutcome", "outcome"),
  "lastKnownSyncNumber" = COALESCE("lastKnownSyncNumber", "syncNum"),
  "needsValidation" = false
WHERE
  "lastSuccessfulPointsApiFetchAt" IS NULL
  OR "lastKnownPoints" IS NULL
  OR "lastKnownSyncNumber" IS NULL
  OR "needsValidation" = true;
