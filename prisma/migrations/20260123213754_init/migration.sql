-- CreateTable
CREATE TABLE "PlayerSnapshot" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "tag" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "clanTag" TEXT NOT NULL,
    "trophies" INTEGER NOT NULL,
    "donations" INTEGER NOT NULL,
    "donationsReceived" INTEGER NOT NULL,
    "warStars" INTEGER NOT NULL,
    "builderTrophies" INTEGER NOT NULL,
    "capitalGold" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "PlayerSnapshot_tag_createdAt_idx" ON "PlayerSnapshot"("tag", "createdAt");
