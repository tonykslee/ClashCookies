-- CreateEnum
CREATE TYPE "RaidIntelLayoutGrade" AS ENUM ('DEFAULT', 'CUSTOM_HARD', 'CUSTOM_MEDIUM', 'CUSTOM_EASY');

-- CreateTable
CREATE TABLE "RaidIntelDistrictLayoutMark" (
    "id" SERIAL NOT NULL,
    "guildId" TEXT NOT NULL,
    "sourceClanTag" VARCHAR(16) NOT NULL,
    "raidSeasonStartTime" TIMESTAMP(3) NOT NULL,
    "defenderTag" VARCHAR(16) NOT NULL,
    "districtName" TEXT NOT NULL,
    "districtHallLevel" INTEGER,
    "layoutGrade" "RaidIntelLayoutGrade" NOT NULL,
    "markedByDiscordUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RaidIntelDistrictLayoutMark_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RaidIntelDistrictLayoutMark_guildId_sourceClanTag_raidSeasonStartTime_defenderTag_districtName_key"
  ON "RaidIntelDistrictLayoutMark"("guildId", "sourceClanTag", "raidSeasonStartTime", "defenderTag", "districtName");

-- CreateIndex
CREATE INDEX "RaidIntelDistrictLayoutMark_guildId_sourceClanTag_raidSeasonStartTime_idx"
  ON "RaidIntelDistrictLayoutMark"("guildId", "sourceClanTag", "raidSeasonStartTime");

-- CreateIndex
CREATE INDEX "RaidIntelDistrictLayoutMark_guildId_defenderTag_idx"
  ON "RaidIntelDistrictLayoutMark"("guildId", "defenderTag");
