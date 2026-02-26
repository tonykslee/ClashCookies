ALTER TABLE "RecruitmentTemplate"
ADD COLUMN "platform" "RecruitmentPlatform" NOT NULL DEFAULT 'discord',
ADD COLUMN "subject" TEXT;

DROP INDEX IF EXISTS "RecruitmentTemplate_clanTag_key";

CREATE UNIQUE INDEX "RecruitmentTemplate_clanTag_platform_key"
ON "RecruitmentTemplate" ("clanTag", "platform");

CREATE INDEX "RecruitmentTemplate_clanTag_idx"
ON "RecruitmentTemplate" ("clanTag");
