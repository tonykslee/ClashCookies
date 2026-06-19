CREATE TYPE "CwlAllianceSeasonBaselineCaptureStatus" AS ENUM ('CAPTURED', 'UNAVAILABLE');

CREATE TYPE "CwlAllianceSeasonBaselineSourceType" AS ENUM ('CURRENT_FWA_WAR', 'LATEST_FWA_WAR');

CREATE TABLE "CwlAllianceSeasonBaseline" (
  "id" TEXT NOT NULL,
  "guildId" TEXT NOT NULL,
  "season" TEXT NOT NULL,
  "capturedAt" TIMESTAMP(3) NOT NULL,
  "capturedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CwlAllianceSeasonBaseline_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CwlAllianceSeasonBaseline_guildId_season_key"
  ON "CwlAllianceSeasonBaseline"("guildId", "season");

CREATE INDEX "CwlAllianceSeasonBaseline_season_capturedAt_idx"
  ON "CwlAllianceSeasonBaseline"("season", "capturedAt");

CREATE INDEX "CwlAllianceSeasonBaseline_guildId_capturedAt_idx"
  ON "CwlAllianceSeasonBaseline"("guildId", "capturedAt");

CREATE TABLE "CwlAllianceSeasonBaselineClan" (
  "id" TEXT NOT NULL,
  "baselineId" TEXT NOT NULL,
  "clanTag" VARCHAR(16) NOT NULL,
  "clanName" TEXT,
  "captureStatus" "CwlAllianceSeasonBaselineCaptureStatus" NOT NULL,
  "sourceType" "CwlAllianceSeasonBaselineSourceType",
  "sourceWarId" INTEGER,
  "sourceWarStartTime" TIMESTAMP(3),
  "sourceWarEndTime" TIMESTAMP(3),
  "sourceOpponentTag" VARCHAR(16),
  "sourceObservedAt" TIMESTAMP(3),
  "rosterSize" INTEGER NOT NULL,
  "failureReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CwlAllianceSeasonBaselineClan_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CwlAllianceSeasonBaselineClan_baselineId_fkey"
    FOREIGN KEY ("baselineId") REFERENCES "CwlAllianceSeasonBaseline"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "CwlAllianceSeasonBaselineClan_baselineId_clanTag_key"
  ON "CwlAllianceSeasonBaselineClan"("baselineId", "clanTag");

CREATE INDEX "CwlAllianceSeasonBaselineClan_baselineId_captureStatus_idx"
  ON "CwlAllianceSeasonBaselineClan"("baselineId", "captureStatus");

CREATE INDEX "CwlAllianceSeasonBaselineClan_baselineId_idx"
  ON "CwlAllianceSeasonBaselineClan"("baselineId");

CREATE INDEX "CwlAllianceSeasonBaselineClan_clanTag_idx"
  ON "CwlAllianceSeasonBaselineClan"("clanTag");

CREATE TABLE "CwlAllianceSeasonBaselineMember" (
  "id" TEXT NOT NULL,
  "baselineId" TEXT NOT NULL,
  "baselineClanId" TEXT NOT NULL,
  "playerTag" VARCHAR(16) NOT NULL,
  "playerName" TEXT NOT NULL,
  "townHall" INTEGER,
  "position" INTEGER,
  "linkedDiscordUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CwlAllianceSeasonBaselineMember_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CwlAllianceSeasonBaselineMember_baselineId_fkey"
    FOREIGN KEY ("baselineId") REFERENCES "CwlAllianceSeasonBaseline"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "CwlAllianceSeasonBaselineMember_baselineClanId_fkey"
    FOREIGN KEY ("baselineClanId") REFERENCES "CwlAllianceSeasonBaselineClan"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "CwlAllianceSeasonBaselineMember_baselineId_playerTag_key"
  ON "CwlAllianceSeasonBaselineMember"("baselineId", "playerTag");

CREATE INDEX "CwlAllianceSeasonBaselineMember_baselineId_idx"
  ON "CwlAllianceSeasonBaselineMember"("baselineId");

CREATE INDEX "CwlAllianceSeasonBaselineMember_baselineClanId_idx"
  ON "CwlAllianceSeasonBaselineMember"("baselineClanId");

CREATE INDEX "CwlAllianceSeasonBaselineMember_playerTag_idx"
  ON "CwlAllianceSeasonBaselineMember"("playerTag");

CREATE INDEX "CwlAllianceSeasonBaselineMember_linkedDiscordUserId_idx"
  ON "CwlAllianceSeasonBaselineMember"("linkedDiscordUserId");

ALTER TABLE "ClanWarParticipation"
  ADD COLUMN IF NOT EXISTS "playerPosition" INTEGER;
