CREATE TABLE "CurrentCwlPrepSnapshot" (
  "season" TEXT NOT NULL,
  "clanTag" TEXT NOT NULL,
  "roundDay" INTEGER NOT NULL,
  "clanName" TEXT,
  "opponentTag" TEXT,
  "opponentName" TEXT,
  "roundState" TEXT NOT NULL,
  "leagueGroupState" TEXT,
  "preparationStartTime" TIMESTAMP(3),
  "startTime" TIMESTAMP(3),
  "endTime" TIMESTAMP(3),
  "lineupJson" JSONB NOT NULL,
  "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CurrentCwlPrepSnapshot_pkey" PRIMARY KEY ("season", "clanTag")
);

CREATE UNIQUE INDEX "CurrentCwlPrepSnapshot_season_clanTag_roundDay_key"
  ON "CurrentCwlPrepSnapshot"("season", "clanTag", "roundDay");

CREATE INDEX "CurrentCwlPrepSnapshot_season_roundDay_idx"
  ON "CurrentCwlPrepSnapshot"("season", "roundDay");

CREATE INDEX "CurrentCwlPrepSnapshot_roundState_updatedAt_idx"
  ON "CurrentCwlPrepSnapshot"("roundState", "updatedAt");
