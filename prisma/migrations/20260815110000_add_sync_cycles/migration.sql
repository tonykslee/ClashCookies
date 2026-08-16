-- CreateEnum
CREATE TYPE "SyncCycleResolutionSource" AS ENUM ('ENDED_WAR_CANONICAL');

-- CreateTable
CREATE TABLE "SyncCycle" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "syncNumber" INTEGER NOT NULL,
    "syncTime" TIMESTAMP(3) NOT NULL,
    "scheduledSyncPostId" TEXT,
    "resolvedAt" TIMESTAMP(3) NOT NULL,
    "resolutionSource" "SyncCycleResolutionSource" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncCycle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SyncCycle_guildId_syncNumber_key" ON "SyncCycle"("guildId", "syncNumber");

-- CreateIndex
CREATE UNIQUE INDEX "SyncCycle_guildId_syncTime_key" ON "SyncCycle"("guildId", "syncTime");

-- CreateIndex
CREATE INDEX "SyncCycle_guildId_syncTime_idx" ON "SyncCycle"("guildId", "syncTime");
