-- Persist tracked-war identity so roster refreshes can stay scoped to the live war instance.
ALTER TABLE "FwaTrackedClanWarRosterCurrent"
ADD COLUMN IF NOT EXISTS "sourceWarId" INTEGER,
ADD COLUMN IF NOT EXISTS "sourceWarStartTime" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "sourceWarEndTime" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "sourceWarState" TEXT,
ADD COLUMN IF NOT EXISTS "sourceCurrentWarUpdatedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "FwaTrackedClanWarRosterCurrent_sourceWarId_idx"
  ON "FwaTrackedClanWarRosterCurrent"("sourceWarId");

CREATE INDEX IF NOT EXISTS "FwaTrackedClanWarRosterCurrent_sourceWarStartTime_idx"
  ON "FwaTrackedClanWarRosterCurrent"("sourceWarStartTime");
