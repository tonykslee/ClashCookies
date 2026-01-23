/*
  Warnings:

  - You are about to drop the column `donationsReceived` on the `PlayerSnapshot` table. All the data in the column will be lost.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_PlayerSnapshot" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "tag" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "clanTag" TEXT NOT NULL,
    "trophies" INTEGER NOT NULL,
    "donations" INTEGER NOT NULL,
    "warStars" INTEGER NOT NULL,
    "builderTrophies" INTEGER NOT NULL,
    "capitalGold" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_PlayerSnapshot" ("builderTrophies", "capitalGold", "clanTag", "createdAt", "donations", "id", "name", "tag", "trophies", "warStars") SELECT "builderTrophies", "capitalGold", "clanTag", "createdAt", "donations", "id", "name", "tag", "trophies", "warStars" FROM "PlayerSnapshot";
DROP TABLE "PlayerSnapshot";
ALTER TABLE "new_PlayerSnapshot" RENAME TO "PlayerSnapshot";
CREATE INDEX "PlayerSnapshot_tag_createdAt_idx" ON "PlayerSnapshot"("tag", "createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
