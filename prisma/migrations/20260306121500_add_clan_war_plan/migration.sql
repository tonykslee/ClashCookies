CREATE TABLE "ClanWarPlan" (
  "id" TEXT NOT NULL,
  "guildId" TEXT NOT NULL,
  "clanTag" TEXT NOT NULL,
  "prepPlan" TEXT,
  "battlePlan" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ClanWarPlan_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ClanWarPlan_guildId_clanTag_key"
ON "ClanWarPlan"("guildId", "clanTag");
