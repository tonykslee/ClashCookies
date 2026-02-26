ALTER TABLE "WarEventLogSubscription"
DROP COLUMN IF EXISTS "currentSyncNumber";

ALTER TABLE "WarEventLogSubscription"
ADD COLUMN "warStartFwaPoints" INTEGER,
ADD COLUMN "warEndFwaPoints" INTEGER,
ADD COLUMN "lastClanStars" INTEGER,
ADD COLUMN "lastOpponentStars" INTEGER;
