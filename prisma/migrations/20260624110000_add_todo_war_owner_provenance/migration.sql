-- Track Todo WAR owner provenance so verified continuity can survive degraded refreshes.
CREATE TYPE "TodoWarOwnerSource" AS ENUM ('LIVE_VERIFIED', 'PERSISTED_FALLBACK', 'NONE');

ALTER TABLE "TodoPlayerSnapshot"
ADD COLUMN IF NOT EXISTS "warOwnerSource" "TodoWarOwnerSource" NOT NULL DEFAULT 'NONE',
ADD COLUMN IF NOT EXISTS "warOwnerWarId" INTEGER,
ADD COLUMN IF NOT EXISTS "warOwnerVerifiedAt" TIMESTAMP(3);
