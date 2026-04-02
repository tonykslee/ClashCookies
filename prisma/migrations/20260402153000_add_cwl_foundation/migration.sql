-- AlterTable
ALTER TABLE "CwlPlayerClanSeason" ADD COLUMN     "daysParticipated" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastRoundDay" INTEGER,
ADD COLUMN     "playerName" TEXT,
ADD COLUMN     "townHall" INTEGER;

-- CreateTable
CREATE TABLE "CurrentCwlRound" (
    "season" TEXT NOT NULL,
    "clanTag" TEXT NOT NULL,
    "roundDay" INTEGER NOT NULL,
    "clanName" TEXT,
    "opponentTag" TEXT,
    "opponentName" TEXT,
    "roundState" TEXT NOT NULL,
    "leagueGroupState" TEXT,
    "teamSize" INTEGER,
    "attacksPerMember" INTEGER NOT NULL DEFAULT 1,
    "preparationStartTime" TIMESTAMP(3),
    "startTime" TIMESTAMP(3),
    "endTime" TIMESTAMP(3),
    "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CurrentCwlRound_pkey" PRIMARY KEY ("season","clanTag")
);

-- CreateTable
CREATE TABLE "CwlRoundMemberCurrent" (
    "season" TEXT NOT NULL,
    "clanTag" TEXT NOT NULL,
    "playerTag" TEXT NOT NULL,
    "roundDay" INTEGER NOT NULL,
    "playerName" TEXT NOT NULL,
    "mapPosition" INTEGER,
    "townHall" INTEGER,
    "attacksUsed" INTEGER NOT NULL DEFAULT 0,
    "attacksAvailable" INTEGER NOT NULL DEFAULT 1,
    "stars" INTEGER NOT NULL DEFAULT 0,
    "destruction" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "subbedIn" BOOLEAN NOT NULL DEFAULT true,
    "subbedOut" BOOLEAN NOT NULL DEFAULT false,
    "sourceRoundState" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CwlRoundMemberCurrent_pkey" PRIMARY KEY ("season","clanTag","playerTag")
);

-- CreateTable
CREATE TABLE "CwlRoundHistory" (
    "season" TEXT NOT NULL,
    "clanTag" TEXT NOT NULL,
    "roundDay" INTEGER NOT NULL,
    "clanName" TEXT,
    "opponentTag" TEXT,
    "opponentName" TEXT,
    "roundState" TEXT NOT NULL,
    "leagueGroupState" TEXT,
    "teamSize" INTEGER,
    "attacksPerMember" INTEGER NOT NULL DEFAULT 1,
    "preparationStartTime" TIMESTAMP(3),
    "startTime" TIMESTAMP(3),
    "endTime" TIMESTAMP(3),
    "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CwlRoundHistory_pkey" PRIMARY KEY ("season","clanTag","roundDay")
);

-- CreateTable
CREATE TABLE "CwlRoundMemberHistory" (
    "season" TEXT NOT NULL,
    "clanTag" TEXT NOT NULL,
    "roundDay" INTEGER NOT NULL,
    "playerTag" TEXT NOT NULL,
    "playerName" TEXT NOT NULL,
    "mapPosition" INTEGER,
    "townHall" INTEGER,
    "attacksUsed" INTEGER NOT NULL DEFAULT 0,
    "attacksAvailable" INTEGER NOT NULL DEFAULT 1,
    "stars" INTEGER NOT NULL DEFAULT 0,
    "destruction" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "subbedIn" BOOLEAN NOT NULL DEFAULT true,
    "subbedOut" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CwlRoundMemberHistory_pkey" PRIMARY KEY ("season","clanTag","roundDay","playerTag")
);

-- CreateTable
CREATE TABLE "CwlRotationPlan" (
    "id" TEXT NOT NULL,
    "clanTag" TEXT NOT NULL,
    "season" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "rosterSize" INTEGER NOT NULL,
    "generatedFromRoundDay" INTEGER,
    "excludedPlayerTags" TEXT[],
    "warningSummary" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CwlRotationPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CwlRotationPlanDay" (
    "id" SERIAL NOT NULL,
    "planId" TEXT NOT NULL,
    "roundDay" INTEGER NOT NULL,
    "lineupSize" INTEGER NOT NULL,
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CwlRotationPlanDay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CwlRotationPlanMember" (
    "id" SERIAL NOT NULL,
    "planDayId" INTEGER NOT NULL,
    "playerTag" TEXT NOT NULL,
    "playerName" TEXT NOT NULL,
    "assignmentOrder" INTEGER NOT NULL,
    "manualOverride" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CwlRotationPlanMember_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CurrentCwlRound_season_roundDay_idx" ON "CurrentCwlRound"("season", "roundDay");

-- CreateIndex
CREATE INDEX "CurrentCwlRound_roundState_updatedAt_idx" ON "CurrentCwlRound"("roundState", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CurrentCwlRound_season_clanTag_roundDay_key" ON "CurrentCwlRound"("season", "clanTag", "roundDay");

-- CreateIndex
CREATE INDEX "CwlRoundMemberCurrent_season_clanTag_roundDay_idx" ON "CwlRoundMemberCurrent"("season", "clanTag", "roundDay");

-- CreateIndex
CREATE INDEX "CwlRoundMemberCurrent_season_playerTag_idx" ON "CwlRoundMemberCurrent"("season", "playerTag");

-- CreateIndex
CREATE INDEX "CwlRoundMemberCurrent_season_clanTag_subbedIn_idx" ON "CwlRoundMemberCurrent"("season", "clanTag", "subbedIn");

-- CreateIndex
CREATE INDEX "CwlRoundHistory_season_clanTag_endTime_idx" ON "CwlRoundHistory"("season", "clanTag", "endTime");

-- CreateIndex
CREATE INDEX "CwlRoundHistory_season_roundDay_idx" ON "CwlRoundHistory"("season", "roundDay");

-- CreateIndex
CREATE INDEX "CwlRoundMemberHistory_season_clanTag_playerTag_idx" ON "CwlRoundMemberHistory"("season", "clanTag", "playerTag");

-- CreateIndex
CREATE INDEX "CwlRoundMemberHistory_season_playerTag_idx" ON "CwlRoundMemberHistory"("season", "playerTag");

-- CreateIndex
CREATE INDEX "CwlRotationPlan_clanTag_season_isActive_idx" ON "CwlRotationPlan"("clanTag", "season", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "CwlRotationPlan_clanTag_season_version_key" ON "CwlRotationPlan"("clanTag", "season", "version");

-- CreateIndex
CREATE INDEX "CwlRotationPlanDay_roundDay_idx" ON "CwlRotationPlanDay"("roundDay");

-- CreateIndex
CREATE UNIQUE INDEX "CwlRotationPlanDay_planId_roundDay_key" ON "CwlRotationPlanDay"("planId", "roundDay");

-- CreateIndex
CREATE INDEX "CwlRotationPlanMember_playerTag_idx" ON "CwlRotationPlanMember"("playerTag");

-- CreateIndex
CREATE UNIQUE INDEX "CwlRotationPlanMember_planDayId_playerTag_key" ON "CwlRotationPlanMember"("planDayId", "playerTag");

-- AddForeignKey
ALTER TABLE "CwlRoundMemberCurrent" ADD CONSTRAINT "CwlRoundMemberCurrent_season_clanTag_fkey" FOREIGN KEY ("season", "clanTag") REFERENCES "CurrentCwlRound"("season", "clanTag") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CwlRoundMemberHistory" ADD CONSTRAINT "CwlRoundMemberHistory_season_clanTag_roundDay_fkey" FOREIGN KEY ("season", "clanTag", "roundDay") REFERENCES "CwlRoundHistory"("season", "clanTag", "roundDay") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CwlRotationPlanDay" ADD CONSTRAINT "CwlRotationPlanDay_planId_fkey" FOREIGN KEY ("planId") REFERENCES "CwlRotationPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CwlRotationPlanMember" ADD CONSTRAINT "CwlRotationPlanMember_planDayId_fkey" FOREIGN KEY ("planDayId") REFERENCES "CwlRotationPlanDay"("id") ON DELETE CASCADE ON UPDATE CASCADE;

