CREATE TABLE "SyncClanReadinessSnapshot" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "syncTime" TIMESTAMP(3) NOT NULL,
    "clanTag" TEXT NOT NULL,
    "clanName" TEXT,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "memberCount" INTEGER NOT NULL,
    "unresolvedWeightCount" INTEGER NOT NULL,
    "deviationScore" DOUBLE PRECISION,
    "projectionComplete" BOOLEAN NOT NULL,
    "sourceSyncedAt" TIMESTAMP(3),
    "algorithmVersion" TEXT NOT NULL,
    "scheduledSyncPostId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncClanReadinessSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SyncEvent" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "syncTime" TIMESTAMP(3) NOT NULL,
    "clanTag" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SyncClanReadinessSnapshot_guildId_syncTime_clanTag_key"
    ON "SyncClanReadinessSnapshot"("guildId", "syncTime", "clanTag");
CREATE INDEX "SyncClanReadinessSnapshot_guildId_syncTime_idx"
    ON "SyncClanReadinessSnapshot"("guildId", "syncTime");
CREATE INDEX "SyncClanReadinessSnapshot_syncTime_projectionComplete_deviationScore_idx"
    ON "SyncClanReadinessSnapshot"("syncTime", "projectionComplete", "deviationScore");

CREATE UNIQUE INDEX "SyncEvent_guildId_syncTime_clanTag_eventType_key"
    ON "SyncEvent"("guildId", "syncTime", "clanTag", "eventType");
CREATE INDEX "SyncEvent_guildId_syncTime_idx"
    ON "SyncEvent"("guildId", "syncTime");
CREATE INDEX "SyncEvent_syncTime_eventType_idx"
    ON "SyncEvent"("syncTime", "eventType");
