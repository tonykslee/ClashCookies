-- Add nullable RAID membership/render columns to TodoPlayerSnapshot in a backward-safe way.
ALTER TABLE "TodoPlayerSnapshot"
ADD COLUMN IF NOT EXISTS "raidClanTag" TEXT,
ADD COLUMN IF NOT EXISTS "raidClanName" TEXT;
