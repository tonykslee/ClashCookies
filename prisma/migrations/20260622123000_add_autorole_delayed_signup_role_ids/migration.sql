ALTER TABLE "AutoRoleGuildConfig"
ADD COLUMN "delayedSignupRoleIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
