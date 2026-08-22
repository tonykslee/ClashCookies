-- Add durable proposed-transfer and leader-decision history without changing
-- ClanHomeMembershipPeriod ownership.
CREATE TYPE "ClanHomeTransferCandidateStatus" AS ENUM ('PENDING', 'KEPT_HOME', 'CONFIRMED');

CREATE TABLE "ClanHomeTransferCandidate" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "playerTag" VARCHAR(16) NOT NULL,
    "homeMembershipPeriodId" TEXT NOT NULL,
    "fromClanTag" VARCHAR(16) NOT NULL,
    "toClanTag" VARCHAR(16) NOT NULL,
    "startedAtSyncTime" TIMESTAMP(3) NOT NULL,
    "qualifiedAtSyncTime" TIMESTAMP(3) NOT NULL,
    "status" "ClanHomeTransferCandidateStatus" NOT NULL,
    "decidedAt" TIMESTAMP(3),
    "decidedByDiscordUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClanHomeTransferCandidate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ClanHomeTransferCandidate_homeMembershipPeriodId_toClanTag_startedAtSyncTime_qualifiedAtSyncTime_key"
    ON "ClanHomeTransferCandidate"("homeMembershipPeriodId", "toClanTag", "startedAtSyncTime", "qualifiedAtSyncTime");
CREATE INDEX "ClanHomeTransferCandidate_guildId_playerTag_status_idx"
    ON "ClanHomeTransferCandidate"("guildId", "playerTag", "status");
CREATE INDEX "ClanHomeTransferCandidate_homeMembershipPeriodId_status_idx"
    ON "ClanHomeTransferCandidate"("homeMembershipPeriodId", "status");
CREATE INDEX "ClanHomeTransferCandidate_guildId_fromClanTag_status_idx"
    ON "ClanHomeTransferCandidate"("guildId", "fromClanTag", "status");

-- Prisma cannot express PostgreSQL partial unique indexes. This preserves all
-- decision history while allowing at most one pending candidate per Home row.
CREATE UNIQUE INDEX "ClanHomeTransferCandidate_pending_homeMembershipPeriodId_key"
    ON "ClanHomeTransferCandidate"("homeMembershipPeriodId")
    WHERE "status" = 'PENDING';
