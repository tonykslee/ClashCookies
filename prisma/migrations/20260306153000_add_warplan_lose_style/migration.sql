ALTER TABLE "ClanWarPlan"
ADD COLUMN "loseStyle" TEXT NOT NULL DEFAULT 'ANY';

DROP INDEX IF EXISTS "ClanWarPlan_guildId_matchType_outcome_key";

CREATE UNIQUE INDEX "ClanWarPlan_guildId_matchType_outcome_loseStyle_key"
ON "ClanWarPlan"("guildId", "matchType", "outcome", "loseStyle");
