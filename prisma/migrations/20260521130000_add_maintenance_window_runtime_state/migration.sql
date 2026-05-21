-- CreateTable
CREATE TABLE "MaintenanceWindowRuntimeState" (
    "guildId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "detectedAt" TIMESTAMP(3),
    "lastObservedAt" TIMESTAMP(3),
    "lastOverAt" TIMESTAMP(3),
    "detectedClanTag" TEXT,
    "detectedStatusCode" INTEGER,
    "lastChannelId" TEXT,
    "lastChannelSource" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "MaintenanceWindowRuntimeState_guildId_key" ON "MaintenanceWindowRuntimeState"("guildId");
