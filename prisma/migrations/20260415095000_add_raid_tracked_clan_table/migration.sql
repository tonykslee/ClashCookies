-- CreateTable
CREATE TABLE "RaidTrackedClan" (
    "id" SERIAL NOT NULL,
    "clanTag" VARCHAR(16) NOT NULL,
    "upgrades" INTEGER,
    "joinType" VARCHAR(16),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RaidTrackedClan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RaidTrackedClan_clanTag_key" ON "RaidTrackedClan"("clanTag");

-- CreateIndex
CREATE INDEX "RaidTrackedClan_clanTag_idx" ON "RaidTrackedClan"("clanTag");
