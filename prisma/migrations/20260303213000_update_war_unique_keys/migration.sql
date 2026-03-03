-- Update war table unique constraints.

-- WarAttacks: use warId + playerTag + attackNumber.
DROP INDEX IF EXISTS "WarAttacks_clanTag_warStartTime_playerTag_attackOrder_key";
CREATE UNIQUE INDEX "WarAttacks_warId_playerTag_attackNumber_key"
ON "WarAttacks"("warId", "playerTag", "attackNumber");

-- ClanWarHistory: include opponentTag in the war identity.
DROP INDEX IF EXISTS "ClanWarHistory_clanTag_warStartTime_key";
CREATE UNIQUE INDEX "ClanWarHistory_warStartTime_clanTag_opponentTag_key"
ON "ClanWarHistory"("warStartTime", "clanTag", "opponentTag");

-- CurrentWar: add an index for current-war identity fields.
CREATE INDEX IF NOT EXISTS "CurrentWar_lastWarStartTime_clanTag_lastOpponentTag_idx"
ON "CurrentWar"("lastWarStartTime", "clanTag", "lastOpponentTag");
