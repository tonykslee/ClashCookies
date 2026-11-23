-- CreateTable
CREATE TABLE "FwaWarMembersObservation" (
    "id" TEXT NOT NULL,
    "clanTag" TEXT NOT NULL,
    "sourceContractVersion" TEXT NOT NULL,
    "observationSchemaVersion" TEXT NOT NULL,
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
    "rosterFingerprint" TEXT NOT NULL,
    "structuralStatus" TEXT NOT NULL,
    "rosterCompletenessStatus" TEXT NOT NULL,
    "weightStatus" TEXT NOT NULL,
    "sourceAuthorityStatus" TEXT NOT NULL,
    "sourceQualityReasonCodes" JSONB NOT NULL,

    CONSTRAINT "FwaWarMembersObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FwaWarMembersObservationMember" (
    "id" TEXT NOT NULL,
    "observationId" TEXT NOT NULL,
    "memberFingerprint" TEXT NOT NULL,
    "playerTag" TEXT NOT NULL,
    "playerName" TEXT NOT NULL,
    "position" INTEGER,
    "townHall" INTEGER,
    "rawWeight" INTEGER,

    CONSTRAINT "FwaWarMembersObservationMember_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FwaWarMembersObservation_clanTag_rosterFingerprint_key" ON "FwaWarMembersObservation"("clanTag", "rosterFingerprint");
CREATE INDEX "FwaWarMembersObservation_clanTag_firstObservedAt_idx" ON "FwaWarMembersObservation"("clanTag", "firstObservedAt");
CREATE INDEX "FwaWarMembersObservation_canonicalSourceFingerprint_idx" ON "FwaWarMembersObservation"("canonicalSourceFingerprint");
CREATE INDEX "FwaWarMembersObservation_rosterFingerprint_idx" ON "FwaWarMembersObservation"("rosterFingerprint");
CREATE UNIQUE INDEX "FwaWarMembersObservationMember_observationId_memberFingerprint_key" ON "FwaWarMembersObservationMember"("observationId", "memberFingerprint");
CREATE INDEX "FwaWarMembersObservationMember_observationId_position_idx" ON "FwaWarMembersObservationMember"("observationId", "position");
CREATE INDEX "FwaWarMembersObservationMember_observationId_playerTag_idx" ON "FwaWarMembersObservationMember"("observationId", "playerTag");

-- AddForeignKey
ALTER TABLE "FwaWarMembersObservationMember" ADD CONSTRAINT "FwaWarMembersObservationMember_observationId_fkey" FOREIGN KEY ("observationId") REFERENCES "FwaWarMembersObservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
