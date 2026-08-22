-- Create the authoritative durable Home Clan membership-period owner.
CREATE TYPE "ClanHomeMembershipEstablishmentSource" AS ENUM ('AUTO_3_SYNC', 'MANUAL', 'TRANSFER');
CREATE TYPE "ClanHomeMembershipEndReason" AS ENUM ('TRANSFERRED', 'MANUAL');

CREATE TABLE "ClanHomeMembershipPeriod" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "playerTag" VARCHAR(16) NOT NULL,
    "clanTag" VARCHAR(16) NOT NULL,
    "startedAtSyncTime" TIMESTAMP(3) NOT NULL,
    "qualifiedAtSyncTime" TIMESTAMP(3) NOT NULL,
    "endedAtSyncTime" TIMESTAMP(3),
    "establishmentSource" "ClanHomeMembershipEstablishmentSource" NOT NULL,
    "endReason" "ClanHomeMembershipEndReason",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClanHomeMembershipPeriod_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ClanHomeMembershipPeriod_guildId_playerTag_endedAtSyncTime_idx"
    ON "ClanHomeMembershipPeriod"("guildId", "playerTag", "endedAtSyncTime");
CREATE INDEX "ClanHomeMembershipPeriod_guildId_clanTag_endedAtSyncTime_idx"
    ON "ClanHomeMembershipPeriod"("guildId", "clanTag", "endedAtSyncTime");
CREATE INDEX "ClanHomeMembershipPeriod_guildId_playerTag_startedAtSyncTime_idx"
    ON "ClanHomeMembershipPeriod"("guildId", "playerTag", "startedAtSyncTime");
CREATE INDEX "ClanHomeMembershipPeriod_guildId_qualifiedAtSyncTime_idx"
    ON "ClanHomeMembershipPeriod"("guildId", "qualifiedAtSyncTime");

-- Prisma cannot express PostgreSQL partial unique indexes. This is the durable
-- invariant that permits historical periods while allowing only one active Home
-- period per guild/player; do not replace it with a full unique constraint.
CREATE UNIQUE INDEX "ClanHomeMembershipPeriod_active_guild_player_key"
    ON "ClanHomeMembershipPeriod"("guildId", "playerTag")
    WHERE "endedAtSyncTime" IS NULL;
