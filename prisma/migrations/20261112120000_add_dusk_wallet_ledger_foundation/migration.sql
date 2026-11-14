CREATE TYPE "DuskLedgerTransactionType" AS ENUM ('EARNING', 'SPEND', 'CORRECTION', 'REVERSAL');
CREATE TYPE "DuskLedgerBeneficiaryMode" AS ENUM ('SINGLE_RECIPIENT', 'MULTI_BENEFICIARY');
CREATE TYPE "DuskReversalResolutionType" AS ENUM ('APPLIED', 'DECLINED');

CREATE TABLE "DuskRewardPolicyVersion" (
    "version" VARCHAR(64) NOT NULL,
    "policyKey" VARCHAR(64) NOT NULL,
    "definition" JSONB NOT NULL,
    "createdByDiscordUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DuskRewardPolicyVersion_pkey" PRIMARY KEY ("version")
);

CREATE TABLE "DuskWallet" (
    "discordUserId" TEXT NOT NULL,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DuskWallet_pkey" PRIMARY KEY ("discordUserId"),
    CONSTRAINT "DuskWallet_balance_nonnegative" CHECK ("balance" >= 0)
);

CREATE TABLE "DuskLedgerEntry" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "transactionType" "DuskLedgerTransactionType" NOT NULL,
    "beneficiaryMode" "DuskLedgerBeneficiaryMode",
    "beneficiaryKey" VARCHAR(128),
    "sourceEventType" VARCHAR(64) NOT NULL,
    "sourceEventId" VARCHAR(128) NOT NULL,
    "idempotencyKey" VARCHAR(128) NOT NULL,
    "attribution" JSONB,
    "policyVersion" VARCHAR(64),
    "reason" VARCHAR(500) NOT NULL,
    "actorDiscordUserId" TEXT,
    "reversalOfId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DuskLedgerEntry_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DuskLedgerEntry_amount_nonzero" CHECK ("amount" <> 0),
    CONSTRAINT "DuskLedgerEntry_beneficiary_shape" CHECK (
      ("transactionType" = 'EARNING' AND (
        ("beneficiaryMode" = 'SINGLE_RECIPIENT' AND "beneficiaryKey" IS NULL)
        OR ("beneficiaryMode" = 'MULTI_BENEFICIARY' AND "beneficiaryKey" IS NOT NULL)
      ))
      OR ("transactionType" <> 'EARNING' AND "beneficiaryMode" IS NULL AND "beneficiaryKey" IS NULL)
    ),
    CONSTRAINT "DuskLedgerEntry_earning_positive" CHECK ("transactionType" <> 'EARNING' OR "amount" > 0),
    CONSTRAINT "DuskLedgerEntry_spend_negative" CHECK ("transactionType" <> 'SPEND' OR "amount" < 0),
    CONSTRAINT "DuskLedgerEntry_reversal_reference" CHECK ("transactionType" <> 'REVERSAL' OR "reversalOfId" IS NOT NULL),
    CONSTRAINT "DuskLedgerEntry_walletId_fkey"
      FOREIGN KEY ("walletId") REFERENCES "DuskWallet"("discordUserId") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DuskLedgerEntry_policyVersion_fkey"
      FOREIGN KEY ("policyVersion") REFERENCES "DuskRewardPolicyVersion"("version") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DuskLedgerEntry_reversalOfId_fkey"
      FOREIGN KEY ("reversalOfId") REFERENCES "DuskLedgerEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "DuskLedgerSourceEvent" (
    "id" TEXT NOT NULL,
    "sourceEventType" VARCHAR(64) NOT NULL,
    "sourceEventId" VARCHAR(128) NOT NULL,
    "beneficiaryMode" "DuskLedgerBeneficiaryMode" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DuskLedgerSourceEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DuskLedgerSourceEventClaim" (
    "id" TEXT NOT NULL,
    "sourceEventId" TEXT NOT NULL,
    "beneficiaryKey" VARCHAR(128),
    "walletId" TEXT NOT NULL,
    "ledgerEntryId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DuskLedgerSourceEventClaim_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DuskLedgerSourceEventClaim_sourceEventId_fkey"
      FOREIGN KEY ("sourceEventId") REFERENCES "DuskLedgerSourceEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DuskLedgerSourceEventClaim_walletId_fkey"
      FOREIGN KEY ("walletId") REFERENCES "DuskWallet"("discordUserId") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DuskLedgerSourceEventClaim_ledgerEntryId_fkey"
      FOREIGN KEY ("ledgerEntryId") REFERENCES "DuskLedgerEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "DuskLedgerReversalRequest" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "originalEntryId" TEXT NOT NULL,
    "requestedAmount" INTEGER NOT NULL,
    "sourceEventType" VARCHAR(64) NOT NULL,
    "sourceEventId" VARCHAR(128) NOT NULL,
    "idempotencyKey" VARCHAR(128) NOT NULL,
    "attribution" JSONB,
    "policyVersion" VARCHAR(64),
    "reason" VARCHAR(500) NOT NULL,
    "actorDiscordUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DuskLedgerReversalRequest_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DuskLedgerReversalRequest_requestedAmount_nonzero" CHECK ("requestedAmount" <> 0),
    CONSTRAINT "DuskLedgerReversalRequest_walletId_fkey"
      FOREIGN KEY ("walletId") REFERENCES "DuskWallet"("discordUserId") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DuskLedgerReversalRequest_originalEntryId_fkey"
      FOREIGN KEY ("originalEntryId") REFERENCES "DuskLedgerEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DuskLedgerReversalRequest_policyVersion_fkey"
      FOREIGN KEY ("policyVersion") REFERENCES "DuskRewardPolicyVersion"("version") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "DuskLedgerReversalResolution" (
    "id" TEXT NOT NULL,
    "reversalRequestId" TEXT NOT NULL,
    "resolutionEntryId" TEXT,
    "resolutionType" "DuskReversalResolutionType" NOT NULL,
    "actorDiscordUserId" TEXT NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DuskLedgerReversalResolution_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DuskLedgerReversalResolution_reversalRequestId_fkey"
      FOREIGN KEY ("reversalRequestId") REFERENCES "DuskLedgerReversalRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DuskLedgerReversalResolution_resolutionEntryId_fkey"
      FOREIGN KEY ("resolutionEntryId") REFERENCES "DuskLedgerEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "DuskLedgerEntry_walletId_idempotencyKey_key"
    ON "DuskLedgerEntry"("walletId", "idempotencyKey");
CREATE UNIQUE INDEX "DuskLedgerEntry_wallet_source_single_key"
    ON "DuskLedgerEntry"("walletId", "sourceEventType", "sourceEventId")
    WHERE "beneficiaryKey" IS NULL;
CREATE UNIQUE INDEX "DuskLedgerEntry_wallet_source_multi_key"
    ON "DuskLedgerEntry"("walletId", "sourceEventType", "sourceEventId", "beneficiaryKey")
    WHERE "beneficiaryKey" IS NOT NULL;
CREATE UNIQUE INDEX "DuskLedgerEntry_reversalOfId_key"
    ON "DuskLedgerEntry"("reversalOfId");
CREATE INDEX "DuskLedgerEntry_walletId_createdAt_idx"
    ON "DuskLedgerEntry"("walletId", "createdAt");
CREATE INDEX "DuskLedgerEntry_sourceEventType_sourceEventId_idx"
    ON "DuskLedgerEntry"("sourceEventType", "sourceEventId");
CREATE UNIQUE INDEX "DuskLedgerSourceEvent_sourceEventType_sourceEventId_key"
    ON "DuskLedgerSourceEvent"("sourceEventType", "sourceEventId");
CREATE UNIQUE INDEX "DuskLedgerSourceEventClaim_single_event_key"
    ON "DuskLedgerSourceEventClaim"("sourceEventId")
    WHERE "beneficiaryKey" IS NULL;
CREATE UNIQUE INDEX "DuskLedgerSourceEventClaim_multi_event_beneficiary_key"
    ON "DuskLedgerSourceEventClaim"("sourceEventId", "beneficiaryKey")
    WHERE "beneficiaryKey" IS NOT NULL;
CREATE UNIQUE INDEX "DuskLedgerSourceEventClaim_ledgerEntryId_key"
    ON "DuskLedgerSourceEventClaim"("ledgerEntryId");
CREATE INDEX "DuskLedgerSourceEventClaim_sourceEventId_beneficiaryKey_idx"
    ON "DuskLedgerSourceEventClaim"("sourceEventId", "beneficiaryKey");
CREATE INDEX "DuskLedgerSourceEventClaim_walletId_createdAt_idx"
    ON "DuskLedgerSourceEventClaim"("walletId", "createdAt");
CREATE UNIQUE INDEX "DuskLedgerReversalRequest_walletId_idempotencyKey_key"
    ON "DuskLedgerReversalRequest"("walletId", "idempotencyKey");
CREATE UNIQUE INDEX "DuskLedgerReversalRequest_sourceEventType_sourceEventId_key"
    ON "DuskLedgerReversalRequest"("sourceEventType", "sourceEventId");
CREATE UNIQUE INDEX "DuskLedgerReversalRequest_originalEntryId_key"
    ON "DuskLedgerReversalRequest"("originalEntryId");
CREATE INDEX "DuskLedgerReversalRequest_walletId_createdAt_idx"
    ON "DuskLedgerReversalRequest"("walletId", "createdAt");
CREATE UNIQUE INDEX "DuskLedgerReversalResolution_reversalRequestId_key"
    ON "DuskLedgerReversalResolution"("reversalRequestId");
CREATE UNIQUE INDEX "DuskLedgerReversalResolution_resolutionEntryId_key"
    ON "DuskLedgerReversalResolution"("resolutionEntryId");
CREATE UNIQUE INDEX "DuskRewardPolicyVersion_policyKey_version_key"
    ON "DuskRewardPolicyVersion"("policyKey", "version");
CREATE INDEX "DuskRewardPolicyVersion_policyKey_createdAt_idx"
    ON "DuskRewardPolicyVersion"("policyKey", "createdAt");
CREATE INDEX "DuskWallet_updatedAt_idx" ON "DuskWallet"("updatedAt");

CREATE OR REPLACE FUNCTION "dusk_ledger_entry_immutable"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Dusk ledger entries are append-only';
END;
$$;

CREATE TRIGGER "DuskLedgerEntry_immutable"
BEFORE UPDATE OR DELETE ON "DuskLedgerEntry"
FOR EACH ROW EXECUTE FUNCTION "dusk_ledger_entry_immutable"();

CREATE OR REPLACE FUNCTION "dusk_policy_version_immutable"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Dusk policy versions are append-only';
END;
$$;

CREATE TRIGGER "DuskRewardPolicyVersion_immutable"
BEFORE UPDATE OR DELETE ON "DuskRewardPolicyVersion"
FOR EACH ROW EXECUTE FUNCTION "dusk_policy_version_immutable"();

CREATE OR REPLACE FUNCTION "dusk_source_event_immutable"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Dusk source event claims are append-only';
END;
$$;

CREATE TRIGGER "DuskLedgerSourceEvent_immutable"
BEFORE UPDATE OR DELETE ON "DuskLedgerSourceEvent"
FOR EACH ROW EXECUTE FUNCTION "dusk_source_event_immutable"();

CREATE TRIGGER "DuskLedgerSourceEventClaim_immutable"
BEFORE UPDATE OR DELETE ON "DuskLedgerSourceEventClaim"
FOR EACH ROW EXECUTE FUNCTION "dusk_source_event_immutable"();

CREATE TRIGGER "DuskLedgerReversalRequest_immutable"
BEFORE UPDATE OR DELETE ON "DuskLedgerReversalRequest"
FOR EACH ROW EXECUTE FUNCTION "dusk_source_event_immutable"();

CREATE TRIGGER "DuskLedgerReversalResolution_immutable"
BEFORE UPDATE OR DELETE ON "DuskLedgerReversalResolution"
FOR EACH ROW EXECUTE FUNCTION "dusk_source_event_immutable"();
