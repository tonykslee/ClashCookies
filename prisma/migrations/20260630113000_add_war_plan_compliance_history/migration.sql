CREATE TYPE "WarPlanComplianceEvaluationStatus" AS ENUM (
  'PENDING',
  'COMPLETED',
  'INSUFFICIENT_DATA',
  'FAILED'
);

CREATE TYPE "WarPlanViolationType" AS ENUM (
  'EARLY_NON_MIRROR_TRIPLE',
  'STRICT_WINDOW_MIRROR_MISS_WIN',
  'STRICT_WINDOW_MIRROR_MISS_LOSS',
  'EARLY_NON_MIRROR_2STAR',
  'ANY_3STAR',
  'LOWER20_ANY_STARS',
  'OTHER_PLAN_VIOLATION'
);

CREATE TABLE "WarPlanComplianceEvaluation" (
  "id" TEXT NOT NULL,
  "guildId" TEXT NOT NULL,
  "warId" INTEGER NOT NULL,
  "status" "WarPlanComplianceEvaluationStatus" NOT NULL DEFAULT 'PENDING',
  "engineVersion" TEXT,
  "matchType" "WarMatchType",
  "expectedOutcome" TEXT,
  "loseStyle" "LoseStyle",
  "nonMirrorTripleMinClanStars" INTEGER,
  "allBasesOpenHoursLeft" INTEGER,
  "rulesFingerprint" TEXT,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "lastAttemptAt" TIMESTAMP(3),
  "nextAttemptAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "failureCode" TEXT,
  "failureMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WarPlanComplianceEvaluation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WarPlanViolation" (
  "id" TEXT NOT NULL,
  "evaluationId" TEXT NOT NULL,
  "playerTag" TEXT NOT NULL,
  "playerNameSnapshot" TEXT NOT NULL,
  "playerPosition" INTEGER,
  "townHallLevelSnapshot" INTEGER,
  "violationType" "WarPlanViolationType" NOT NULL,
  "reasonLabel" TEXT,
  "expectedBehavior" TEXT NOT NULL,
  "actualBehavior" TEXT NOT NULL,
  "breachStarsAt" INTEGER,
  "breachTimeRemaining" TEXT,
  "attackDetails" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WarPlanViolation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WarPlanComplianceEvaluation_guildId_warId_key"
  ON "WarPlanComplianceEvaluation"("guildId", "warId");

CREATE INDEX "WarPlanComplianceEvaluation_guildId_status_nextAttemptAt_idx"
  ON "WarPlanComplianceEvaluation"("guildId", "status", "nextAttemptAt");

CREATE INDEX "WarPlanComplianceEvaluation_guildId_completedAt_idx"
  ON "WarPlanComplianceEvaluation"("guildId", "completedAt");

CREATE INDEX "WarPlanComplianceEvaluation_warId_idx"
  ON "WarPlanComplianceEvaluation"("warId");

CREATE UNIQUE INDEX "WarPlanViolation_evaluationId_playerTag_key"
  ON "WarPlanViolation"("evaluationId", "playerTag");

CREATE INDEX "WarPlanViolation_playerTag_idx"
  ON "WarPlanViolation"("playerTag");

CREATE INDEX "WarPlanViolation_violationType_idx"
  ON "WarPlanViolation"("violationType");

ALTER TABLE "WarPlanComplianceEvaluation"
  ADD CONSTRAINT "WarPlanComplianceEvaluation_warId_fkey"
  FOREIGN KEY ("warId") REFERENCES "ClanWarHistory"("warId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WarPlanViolation"
  ADD CONSTRAINT "WarPlanViolation_evaluationId_fkey"
  FOREIGN KEY ("evaluationId") REFERENCES "WarPlanComplianceEvaluation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
