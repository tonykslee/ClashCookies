-- Add persisted Discord user snapshot fields for ban records.
ALTER TABLE "BanRecord"
ADD COLUMN "targetDiscordUsername" TEXT,
ADD COLUMN "targetDiscordDisplayName" TEXT;
