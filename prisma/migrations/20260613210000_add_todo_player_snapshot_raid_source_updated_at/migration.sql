-- Add a dedicated RAID source freshness timestamp so RAID freshness can be tracked independently.
ALTER TABLE "TodoPlayerSnapshot"
ADD COLUMN IF NOT EXISTS "raidSourceUpdatedAt" TIMESTAMP(3);
