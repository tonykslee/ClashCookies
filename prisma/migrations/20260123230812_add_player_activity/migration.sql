-- CreateTable
CREATE TABLE "PlayerActivity" (
    "tag" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "clanTag" TEXT NOT NULL,
    "lastDonationAt" DATETIME,
    "lastCapitalAt" DATETIME,
    "lastTrophyAt" DATETIME,
    "lastWarAt" DATETIME,
    "lastBuilderAt" DATETIME,
    "lastSeenAt" DATETIME NOT NULL,
    "updatedAt" DATETIME NOT NULL
);
