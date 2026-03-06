ALTER TABLE "ClanWarPlan"
ADD COLUMN "clanTag" TEXT NOT NULL DEFAULT '';

DROP INDEX IF EXISTS "ClanWarPlan_guildId_matchType_idx";
DROP INDEX IF EXISTS "ClanWarPlan_guildId_matchType_outcome_loseStyle_key";

CREATE UNIQUE INDEX "ClanWarPlan_guildId_clanTag_matchType_outcome_loseStyle_key"
ON "ClanWarPlan"("guildId", "clanTag", "matchType", "outcome", "loseStyle");

CREATE INDEX "ClanWarPlan_guildId_clanTag_matchType_idx"
ON "ClanWarPlan"("guildId", "clanTag", "matchType");
