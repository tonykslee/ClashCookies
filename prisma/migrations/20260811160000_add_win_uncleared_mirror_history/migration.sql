ALTER TYPE "WarPlanViolationType" ADD VALUE IF NOT EXISTS 'WIN_UNCLEARED_MIRROR';

ALTER TABLE "WarPlanComplianceEvaluation"
ADD COLUMN "winRequireMirrorAfterOpen" BOOLEAN;
