CREATE TABLE "WeightInputDeferment" (
  "id" TEXT NOT NULL,
  "guildId" TEXT NOT NULL,
  "scopeKey" TEXT NOT NULL,
  "clanTag" TEXT,
  "playerTag" TEXT NOT NULL,
  "deferredWeight" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "resolvedAt" TIMESTAMP(3),
  "clearedAt" TIMESTAMP(3),
  "reminded48At" TIMESTAMP(3),
  "escalated5dAt" TIMESTAMP(3),
  "summarized7dAt" TIMESTAMP(3),
  "processingLockToken" TEXT,
  "processingLockExpiresAt" TIMESTAMP(3),

  CONSTRAINT "WeightInputDeferment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WeightInputDeferment_scopeKey_playerTag_key"
ON "WeightInputDeferment"("scopeKey", "playerTag");

CREATE INDEX "WeightInputDeferment_guildId_status_createdAt_idx"
ON "WeightInputDeferment"("guildId", "status", "createdAt");

CREATE INDEX "WeightInputDeferment_scopeKey_status_createdAt_idx"
ON "WeightInputDeferment"("scopeKey", "status", "createdAt");

CREATE INDEX "WeightInputDeferment_status_reminded48At_escalated5dAt_summarized7dAt_createdAt_idx"
ON "WeightInputDeferment"("status", "reminded48At", "escalated5dAt", "summarized7dAt", "createdAt");
