ALTER TABLE "WarEventLogSubscription"
ADD COLUMN IF NOT EXISTS "currentSyncNumber" INTEGER;
