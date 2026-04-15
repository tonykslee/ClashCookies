-- CreateTable
CREATE TABLE "RaidTrackedClan" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "clanTag" VARCHAR(16) NOT NULL,
    "upgrades" INTEGER,
    "joinType" VARCHAR(16),
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "RaidTrackedClan_clanTag_key" ON "RaidTrackedClan"("clanTag");

-- CreateIndex
CREATE INDEX "RaidTrackedClan_clanTag_idx" ON "RaidTrackedClan"("clanTag");
