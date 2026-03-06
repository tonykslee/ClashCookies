-- PlayerActivity guild scoping
ALTER TABLE "PlayerActivity" ADD COLUMN "guildId" TEXT;
UPDATE "PlayerActivity" SET "guildId" = 'legacy' WHERE "guildId" IS NULL;
ALTER TABLE "PlayerActivity" ALTER COLUMN "guildId" SET NOT NULL;
ALTER TABLE "PlayerActivity" DROP CONSTRAINT "PlayerActivity_pkey";
ALTER TABLE "PlayerActivity" ADD CONSTRAINT "PlayerActivity_pkey" PRIMARY KEY ("guildId", "tag");
CREATE INDEX IF NOT EXISTS "PlayerActivity_guildId_clanTag_idx" ON "PlayerActivity"("guildId", "clanTag");

-- RecruitmentTemplate guild scoping
ALTER TABLE "RecruitmentTemplate" ADD COLUMN "guildId" TEXT;
UPDATE "RecruitmentTemplate" SET "guildId" = 'legacy' WHERE "guildId" IS NULL;
ALTER TABLE "RecruitmentTemplate" ALTER COLUMN "guildId" SET NOT NULL;
ALTER TABLE "RecruitmentTemplate" DROP CONSTRAINT IF EXISTS "RecruitmentTemplate_clanTag_platform_key";
CREATE UNIQUE INDEX "RecruitmentTemplate_guildId_clanTag_platform_key" ON "RecruitmentTemplate"("guildId", "clanTag", "platform");
CREATE INDEX IF NOT EXISTS "RecruitmentTemplate_guildId_clanTag_idx" ON "RecruitmentTemplate"("guildId", "clanTag");

-- RecruitmentCooldown guild scoping
ALTER TABLE "RecruitmentCooldown" ADD COLUMN "guildId" TEXT;
UPDATE "RecruitmentCooldown" SET "guildId" = 'legacy' WHERE "guildId" IS NULL;
ALTER TABLE "RecruitmentCooldown" ALTER COLUMN "guildId" SET NOT NULL;
ALTER TABLE "RecruitmentCooldown" DROP CONSTRAINT IF EXISTS "RecruitmentCooldown_userId_clanTag_platform_key";
CREATE UNIQUE INDEX "RecruitmentCooldown_guildId_userId_clanTag_platform_key" ON "RecruitmentCooldown"("guildId", "userId", "clanTag", "platform");
CREATE INDEX IF NOT EXISTS "RecruitmentCooldown_guildId_userId_expiresAt_idx" ON "RecruitmentCooldown"("guildId", "userId", "expiresAt");
CREATE INDEX IF NOT EXISTS "RecruitmentCooldown_guildId_expiresAt_reminded_idx" ON "RecruitmentCooldown"("guildId", "expiresAt", "reminded");
