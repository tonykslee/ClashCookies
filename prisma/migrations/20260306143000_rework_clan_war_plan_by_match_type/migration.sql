DROP TABLE IF EXISTS "ClanWarPlan";

CREATE TABLE "ClanWarPlan" (
  "id" TEXT NOT NULL,
  "guildId" TEXT NOT NULL,
  "matchType" "WarMatchType" NOT NULL,
  "outcome" TEXT NOT NULL,
  "planText" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ClanWarPlan_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ClanWarPlan_guildId_matchType_outcome_key"
ON "ClanWarPlan"("guildId", "matchType", "outcome");

CREATE INDEX "ClanWarPlan_guildId_matchType_idx"
ON "ClanWarPlan"("guildId", "matchType");
