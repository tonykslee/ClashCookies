CREATE TABLE "WarEvent" (
  "warId" INTEGER NOT NULL,
  "clanTag" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "payload" JSONB NOT NULL,

  CONSTRAINT "WarEvent_pkey" PRIMARY KEY ("warId","clanTag","eventType")
);

CREATE INDEX "WarEvent_clanTag_createdAt_idx" ON "WarEvent"("clanTag", "createdAt");
