DROP INDEX IF EXISTS "RecruitmentTemplate_clanTag_platform_key";
DROP INDEX IF EXISTS "RecruitmentCooldown_userId_clanTag_platform_key";

CREATE UNIQUE INDEX IF NOT EXISTS "RecruitmentTemplate_guildId_clanTag_platform_key"
ON "RecruitmentTemplate" ("guildId", "clanTag", "platform");

CREATE UNIQUE INDEX IF NOT EXISTS "RecruitmentCooldown_guildId_userId_clanTag_platform_key"
ON "RecruitmentCooldown" ("guildId", "userId", "clanTag", "platform");
