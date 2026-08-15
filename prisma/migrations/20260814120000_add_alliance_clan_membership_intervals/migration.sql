CREATE TYPE "AllianceClanMembershipIntervalEndReason" AS ENUM ('TRANSFERRED', 'DEPARTED', 'TRACKING_STOPPED');

-- CreateTable
CREATE TABLE "AllianceClanMembershipInterval" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "playerTag" VARCHAR(16) NOT NULL,
    "clanTag" VARCHAR(16) NOT NULL,
    "firstObservedAt" TIMESTAMP(3) NOT NULL,
    "lastObservedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "endReason" "AllianceClanMembershipIntervalEndReason",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AllianceClanMembershipInterval_pkey" PRIMARY KEY ("id")
);

-- Enforce the one-open-interval invariant at the database boundary.
CREATE UNIQUE INDEX "AllianceClanMembershipInterval_one_open_per_guild_player"
ON "AllianceClanMembershipInterval" ("guildId", "playerTag")
WHERE "endedAt" IS NULL;

CREATE INDEX "AllianceClanMembershipInterval_guildId_playerTag_firstObser_idx"
ON "AllianceClanMembershipInterval" ("guildId", "playerTag", "firstObservedAt", "endedAt");

CREATE INDEX "AllianceClanMembershipInterval_guildId_clanTag_firstObserve_idx"
ON "AllianceClanMembershipInterval" ("guildId", "clanTag", "firstObservedAt", "endedAt");

CREATE INDEX "AllianceClanMembershipInterval_guildId_firstObservedAt_ende_idx"
ON "AllianceClanMembershipInterval" ("guildId", "firstObservedAt", "endedAt");
