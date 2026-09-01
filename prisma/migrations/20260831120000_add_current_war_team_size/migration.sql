-- Add live-war team-size metadata without affecting existing CurrentWar rows.
ALTER TABLE "CurrentWar"
ADD COLUMN IF NOT EXISTS "teamSize" INTEGER;
