CREATE TYPE "AutoRoleRunScope" AS ENUM ('GUILD', 'ROLE', 'USER');
CREATE TYPE "AutoRoleRunTrigger" AS ENUM ('MANUAL', 'SCHEDULED');

ALTER TABLE "AutoRoleSyncRun"
ADD COLUMN     "scope" "AutoRoleRunScope" NOT NULL DEFAULT 'GUILD',
ADD COLUMN     "trigger" "AutoRoleRunTrigger" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "scopeTargetId" TEXT;

CREATE INDEX "AutoRoleSyncRun_guildId_trigger_scope_status_finishedAt_idx" ON "AutoRoleSyncRun"("guildId", "trigger", "scope", "status", "finishedAt");
