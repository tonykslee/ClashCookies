CREATE TABLE "TodoPlayerSnapshot" (
    "playerTag" TEXT NOT NULL,
    "playerName" TEXT NOT NULL,
    "clanTag" TEXT,
    "clanName" TEXT,
    "warActive" BOOLEAN NOT NULL DEFAULT false,
    "warAttacksUsed" INTEGER NOT NULL DEFAULT 0,
    "warAttacksMax" INTEGER NOT NULL DEFAULT 2,
    "warPhase" TEXT,
    "warEndsAt" TIMESTAMP(3),
    "cwlActive" BOOLEAN NOT NULL DEFAULT false,
    "cwlAttacksUsed" INTEGER NOT NULL DEFAULT 0,
    "cwlAttacksMax" INTEGER NOT NULL DEFAULT 1,
    "cwlPhase" TEXT,
    "cwlEndsAt" TIMESTAMP(3),
    "raidActive" BOOLEAN NOT NULL DEFAULT false,
    "raidAttacksUsed" INTEGER NOT NULL DEFAULT 0,
    "raidAttacksMax" INTEGER NOT NULL DEFAULT 6,
    "raidEndsAt" TIMESTAMP(3),
    "gamesActive" BOOLEAN NOT NULL DEFAULT false,
    "gamesPoints" INTEGER,
    "gamesTarget" INTEGER,
    "gamesEndsAt" TIMESTAMP(3),
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TodoPlayerSnapshot_pkey" PRIMARY KEY ("playerTag")
);

CREATE INDEX "TodoPlayerSnapshot_clanTag_idx" ON "TodoPlayerSnapshot"("clanTag");
CREATE INDEX "TodoPlayerSnapshot_updatedAt_idx" ON "TodoPlayerSnapshot"("updatedAt");