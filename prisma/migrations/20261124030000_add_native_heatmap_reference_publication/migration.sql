-- Additive native reference publication storage. Legacy HeatMapRef tables are not touched.
CREATE TYPE "NativeHeatMapReferenceGenerationStatus" AS ENUM ('PREVIEW', 'VERIFIED', 'REJECTED');
CREATE TYPE "NativeHeatMapReferenceTargetStatus" AS ENUM ('SUPPORTED', 'UNKNOWN');
CREATE TYPE "NativeHeatMapReferencePublicationEventType" AS ENUM ('PREVIEW', 'PUBLISHED', 'REJECTED_STALE', 'REJECTED_CONFLICT', 'REJECTED_INVALID', 'ROLLBACK');

CREATE TABLE "NativeHeatMapReferenceGeneration" (
    "generationId" TEXT NOT NULL,
    "profileId" VARCHAR(128) NOT NULL,
    "profileVersion" VARCHAR(64) NOT NULL,
    "policyId" VARCHAR(128) NOT NULL,
    "policyVersion" VARCHAR(64) NOT NULL,
    "sampleThreshold" INTEGER NOT NULL,
    "minimumDirectWeightAnchors" INTEGER NOT NULL,
    "authorityStatus" VARCHAR(64) NOT NULL,
    "evaluationAt" TIMESTAMP(3) NOT NULL,
    "eraPolicyId" VARCHAR(128) NOT NULL,
    "eraPolicyVersion" VARCHAR(64) NOT NULL,
    "eraStart" TIMESTAMP(3) NOT NULL,
    "eraEnd" TIMESTAMP(3) NOT NULL,
    "status" "NativeHeatMapReferenceGenerationStatus" NOT NULL,
    "bucketDefinitionFingerprint" VARCHAR(128) NOT NULL,
    "sourceLineageFingerprint" VARCHAR(128) NOT NULL,
    "contentFingerprint" VARCHAR(128) NOT NULL,
    "requestKey" VARCHAR(128) NOT NULL,
    "candidateFingerprint" VARCHAR(128),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedAt" TIMESTAMP(3),
    CONSTRAINT "NativeHeatMapReferenceGeneration_pkey" PRIMARY KEY ("generationId")
);
CREATE UNIQUE INDEX "NativeHeatMapReferenceGeneration_profileId_policyVersion_requestKey_key" ON "NativeHeatMapReferenceGeneration"("profileId", "policyVersion", "requestKey");
CREATE INDEX "NativeHeatMapReferenceGeneration_profileId_policyVersion_createdAt_idx" ON "NativeHeatMapReferenceGeneration"("profileId", "policyVersion", "createdAt");
CREATE INDEX "NativeHeatMapReferenceGeneration_status_profileId_policyVersion_idx" ON "NativeHeatMapReferenceGeneration"("status", "profileId", "policyVersion");

CREATE TABLE "NativeHeatMapReferenceGenerationBand" (
    "generationId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "weightMinInclusive" INTEGER NOT NULL,
    "weightMaxInclusive" INTEGER NOT NULL,
    CONSTRAINT "NativeHeatMapReferenceGenerationBand_pkey" PRIMARY KEY ("generationId", "ordinal"),
    CONSTRAINT "NativeHeatMapReferenceGenerationBand_generationId_fkey" FOREIGN KEY ("generationId") REFERENCES "NativeHeatMapReferenceGeneration"("generationId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "NativeHeatMapReferenceGenerationBand_generationId_weightMinInclusive_weightMaxInclusive_key" ON "NativeHeatMapReferenceGenerationBand"("generationId", "weightMinInclusive", "weightMaxInclusive");

CREATE TABLE "NativeHeatMapReferenceGenerationBucket" (
    "generationId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "bucketId" VARCHAR(64) NOT NULL,
    "sourceBucketIds" JSONB NOT NULL,
    CONSTRAINT "NativeHeatMapReferenceGenerationBucket_pkey" PRIMARY KEY ("generationId", "ordinal"),
    CONSTRAINT "NativeHeatMapReferenceGenerationBucket_generationId_fkey" FOREIGN KEY ("generationId") REFERENCES "NativeHeatMapReferenceGeneration"("generationId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "NativeHeatMapReferenceGenerationBucket_generationId_bucketId_key" ON "NativeHeatMapReferenceGenerationBucket"("generationId", "bucketId");

CREATE TABLE "NativeHeatMapReferenceTarget" (
    "generationId" TEXT NOT NULL,
    "bandOrdinal" INTEGER NOT NULL,
    "bucketId" VARCHAR(64) NOT NULL,
    "status" "NativeHeatMapReferenceTargetStatus" NOT NULL,
    "targetCount" INTEGER,
    "qualifyingClanCount" INTEGER NOT NULL,
    "sampleCount" INTEGER NOT NULL,
    "reasonCode" TEXT,
    CONSTRAINT "NativeHeatMapReferenceTarget_pkey" PRIMARY KEY ("generationId", "bandOrdinal", "bucketId"),
    CONSTRAINT "NativeHeatMapReferenceTarget_generationId_fkey" FOREIGN KEY ("generationId") REFERENCES "NativeHeatMapReferenceGeneration"("generationId") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "NativeHeatMapReferenceTarget_band_fkey" FOREIGN KEY ("generationId", "bandOrdinal") REFERENCES "NativeHeatMapReferenceGenerationBand"("generationId", "ordinal") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "NativeHeatMapReferenceTarget_count_check" CHECK (("status" = 'UNKNOWN' AND "targetCount" IS NULL) OR ("status" = 'SUPPORTED' AND "targetCount" IS NOT NULL AND "targetCount" >= 0))
);
CREATE INDEX "NativeHeatMapReferenceTarget_generationId_status_idx" ON "NativeHeatMapReferenceTarget"("generationId", "status");

CREATE TABLE "NativeHeatMapReferenceLineage" (
    "generationId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "observationId" VARCHAR(128) NOT NULL,
    "observationContentFingerprint" VARCHAR(128) NOT NULL,
    "role" VARCHAR(64) NOT NULL,
    "inputDigest" VARCHAR(128) NOT NULL,
    CONSTRAINT "NativeHeatMapReferenceLineage_pkey" PRIMARY KEY ("generationId", "ordinal"),
    CONSTRAINT "NativeHeatMapReferenceLineage_generationId_fkey" FOREIGN KEY ("generationId") REFERENCES "NativeHeatMapReferenceGeneration"("generationId") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "NativeHeatMapReferenceLineage_generationId_observationId_key" UNIQUE ("generationId", "observationId")
);

CREATE TABLE "NativeHeatMapReferenceHead" (
    "profileId" VARCHAR(128) NOT NULL,
    "policyVersion" VARCHAR(64) NOT NULL,
    "generationId" VARCHAR(128),
    "fenceToken" BIGINT NOT NULL DEFAULT 0,
    "lastPublicationEventId" VARCHAR(128),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "NativeHeatMapReferenceHead_pkey" PRIMARY KEY ("profileId", "policyVersion")
);
CREATE INDEX "NativeHeatMapReferenceHead_generationId_idx" ON "NativeHeatMapReferenceHead"("generationId");

CREATE TABLE "NativeHeatMapReferencePublicationEvent" (
    "eventId" TEXT NOT NULL,
    "profileId" VARCHAR(128) NOT NULL,
    "policyVersion" VARCHAR(64) NOT NULL,
    "generationId" VARCHAR(128),
    "eventType" "NativeHeatMapReferencePublicationEventType" NOT NULL,
    "previousGenerationId" VARCHAR(128),
    "newGenerationId" VARCHAR(128),
    "previousFenceToken" BIGINT,
    "newFenceToken" BIGINT,
    "actorDiscordUserId" VARCHAR(128),
    "requestKey" VARCHAR(128),
    "reasonCode" VARCHAR(128),
    "contentFingerprint" VARCHAR(128),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NativeHeatMapReferencePublicationEvent_pkey" PRIMARY KEY ("eventId")
);
CREATE INDEX "NativeHeatMapReferencePublicationEvent_profileId_policyVersion_createdAt_idx" ON "NativeHeatMapReferencePublicationEvent"("profileId", "policyVersion", "createdAt");
CREATE INDEX "NativeHeatMapReferencePublicationEvent_generationId_idx" ON "NativeHeatMapReferencePublicationEvent"("generationId");
