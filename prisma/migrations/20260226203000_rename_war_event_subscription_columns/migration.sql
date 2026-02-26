ALTER TABLE "WarEventLogSubscription"
RENAME COLUMN "enabled" TO "notify";

ALTER TABLE "WarEventLogSubscription"
RENAME COLUMN "lastClanName" TO "clanName";

ALTER INDEX "WarEventLogSubscription_guildId_enabled_idx"
RENAME TO "WarEventLogSubscription_guildId_notify_idx";
