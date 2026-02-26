CREATE TABLE "WarHistoryParticipant" (
  "id" SERIAL NOT NULL,
  "clanTag" TEXT NOT NULL,
  "clanName" TEXT,
  "opponentClanTag" TEXT,
  "opponentClanName" TEXT,
  "warStartTime" TIMESTAMP(3) NOT NULL,
  "warEndTime" TIMESTAMP(3),
  "warState" TEXT,
  "playerTag" TEXT NOT NULL,
  "playerName" TEXT,
  "playerPosition" INTEGER,
  "attacksUsed" INTEGER NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WarHistoryParticipant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WarHistoryAttack" (
  "id" SERIAL NOT NULL,
  "clanTag" TEXT NOT NULL,
  "clanName" TEXT,
  "opponentClanTag" TEXT,
  "opponentClanName" TEXT,
  "warStartTime" TIMESTAMP(3) NOT NULL,
  "warEndTime" TIMESTAMP(3),
  "warState" TEXT,
  "playerTag" TEXT NOT NULL,
  "playerName" TEXT,
  "playerPosition" INTEGER,
  "attackOrder" INTEGER NOT NULL,
  "attackNumber" INTEGER NOT NULL,
  "defenderTag" TEXT,
  "defenderName" TEXT,
  "defenderPosition" INTEGER,
  "stars" INTEGER NOT NULL,
  "trueStars" INTEGER NOT NULL,
  "destruction" DOUBLE PRECISION NOT NULL,
  "attackSeenAt" TIMESTAMP(3) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WarHistoryAttack_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WarHistoryParticipant_clanTag_warStartTime_playerTag_key"
ON "WarHistoryParticipant"("clanTag", "warStartTime", "playerTag");

CREATE INDEX "WarHistoryParticipant_clanTag_warStartTime_idx"
ON "WarHistoryParticipant"("clanTag", "warStartTime");

CREATE INDEX "WarHistoryParticipant_playerTag_warStartTime_idx"
ON "WarHistoryParticipant"("playerTag", "warStartTime");

CREATE UNIQUE INDEX "WarHistoryAttack_clanTag_warStartTime_playerTag_attackOrder_key"
ON "WarHistoryAttack"("clanTag", "warStartTime", "playerTag", "attackOrder");

CREATE INDEX "WarHistoryAttack_clanTag_warStartTime_idx"
ON "WarHistoryAttack"("clanTag", "warStartTime");

CREATE INDEX "WarHistoryAttack_playerTag_warStartTime_idx"
ON "WarHistoryAttack"("playerTag", "warStartTime");
