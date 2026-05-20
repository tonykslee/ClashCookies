-- CreateTable
CREATE TABLE "BlacklistHeatMapRef" (
    "weightMinInclusive" INTEGER NOT NULL,
    "weightMaxInclusive" INTEGER NOT NULL,
    "th18Count" INTEGER NOT NULL,
    "th17Count" INTEGER NOT NULL,
    "th16Count" INTEGER NOT NULL,
    "th15Count" INTEGER NOT NULL,
    "th14Count" INTEGER NOT NULL,
    "th13Count" INTEGER NOT NULL,
    "th12Count" INTEGER NOT NULL,
    "th11PlusCount" INTEGER NOT NULL,
    "sampleCount" INTEGER NOT NULL,
    "uniqueSourceClanCount" INTEGER NOT NULL,
    "uniqueOpponentCount" INTEGER NOT NULL,
    "totalMissingWeightCount" INTEGER NOT NULL,
    "confidenceLabel" TEXT NOT NULL,
    "confidenceScore" INTEGER NOT NULL,
    "generatedAt" DATETIME NOT NULL,

    PRIMARY KEY ("weightMinInclusive", "weightMaxInclusive")
);

-- CreateIndex
CREATE INDEX "BlacklistHeatMapRef_generatedAt_idx" ON "BlacklistHeatMapRef"("generatedAt");
