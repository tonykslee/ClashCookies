-- CreateEnum
CREATE TYPE "FwaTrackedClanWarRosterEffectiveWeightStatus" AS ENUM (
    'RAW',
    'FILLED_FROM_LOWER_BLOCK',
    'UNRESOLVED_TRAILING_ZERO'
);

-- CreateTable
CREATE TABLE "FwaTrackedClanWarRosterCurrent" (
    "clanTag" TEXT NOT NULL,
    "clanName" TEXT,
    "opponentTag" TEXT,
    "opponentName" TEXT,
    "rosterSize" INTEGER NOT NULL,
    "totalRawWeight" INTEGER,
    "totalEffectiveWeight" INTEGER,
    "hasUnresolvedWeights" BOOLEAN NOT NULL DEFAULT false,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "sourceUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FwaTrackedClanWarRosterCurrent_pkey" PRIMARY KEY ("clanTag")
);

-- CreateTable
CREATE TABLE "FwaTrackedClanWarRosterMemberCurrent" (
    "clanTag" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "playerTag" TEXT NOT NULL,
    "playerName" TEXT NOT NULL,
    "townHall" INTEGER NOT NULL,
    "rawWeight" INTEGER NOT NULL,
    "effectiveWeight" INTEGER,
    "effectiveWeightStatus" "FwaTrackedClanWarRosterEffectiveWeightStatus" NOT NULL,
    "opponentTag" TEXT,
    "opponentName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FwaTrackedClanWarRosterMemberCurrent_pkey" PRIMARY KEY ("clanTag","playerTag")
);

-- CreateTable
CREATE TABLE "HeatMapRef" (
    "weightMinInclusive" INTEGER NOT NULL,
    "weightMaxInclusive" INTEGER NOT NULL,
    "th18Count" INTEGER NOT NULL,
    "th17Count" INTEGER NOT NULL,
    "th16Count" INTEGER NOT NULL,
    "th15Count" INTEGER NOT NULL,
    "th14Count" INTEGER NOT NULL,
    "th13Count" INTEGER NOT NULL,
    "th12Count" INTEGER NOT NULL,
    "th11Count" INTEGER NOT NULL,
    "th10OrLowerCount" INTEGER NOT NULL,
    "sourceVersion" TEXT,
    "refreshedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HeatMapRef_pkey" PRIMARY KEY ("weightMinInclusive","weightMaxInclusive")
);

-- CreateIndex
CREATE INDEX "FwaTrackedClanWarRosterCurrent_observedAt_idx" ON "FwaTrackedClanWarRosterCurrent"("observedAt");

-- CreateIndex
CREATE INDEX "FwaTrackedClanWarRosterCurrent_sourceUpdatedAt_idx" ON "FwaTrackedClanWarRosterCurrent"("sourceUpdatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "FwaTrackedClanWarRosterMemberCurrent_clanTag_position_key" ON "FwaTrackedClanWarRosterMemberCurrent"("clanTag", "position");

-- CreateIndex
CREATE INDEX "FwaTrackedClanWarRosterMemberCurrent_clanTag_position_idx" ON "FwaTrackedClanWarRosterMemberCurrent"("clanTag", "position");

-- CreateIndex
CREATE INDEX "FwaTrackedClanWarRosterMemberCurrent_clanTag_playerTag_idx" ON "FwaTrackedClanWarRosterMemberCurrent"("clanTag", "playerTag");

-- AddForeignKey
ALTER TABLE "FwaTrackedClanWarRosterMemberCurrent"
ADD CONSTRAINT "FwaTrackedClanWarRosterMemberCurrent_clanTag_fkey"
FOREIGN KEY ("clanTag") REFERENCES "FwaTrackedClanWarRosterCurrent"("clanTag")
ON DELETE CASCADE ON UPDATE CASCADE;
