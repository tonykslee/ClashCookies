CREATE TYPE "DuskLedgerTransactionType" AS ENUM ('EARNING', 'SPEND', 'CORRECTION', 'REVERSAL');

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

CREATE UNIQUE INDEX "DuskLedgerEntry_walletId_idempotencyKey_key"
    ON "DuskLedgerEntry"("walletId", "idempotencyKey");
CREATE UNIQUE INDEX "DuskLedgerEntry_walletId_sourceEventType_sourceEventId_key"
    ON "DuskLedgerEntry"("walletId", "sourceEventType", "sourceEventId");
CREATE UNIQUE INDEX "DuskLedgerEntry_reversalOfId_key"
    ON "DuskLedgerEntry"("reversalOfId");
CREATE INDEX "DuskLedgerEntry_walletId_createdAt_idx"
    ON "DuskLedgerEntry"("walletId", "createdAt");
CREATE INDEX "DuskLedgerEntry_sourceEventType_sourceEventId_idx"
    ON "DuskLedgerEntry"("sourceEventType", "sourceEventId");
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
