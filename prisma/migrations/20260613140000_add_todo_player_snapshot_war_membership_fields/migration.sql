-- Add nullable WAR membership/render columns to TodoPlayerSnapshot in a backward-safe way.
ALTER TABLE "TodoPlayerSnapshot"
ADD COLUMN IF NOT EXISTS "warClanTag" TEXT,
ADD COLUMN IF NOT EXISTS "warClanName" TEXT,
ADD COLUMN IF NOT EXISTS "warPosition" INTEGER,
ADD COLUMN IF NOT EXISTS "warSourceUpdatedAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "clanMembershipObservedAt" TIMESTAMP(3);
