-- Track Todo WAR owner provenance so verified continuity can survive degraded refreshes.
CREATE TYPE "TodoWarOwnerSource" AS ENUM ('LIVE_VERIFIED', 'PERSISTED_FALLBACK', 'NONE');

ALTER TABLE "TodoPlayerSnapshot"
ADD COLUMN IF NOT EXISTS "warOwnerSource" "TodoWarOwnerSource" NOT NULL DEFAULT 'NONE',
ADD COLUMN IF NOT EXISTS "warOwnerWarId" INTEGER,
ADD COLUMN IF NOT EXISTS "warOwnerVerifiedAt" TIMESTAMP(3);

-- Backfill pre-migration active WAR snapshots as persisted fallback so the first
-- post-deploy refresh treats them as transitional state instead of inventing live
-- verification history before the next authoritative poll lands.
UPDATE "TodoPlayerSnapshot"
SET
  "warOwnerSource" = 'PERSISTED_FALLBACK',
  "warOwnerWarId" = NULL,
  "warOwnerVerifiedAt" = NULL
WHERE "warActive" = TRUE
  AND "warClanTag" IS NOT NULL
  AND "warOwnerSource" = 'NONE';
