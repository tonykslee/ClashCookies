CREATE TABLE "ExternalPlayerWeightCurrent" (
    "id" TEXT NOT NULL,
    "playerTag" TEXT NOT NULL,
    "weight" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "measuredAt" TIMESTAMP(3) NOT NULL,
    "createdByUserId" TEXT,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExternalPlayerWeightCurrent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ExternalPlayerWeightCurrent_playerTag_key" ON "ExternalPlayerWeightCurrent"("playerTag");
CREATE INDEX "ExternalPlayerWeightCurrent_measuredAt_idx" ON "ExternalPlayerWeightCurrent"("measuredAt");
