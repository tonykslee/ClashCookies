-- CreateTable
CREATE TABLE "CwlRotationExport" (
    "id" TEXT NOT NULL,
    "season" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "spreadsheetId" TEXT NOT NULL,
    "spreadsheetUrl" TEXT NOT NULL,
    "tabCount" INTEGER NOT NULL,
    "createdByDiscordUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CwlRotationExport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CwlRotationExport_season_createdAt_idx" ON "CwlRotationExport"("season", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CwlRotationExport_season_fingerprint_key" ON "CwlRotationExport"("season", "fingerprint");
