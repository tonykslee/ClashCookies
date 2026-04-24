CREATE TABLE "PlayerCurrent" (
    "playerTag" TEXT NOT NULL,
    "playerName" TEXT,
    "townHall" INTEGER,
    "currentClanTag" TEXT,
    "currentClanName" TEXT,
    "trophies" INTEGER,
    "builderTrophies" INTEGER,
    "warStars" INTEGER,
    "expLevel" INTEGER,
    "role" TEXT,
    "leagueName" TEXT,
    "currentWeight" INTEGER,
    "currentWeightSource" TEXT,
    "currentWeightMeasuredAt" TIMESTAMP(3),
    "achievementsJson" JSONB,
    "lastSeenAt" TIMESTAMP(3),
    "lastFetchedAt" TIMESTAMP(3),
    "lastSource" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlayerCurrent_pkey" PRIMARY KEY ("playerTag")
);

CREATE INDEX "PlayerCurrent_currentClanTag_idx" ON "PlayerCurrent"("currentClanTag");
CREATE INDEX "PlayerCurrent_updatedAt_idx" ON "PlayerCurrent"("updatedAt");
CREATE INDEX "PlayerCurrent_lastFetchedAt_idx" ON "PlayerCurrent"("lastFetchedAt");
CREATE INDEX "PlayerCurrent_currentWeightMeasuredAt_idx" ON "PlayerCurrent"("currentWeightMeasuredAt");
