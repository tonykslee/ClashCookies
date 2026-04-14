-- CreateTable
CREATE TABLE "FwaClanMatchStatsCurrent" (
    "clanTag" TEXT NOT NULL,
    "fwaWarCount" INTEGER NOT NULL,
    "blacklistedWarCount" INTEGER NOT NULL,
    "friendlyWarCount" INTEGER NOT NULL,
    "unknownWarCount" INTEGER NOT NULL,
    "successWarCount" INTEGER NOT NULL,
    "evaluatedWarCount" INTEGER NOT NULL,
    "matchRate" DOUBLE PRECISION NOT NULL,
    "lastComputedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FwaClanMatchStatsCurrent_pkey" PRIMARY KEY ("clanTag")
);

-- CreateIndex
CREATE INDEX "FwaClanMatchStatsCurrent_lastComputedAt_idx" ON "FwaClanMatchStatsCurrent"("lastComputedAt");
