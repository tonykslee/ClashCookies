ALTER TYPE "WarPlanComplianceEvaluationStatus" ADD VALUE IF NOT EXISTS 'SKIPPED';

ALTER TABLE "WarPlanComplianceEvaluation"
  ADD COLUMN IF NOT EXISTS "claimToken" TEXT,
  ADD COLUMN IF NOT EXISTS "claimExpiresAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "WarPlanComplianceEvaluation_status_nextAttemptAt_idx"
  ON "WarPlanComplianceEvaluation"("status", "nextAttemptAt");
