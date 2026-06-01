-- CreateTable
CREATE TABLE "RaidDistrictHitHistory" (
    "id" SERIAL NOT NULL,
    "guildId" TEXT NOT NULL,
    "sourceClanTag" VARCHAR(16) NOT NULL,
    "raidSeasonStartTime" TIMESTAMP(3) NOT NULL,
    "defenderTag" VARCHAR(16) NOT NULL,
    "defenderName" TEXT,
    "districtName" TEXT NOT NULL,
    "districtHallLevel" INTEGER,
    "attackOrder" INTEGER NOT NULL,
    "attackerTag" VARCHAR(16) NOT NULL,
    "attackerName" TEXT,
    "destructionPercent" INTEGER,
    "stars" INTEGER,
    "districtFinalAttackCount" INTEGER,
    "districtFinalDestructionPercent" INTEGER,
    "districtFinalStars" INTEGER,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RaidDistrictHitHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RaidDistrictHitHistory_guildId_sourceClanTag_raidSeasonStartT_key" ON "RaidDistrictHitHistory"("guildId", "sourceClanTag", "raidSeasonStartTime", "defenderTag", "districtName", "attackOrder", "attackerTag");

-- CreateIndex
CREATE INDEX "RaidDistrictHitHistory_guildId_sourceClanTag_raidSeasonStartT_idx" ON "RaidDistrictHitHistory"("guildId", "sourceClanTag", "raidSeasonStartTime");

-- CreateIndex
CREATE INDEX "RaidDistrictHitHistory_guildId_attackerTag_observedAt_idx" ON "RaidDistrictHitHistory"("guildId", "attackerTag", "observedAt");

-- CreateIndex
CREATE INDEX "RaidDistrictHitHistory_observedAt_idx" ON "RaidDistrictHitHistory"("observedAt");
