-- CreateTable
CREATE TABLE "FwaWarMembersObservationEvidence" (
    "id" TEXT NOT NULL,
    "observationId" TEXT NOT NULL,
    "evidenceSchemaVersion" TEXT NOT NULL,
    "sourceContractVersion" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "sourceWarNo" INTEGER NOT NULL,
    "firstObservedAt" TIMESTAMP(3) NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "ingestedAt" TIMESTAMP(3) NOT NULL,
    "rawRowCount" INTEGER NOT NULL,
    "acceptedRowCount" INTEGER NOT NULL,
    "discardedRowCount" INTEGER NOT NULL,
    "parserAcceptedRowCount" INTEGER NOT NULL,
    "parserRejectedRowCount" INTEGER NOT NULL,
    "evidenceEligibleRowCount" INTEGER NOT NULL,
    "evidenceIneligibleRowCount" INTEGER NOT NULL,
    "rawWeightPresentCount" INTEGER NOT NULL,
    "rawWeightMissingCount" INTEGER NOT NULL,
    "rawWeightInvalidCount" INTEGER NOT NULL,
    "canonicalSourceFingerprint" TEXT NOT NULL,
    "sourceQualityFingerprint" TEXT NOT NULL,
    "structuralStatus" TEXT NOT NULL,
    "rosterCompletenessStatus" TEXT NOT NULL,
    "weightStatus" TEXT NOT NULL,
    "sourceAuthorityStatus" TEXT NOT NULL,
    "sourceQualityReasonCodes" JSONB NOT NULL,

    CONSTRAINT "FwaWarMembersObservationEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FwaWarMembersObservationEvidence_observationId_sourceQualityFingerprint_key" ON "FwaWarMembersObservationEvidence"("observationId", "sourceQualityFingerprint");
CREATE INDEX "FwaWarMembersObservationEvidence_observationId_firstObservedAt_idx" ON "FwaWarMembersObservationEvidence"("observationId", "firstObservedAt");
CREATE INDEX "FwaWarMembersObservationEvidence_sourceQualityFingerprint_idx" ON "FwaWarMembersObservationEvidence"("sourceQualityFingerprint");

-- AddForeignKey
ALTER TABLE "FwaWarMembersObservationEvidence" ADD CONSTRAINT "FwaWarMembersObservationEvidence_observationId_fkey" FOREIGN KEY ("observationId") REFERENCES "FwaWarMembersObservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
