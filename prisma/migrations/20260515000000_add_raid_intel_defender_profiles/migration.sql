-- CreateTable
CREATE TABLE "RaidIntelDefenderProfile" (
    "id" SERIAL NOT NULL,
    "guildId" TEXT NOT NULL,
    "defenderTag" VARCHAR(16) NOT NULL,
    "upgrades" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RaidIntelDefenderProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RaidIntelDefenderProfile_guildId_defenderTag_key"
  ON "RaidIntelDefenderProfile"("guildId", "defenderTag");

-- CreateIndex
CREATE INDEX "RaidIntelDefenderProfile_guildId_defenderTag_idx"
  ON "RaidIntelDefenderProfile"("guildId", "defenderTag");
