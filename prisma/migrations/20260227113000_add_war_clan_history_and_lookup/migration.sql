CREATE SEQUENCE IF NOT EXISTS "WarClanHistory_warId_seq"
    START WITH 1000000
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE TABLE "WarClanHistory" (
  "warId" INTEGER NOT NULL DEFAULT nextval('"WarClanHistory_warId_seq"'),
  "syncNumber" INTEGER,
  "matchType" "WarMatchType",
  "clanStars" INTEGER,
  "clanDestruction" DOUBLE PRECISION,
  "opponentStars" INTEGER,
  "opponentDestruction" DOUBLE PRECISION,
  "fwaPointsGained" INTEGER,
  "expectedOutcome" TEXT,
  "actualOutcome" TEXT,
  "enemyPoints" INTEGER,
  "warStartTime" TIMESTAMP(3) NOT NULL,
  "warEndTime" TIMESTAMP(3),
  "clanName" TEXT,
  "clanTag" TEXT NOT NULL,
  "opponentName" TEXT,
  "opponentTag" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "WarClanHistory_pkey" PRIMARY KEY ("warId")
);

CREATE UNIQUE INDEX "WarClanHistory_clanTag_warStartTime_key"
ON "WarClanHistory"("clanTag", "warStartTime");

CREATE INDEX "WarClanHistory_clanTag_warEndTime_idx"
ON "WarClanHistory"("clanTag", "warEndTime");

CREATE TABLE "WarLookup" (
  "warId" INTEGER NOT NULL,
  "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "WarLookup_pkey" PRIMARY KEY ("warId")
);

ALTER TABLE "WarLookup"
ADD CONSTRAINT "WarLookup_warId_fkey"
FOREIGN KEY ("warId") REFERENCES "WarClanHistory"("warId")
ON DELETE CASCADE ON UPDATE CASCADE;
