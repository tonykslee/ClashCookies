ALTER TABLE "TodoPlayerSnapshot"
ADD COLUMN "cwlClanTag" TEXT,
ADD COLUMN "cwlClanName" TEXT;

CREATE INDEX "TodoPlayerSnapshot_cwlClanTag_idx" ON "TodoPlayerSnapshot"("cwlClanTag");

CREATE TABLE "CwlTrackedClan" (
    "id" SERIAL NOT NULL,
    "season" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CwlTrackedClan_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CwlTrackedClan_season_tag_key" ON "CwlTrackedClan"("season", "tag");
CREATE INDEX "CwlTrackedClan_season_createdAt_idx" ON "CwlTrackedClan"("season", "createdAt");

CREATE TABLE "CwlPlayerClanSeason" (
    "id" SERIAL NOT NULL,
    "season" TEXT NOT NULL,
    "playerTag" TEXT NOT NULL,
    "cwlClanTag" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CwlPlayerClanSeason_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CwlPlayerClanSeason_season_playerTag_key" ON "CwlPlayerClanSeason"("season", "playerTag");
CREATE INDEX "CwlPlayerClanSeason_season_cwlClanTag_idx" ON "CwlPlayerClanSeason"("season", "cwlClanTag");
CREATE INDEX "CwlPlayerClanSeason_season_playerTag_idx" ON "CwlPlayerClanSeason"("season", "playerTag");
