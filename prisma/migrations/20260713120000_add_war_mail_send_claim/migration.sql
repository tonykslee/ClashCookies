-- Add nullable, backward-compatible send-claim metadata to WarMailLifecycle.
ALTER TABLE "WarMailLifecycle"
  ADD COLUMN "sendClaimToken" TEXT,
  ADD COLUMN "sendClaimKey" TEXT,
  ADD COLUMN "sendClaimedAt" TIMESTAMP(3),
  ADD COLUMN "lastCompletedSendKey" TEXT;
