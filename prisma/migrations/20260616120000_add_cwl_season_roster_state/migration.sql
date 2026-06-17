CREATE TABLE "CwlSeasonRosterState" (
  "season" TEXT NOT NULL,
  "clanTag" TEXT NOT NULL,
  "authoritativeRosterCount" INTEGER NOT NULL,
  "reconciledAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

ALTER TABLE "CwlSeasonRosterState"
  ADD CONSTRAINT "CwlSeasonRosterState_pkey"
  PRIMARY KEY ("season", "clanTag");

CREATE INDEX "CwlSeasonRosterState_season_reconciledAt_idx"
  ON "CwlSeasonRosterState"("season", "reconciledAt");
