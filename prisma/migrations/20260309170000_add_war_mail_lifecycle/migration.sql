CREATE TYPE "WarMailLifecycleStatus" AS ENUM ('NOT_POSTED', 'POSTED', 'DELETED');

CREATE TABLE "WarMailLifecycle" (
    "guildId" TEXT NOT NULL,
    "clanTag" TEXT NOT NULL,
    "warId" INTEGER NOT NULL,
    "status" "WarMailLifecycleStatus" NOT NULL DEFAULT 'NOT_POSTED',
    "messageId" TEXT,
    "channelId" TEXT,
    "postedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WarMailLifecycle_pkey" PRIMARY KEY ("guildId", "clanTag", "warId")
);

CREATE INDEX "WarMailLifecycle_guildId_clanTag_status_idx"
ON "WarMailLifecycle"("guildId", "clanTag", "status");

CREATE INDEX "WarMailLifecycle_clanTag_warId_idx"
ON "WarMailLifecycle"("clanTag", "warId");