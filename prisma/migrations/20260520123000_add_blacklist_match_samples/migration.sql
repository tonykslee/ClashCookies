-- CreateTable
CREATE TABLE "BlacklistMatchSample" (
    "sourceClanTag" TEXT NOT NULL,
    "sourceClanName" TEXT,
    "opponentBlacklistTag" TEXT NOT NULL,
    "opponentBlacklistName" TEXT,
    "warId" TEXT NOT NULL,
    "warStartTime" TIMESTAMP(3) NOT NULL,
    "warEndTime" TIMESTAMP(3),
    "rosterSize" INTEGER NOT NULL,
    "totalRosterWeight" INTEGER NOT NULL,
    "missingWeightCount" INTEGER NOT NULL,
    "th18Count" INTEGER NOT NULL,
    "th17Count" INTEGER NOT NULL,
    "th16Count" INTEGER NOT NULL,
    "th15Count" INTEGER NOT NULL,
    "th14Count" INTEGER NOT NULL,
    "th13Count" INTEGER NOT NULL,
    "th12Count" INTEGER NOT NULL,
    "th11PlusCount" INTEGER NOT NULL,
    "sampleQuality" TEXT NOT NULL,
    "confidence" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BlacklistMatchSample_pkey" PRIMARY KEY ("sourceClanTag","opponentBlacklistTag","warId")
);

-- CreateIndex
CREATE INDEX "BlacklistMatchSample_opponentBlacklistTag_warStartTime_idx" ON "BlacklistMatchSample"("opponentBlacklistTag", "warStartTime");

-- CreateIndex
CREATE INDEX "BlacklistMatchSample_sourceClanTag_warStartTime_idx" ON "BlacklistMatchSample"("sourceClanTag", "warStartTime");

-- CreateIndex
CREATE INDEX "BlacklistMatchSample_warStartTime_idx" ON "BlacklistMatchSample"("warStartTime");
