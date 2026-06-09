-- AlterTable
ALTER TABLE "BanRecord"
ADD COLUMN "clanTag" VARCHAR(16),
ADD COLUMN "clanName" TEXT;

-- CreateIndex
CREATE INDEX "BanRecord_guildId_clanTag_idx" ON "BanRecord"("guildId", "clanTag");
