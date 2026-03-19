-- CreateEnum
CREATE TYPE "FwaFeedType" AS ENUM ('CLANS', 'CLAN_MEMBERS', 'WAR_MEMBERS', 'CLAN_WARS');

-- CreateEnum
CREATE TYPE "FwaFeedScopeType" AS ENUM ('GLOBAL', 'TRACKED_CLANS', 'CLAN_TAG');

-- CreateEnum
CREATE TYPE "FwaFeedSyncStatus" AS ENUM ('IDLE', 'SUCCESS', 'FAILURE', 'NOOP', 'SKIPPED');

-- CreateTable
CREATE TABLE "FwaClanCatalog" (
    "clanTag" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "level" INTEGER,
    "points" INTEGER,
    "type" TEXT,
    "location" TEXT,
    "requiredTrophies" INTEGER,
    "warFrequency" TEXT,
    "winStreak" INTEGER,
    "wins" INTEGER,
    "ties" INTEGER,
    "losses" INTEGER,
    "isWarLogPublic" BOOLEAN,
    "imageUrl" TEXT,
    "description" TEXT,
    "th18Count" INTEGER,
    "th17Count" INTEGER,
    "th16Count" INTEGER,
    "th15Count" INTEGER,
    "th14Count" INTEGER,
    "th13Count" INTEGER,
    "th12Count" INTEGER,
    "th11Count" INTEGER,
    "th10Count" INTEGER,
    "th9Count" INTEGER,
    "th8Count" INTEGER,
    "thLowCount" INTEGER,
    "estimatedWeight" INTEGER,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FwaClanCatalog_pkey" PRIMARY KEY ("clanTag")
);

-- CreateTable
CREATE TABLE "FwaPlayerCatalog" (
    "playerTag" TEXT NOT NULL,
    "latestName" TEXT NOT NULL,
    "latestTownHall" INTEGER,
    "latestKnownWeight" INTEGER,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FwaPlayerCatalog_pkey" PRIMARY KEY ("playerTag")
);

-- CreateTable
CREATE TABLE "FwaClanMemberCurrent" (
    "clanTag" TEXT NOT NULL,
    "playerTag" TEXT NOT NULL,
    "playerName" TEXT NOT NULL,
    "role" TEXT,
    "level" INTEGER,
    "donated" INTEGER,
    "received" INTEGER,
    "rank" INTEGER,
    "trophies" INTEGER,
    "league" TEXT,
    "townHall" INTEGER,
    "weight" INTEGER,
    "inWar" BOOLEAN,
    "sourceSyncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FwaClanMemberCurrent_pkey" PRIMARY KEY ("clanTag","playerTag")
);

-- CreateTable
CREATE TABLE "FwaWarMemberCurrent" (
    "clanTag" TEXT NOT NULL,
    "playerTag" TEXT NOT NULL,
    "playerName" TEXT NOT NULL,
    "position" INTEGER,
    "townHall" INTEGER,
    "weight" INTEGER,
    "opponentTag" TEXT,
    "opponentName" TEXT,
    "attacks" INTEGER,
    "defender1Tag" TEXT,
    "defender1Name" TEXT,
    "defender1TownHall" INTEGER,
    "defender1Position" INTEGER,
    "stars1" INTEGER,
    "destructionPercentage1" DOUBLE PRECISION,
    "defender2Tag" TEXT,
    "defender2Name" TEXT,
    "defender2TownHall" INTEGER,
    "defender2Position" INTEGER,
    "stars2" INTEGER,
    "destructionPercentage2" DOUBLE PRECISION,
    "sourceSyncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FwaWarMemberCurrent_pkey" PRIMARY KEY ("clanTag","playerTag")
);

-- CreateTable
CREATE TABLE "FwaClanWarLogCurrent" (
    "id" TEXT NOT NULL,
    "clanTag" TEXT NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "searchTime" TIMESTAMP(3),
    "result" TEXT,
    "teamSize" INTEGER NOT NULL,
    "clanName" TEXT,
    "clanLevel" INTEGER,
    "clanStars" INTEGER,
    "clanDestructionPercentage" DOUBLE PRECISION,
    "clanAttacks" INTEGER,
    "clanExpEarned" INTEGER,
    "opponentTag" TEXT NOT NULL,
    "opponentName" TEXT,
    "opponentLevel" INTEGER,
    "opponentStars" INTEGER,
    "opponentDestructionPercentage" DOUBLE PRECISION,
    "opponentInfo" TEXT,
    "synced" BOOLEAN,
    "matched" BOOLEAN,
    "sourceSyncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FwaClanWarLogCurrent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FwaFeedSyncState" (
    "id" TEXT NOT NULL,
    "feedType" "FwaFeedType" NOT NULL,
    "scopeType" "FwaFeedScopeType" NOT NULL,
    "scopeKey" TEXT,
    "lastAttemptAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "lastStatus" "FwaFeedSyncStatus" NOT NULL DEFAULT 'IDLE',
    "lastErrorCode" TEXT,
    "lastErrorSummary" TEXT,
    "lastRowCount" INTEGER,
    "lastChangedRowCount" INTEGER,
    "lastContentHash" TEXT,
    "nextEligibleAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FwaFeedSyncState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FwaClanWarsWatchState" (
    "clanTag" TEXT NOT NULL,
    "syncTimeSourceMessageId" TEXT,
    "nextSyncTimeAt" TIMESTAMP(3),
    "pollWindowStartAt" TIMESTAMP(3),
    "pollingActive" BOOLEAN NOT NULL DEFAULT false,
    "lastDetectedWarEndAt" TIMESTAMP(3),
    "lastAcquiredUpdateAt" TIMESTAMP(3),
    "lastObservedContentHash" TEXT,
    "currentWarCycleKey" TEXT,
    "stopReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FwaClanWarsWatchState_pkey" PRIMARY KEY ("clanTag")
);

-- CreateTable
CREATE TABLE "FwaFeedCursor" (
    "feedType" "FwaFeedType" NOT NULL,
    "lastScopeKey" TEXT,
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FwaFeedCursor_pkey" PRIMARY KEY ("feedType")
);

-- CreateIndex
CREATE INDEX "FwaClanCatalog_lastSeenAt_idx" ON "FwaClanCatalog"("lastSeenAt");

-- CreateIndex
CREATE INDEX "FwaClanCatalog_lastSyncedAt_idx" ON "FwaClanCatalog"("lastSyncedAt");

-- CreateIndex
CREATE INDEX "FwaClanCatalog_points_idx" ON "FwaClanCatalog"("points");

-- CreateIndex
CREATE INDEX "FwaPlayerCatalog_latestTownHall_idx" ON "FwaPlayerCatalog"("latestTownHall");

-- CreateIndex
CREATE INDEX "FwaPlayerCatalog_lastSeenAt_idx" ON "FwaPlayerCatalog"("lastSeenAt");

-- CreateIndex
CREATE INDEX "FwaPlayerCatalog_lastSyncedAt_idx" ON "FwaPlayerCatalog"("lastSyncedAt");

-- CreateIndex
CREATE INDEX "FwaClanMemberCurrent_clanTag_idx" ON "FwaClanMemberCurrent"("clanTag");

-- CreateIndex
CREATE INDEX "FwaClanMemberCurrent_playerTag_idx" ON "FwaClanMemberCurrent"("playerTag");

-- CreateIndex
CREATE INDEX "FwaClanMemberCurrent_sourceSyncedAt_idx" ON "FwaClanMemberCurrent"("sourceSyncedAt");

-- CreateIndex
CREATE INDEX "FwaWarMemberCurrent_clanTag_idx" ON "FwaWarMemberCurrent"("clanTag");

-- CreateIndex
CREATE INDEX "FwaWarMemberCurrent_playerTag_idx" ON "FwaWarMemberCurrent"("playerTag");

-- CreateIndex
CREATE INDEX "FwaWarMemberCurrent_opponentTag_idx" ON "FwaWarMemberCurrent"("opponentTag");

-- CreateIndex
CREATE INDEX "FwaWarMemberCurrent_sourceSyncedAt_idx" ON "FwaWarMemberCurrent"("sourceSyncedAt");

-- CreateIndex
CREATE UNIQUE INDEX "FwaClanWarLogCurrent_clanTag_endTime_opponentTag_teamSize_key" ON "FwaClanWarLogCurrent"("clanTag", "endTime", "opponentTag", "teamSize");

-- CreateIndex
CREATE INDEX "FwaClanWarLogCurrent_clanTag_idx" ON "FwaClanWarLogCurrent"("clanTag");

-- CreateIndex
CREATE INDEX "FwaClanWarLogCurrent_opponentTag_idx" ON "FwaClanWarLogCurrent"("opponentTag");

-- CreateIndex
CREATE INDEX "FwaClanWarLogCurrent_endTime_idx" ON "FwaClanWarLogCurrent"("endTime");

-- CreateIndex
CREATE INDEX "FwaClanWarLogCurrent_sourceSyncedAt_idx" ON "FwaClanWarLogCurrent"("sourceSyncedAt");

-- CreateIndex
CREATE UNIQUE INDEX "FwaFeedSyncState_feedType_scopeType_scopeKey_key" ON "FwaFeedSyncState"("feedType", "scopeType", "scopeKey");

-- CreateIndex
CREATE INDEX "FwaFeedSyncState_feedType_scopeType_scopeKey_idx" ON "FwaFeedSyncState"("feedType", "scopeType", "scopeKey");

-- CreateIndex
CREATE INDEX "FwaFeedSyncState_lastStatus_updatedAt_idx" ON "FwaFeedSyncState"("lastStatus", "updatedAt");

-- CreateIndex
CREATE INDEX "FwaFeedSyncState_nextEligibleAt_idx" ON "FwaFeedSyncState"("nextEligibleAt");

-- CreateIndex
CREATE INDEX "FwaClanWarsWatchState_pollingActive_pollWindowStartAt_nextSyncTimeAt_idx" ON "FwaClanWarsWatchState"("pollingActive", "pollWindowStartAt", "nextSyncTimeAt");

-- CreateIndex
CREATE INDEX "FwaClanWarsWatchState_lastAcquiredUpdateAt_idx" ON "FwaClanWarsWatchState"("lastAcquiredUpdateAt");
