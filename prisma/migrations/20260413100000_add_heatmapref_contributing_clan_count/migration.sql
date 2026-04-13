-- AddHeatMapRefContributingClanCount
ALTER TABLE "HeatMapRef"
ADD COLUMN "contributingClanCount" INTEGER NOT NULL DEFAULT 0;
