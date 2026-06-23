ALTER TABLE "AutoRoleGuildConfig"
ADD COLUMN "nicknameExcludeRoleIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
