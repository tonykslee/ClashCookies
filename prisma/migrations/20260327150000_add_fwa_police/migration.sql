ALTER TABLE "TrackedClan"
ADD COLUMN "fwaPoliceDmEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "fwaPoliceLogEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "FwaPoliceHandledViolation" (
  "id" TEXT NOT NULL,
  "clanTag" TEXT NOT NULL,
  "warId" INTEGER NOT NULL,
  "playerTag" TEXT NOT NULL,
  "violationKey" TEXT NOT NULL,
  "linkedDiscordUserId" TEXT,
  "dmSentAt" TIMESTAMP(3),
  "logSentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FwaPoliceHandledViolation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FwaPoliceHandledViolation_clanTag_warId_playerTag_violationKey_key"
  ON "FwaPoliceHandledViolation"("clanTag", "warId", "playerTag", "violationKey");

CREATE INDEX "FwaPoliceHandledViolation_clanTag_warId_createdAt_idx"
  ON "FwaPoliceHandledViolation"("clanTag", "warId", "createdAt");
