ALTER TABLE "CurrentWar"
ADD COLUMN IF NOT EXISTS "pendingEventType" TEXT;

ALTER TABLE "CurrentWar"
ADD COLUMN IF NOT EXISTS "pendingEventTargetState" TEXT;
