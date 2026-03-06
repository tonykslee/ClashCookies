CREATE TYPE "WarPlanScope" AS ENUM ('CUSTOM', 'DEFAULT');

ALTER TABLE "ClanWarPlan"
ADD COLUMN "scope" "WarPlanScope" NOT NULL DEFAULT 'CUSTOM';

DROP INDEX IF EXISTS "ClanWarPlan_guildId_clanTag_matchType_outcome_loseStyle_key";
DROP INDEX IF EXISTS "ClanWarPlan_guildId_clanTag_matchType_idx";

CREATE UNIQUE INDEX "ClanWarPlan_guildId_scope_clanTag_matchType_outcome_loseStyle_key"
ON "ClanWarPlan"("guildId", "scope", "clanTag", "matchType", "outcome", "loseStyle");

CREATE INDEX "ClanWarPlan_guildId_scope_clanTag_matchType_idx"
ON "ClanWarPlan"("guildId", "scope", "clanTag", "matchType");
