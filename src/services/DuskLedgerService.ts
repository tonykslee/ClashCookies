import { DuskLedgerEntry, DuskLedgerTransactionType, Prisma } from "@prisma/client";

import { prisma } from "../prisma";

const MAX_DUSKIT_AMOUNT = 2_147_483_647;
const SERIALIZABLE_RETRY_LIMIT = 3;

export type DuskLedgerAttribution = Prisma.InputJsonValue;

type CommonLedgerInput = {
  discordUserId: string;
  sourceEventType: string;
  sourceEventId: string;
  idempotencyKey: string;
  reason: string;
  actorDiscordUserId?: string | null;
  attribution?: DuskLedgerAttribution | null;
  policyVersion?: string | null;
};

export type DuskEarningInput = CommonLedgerInput & {
  amount: number;
};

export type DuskSpendInput = CommonLedgerInput & {
  amount: number;
};

export type DuskCorrectionInput = CommonLedgerInput & {
  amount: number;
};

export type DuskReversalInput = CommonLedgerInput & {
  originalEntryId: string;
};

export type DuskLedgerMutationResult = {
  entry: DuskLedgerEntry;
  balance: number;
  duplicate: boolean;
};

export class DuskLedgerValidationError extends Error {
  readonly code = "DUSK_LEDGER_VALIDATION";
}

export class DuskInsufficientBalanceError extends Error {
  readonly code = "DUSK_INSUFFICIENT_BALANCE";
}

export class DuskLedgerIdempotencyConflictError extends Error {
  readonly code = "DUSK_LEDGER_IDEMPOTENCY_CONFLICT";
}

export class DuskLedgerAlreadyReversedError extends Error {
  readonly code = "DUSK_LEDGER_ALREADY_REVERSED";
}

type NormalizedLedgerInput = CommonLedgerInput & {
  amount: number;
  transactionType: DuskLedgerTransactionType;
  reversalOfId?: string | null;
};

type DuskLedgerTransaction = Prisma.TransactionClient;

function normalizeRequiredString(value: string, fieldName: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new DuskLedgerValidationError(`${fieldName} must be non-empty and at most ${maxLength} characters.`);
  }
  return normalized;
}

function normalizeDiscordUserId(value: string): string {
  return normalizeRequiredString(value, "discordUserId", 64);
}

function normalizeAmount(value: number, allowNegative: boolean): number {
  if (!Number.isSafeInteger(value) || value === 0 || Math.abs(value) > MAX_DUSKIT_AMOUNT) {
    throw new DuskLedgerValidationError("amount must be a non-zero safe integer within the database integer range.");
  }
  if (!allowNegative && value < 0) {
    throw new DuskLedgerValidationError("amount must be positive for this operation.");
  }
  return value;
}

function normalizeCommonInput(input: CommonLedgerInput): CommonLedgerInput {
  const policyVersion = input.policyVersion?.trim() || null;
  if (policyVersion && policyVersion.length > 64) {
    throw new DuskLedgerValidationError("policyVersion must be at most 64 characters.");
  }
  return {
    discordUserId: normalizeDiscordUserId(input.discordUserId),
    sourceEventType: normalizeRequiredString(input.sourceEventType, "sourceEventType", 64),
    sourceEventId: normalizeRequiredString(input.sourceEventId, "sourceEventId", 128),
    idempotencyKey: normalizeRequiredString(input.idempotencyKey, "idempotencyKey", 128),
    reason: normalizeRequiredString(input.reason, "reason", 500),
    actorDiscordUserId: input.actorDiscordUserId?.trim() || null,
    attribution: input.attribution ?? null,
    policyVersion,
  };
}

function isPrismaErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function assertSameIdempotentRequest(
  existing: DuskLedgerEntry,
  requested: NormalizedLedgerInput,
): void {
  if (
    existing.amount !== requested.amount ||
    existing.transactionType !== requested.transactionType ||
    existing.sourceEventType !== requested.sourceEventType ||
    existing.sourceEventId !== requested.sourceEventId ||
    existing.reversalOfId !== (requested.reversalOfId ?? null)
  ) {
    throw new DuskLedgerIdempotencyConflictError(
      `Idempotency key ${requested.idempotencyKey} was already used for a different ledger operation.`,
    );
  }
}

/** Purpose: provide the transaction-safe persistence primitive for the Dusk wallet foundation. */
export class DuskLedgerService {
  /** Purpose: create a zero-balance wallet without creating a ledger entry. */
  async ensureWallet(discordUserId: string): Promise<{ discordUserId: string; balance: number }> {
    const walletId = normalizeDiscordUserId(discordUserId);
    const wallet = await prisma.duskWallet.upsert({
      where: { discordUserId: walletId },
      create: { discordUserId: walletId },
      update: {},
    });
    return { discordUserId: wallet.discordUserId, balance: wallet.balance };
  }

  /** Purpose: append a positive earning entry; no reward source calls this in M1a. */
  async recordEarning(input: DuskEarningInput): Promise<DuskLedgerMutationResult> {
    const common = normalizeCommonInput(input);
    return this.appendSignedEntry({
      ...common,
      amount: normalizeAmount(input.amount, false),
      transactionType: DuskLedgerTransactionType.EARNING,
    });
  }

  /** Purpose: append a negative spend entry while atomically enforcing sufficient balance. */
  async spend(input: DuskSpendInput): Promise<DuskLedgerMutationResult> {
    const common = normalizeCommonInput(input);
    return this.appendSignedEntry({
      ...common,
      amount: -normalizeAmount(input.amount, false),
      transactionType: DuskLedgerTransactionType.SPEND,
    });
  }

  /** Purpose: append an explicitly attributed signed correction for a future authorized admin path. */
  async recordCorrection(input: DuskCorrectionInput): Promise<DuskLedgerMutationResult> {
    const common = normalizeCommonInput(input);
    if (!common.actorDiscordUserId) {
      throw new DuskLedgerValidationError("actorDiscordUserId is required for corrections.");
    }
    return this.appendSignedEntry({
      ...common,
      amount: normalizeAmount(input.amount, true),
      transactionType: DuskLedgerTransactionType.CORRECTION,
    });
  }

  /** Purpose: append one compensating entry for an original entry without deleting or editing history. */
  async reverse(input: DuskReversalInput): Promise<DuskLedgerMutationResult> {
    const common = normalizeCommonInput(input);
    if (!common.actorDiscordUserId) {
      throw new DuskLedgerValidationError("actorDiscordUserId is required for reversals.");
    }
    const originalEntryId = normalizeRequiredString(input.originalEntryId, "originalEntryId", 64);
    const walletId = common.discordUserId;

    return this.runSerializable(async (tx) => {
      const existing = await tx.duskLedgerEntry.findUnique({
        where: { walletId_idempotencyKey: { walletId, idempotencyKey: common.idempotencyKey } },
      });
      if (existing) {
        assertSameIdempotentRequest(
          existing,
          {
            ...common,
            amount: existing.amount,
            transactionType: DuskLedgerTransactionType.REVERSAL,
            reversalOfId: originalEntryId,
          },
        );
        return this.buildMutationResult(tx, existing, true);
      }

      const original = await tx.duskLedgerEntry.findUnique({ where: { id: originalEntryId } });
      if (!original || original.walletId !== walletId) {
        throw new DuskLedgerValidationError("The original ledger entry does not belong to this wallet.");
      }
      if (original.transactionType === DuskLedgerTransactionType.REVERSAL) {
        throw new DuskLedgerValidationError("A reversal cannot itself be reversed.");
      }

      const priorReversal = await tx.duskLedgerEntry.findUnique({
        where: { reversalOfId: original.id },
      });
      if (priorReversal) {
        throw new DuskLedgerAlreadyReversedError("The original ledger entry already has a reversal.");
      }

      return this.appendInTransaction(tx, {
        ...common,
        amount: -original.amount,
        transactionType: DuskLedgerTransactionType.REVERSAL,
        reversalOfId: original.id,
      });
    });
  }

  /** Purpose: read the projected balance owned by the wallet, without consulting PlayerLink. */
  async getBalance(discordUserId: string): Promise<number> {
    const wallet = await prisma.duskWallet.findUnique({
      where: { discordUserId: normalizeDiscordUserId(discordUserId) },
      select: { balance: true },
    });
    return wallet?.balance ?? 0;
  }

  /** Purpose: expose append-only history for a later member/admin read surface. */
  async listEntries(discordUserId: string, take = 100): Promise<DuskLedgerEntry[]> {
    const normalizedTake = Math.min(Math.max(Math.trunc(take), 1), 500);
    return prisma.duskLedgerEntry.findMany({
      where: { walletId: normalizeDiscordUserId(discordUserId) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: normalizedTake,
    });
  }

  private async appendSignedEntry(input: NormalizedLedgerInput): Promise<DuskLedgerMutationResult> {
    try {
      return await this.runSerializable((tx) => this.appendInTransaction(tx, input));
    } catch (error) {
      if (!isPrismaErrorCode(error, "P2002")) throw error;
      const existing = await prisma.duskLedgerEntry.findUnique({
        where: {
          walletId_idempotencyKey: {
            walletId: input.discordUserId,
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (!existing) {
        const sourceExisting = await prisma.duskLedgerEntry.findUnique({
          where: {
            walletId_sourceEventType_sourceEventId: {
              walletId: input.discordUserId,
              sourceEventType: input.sourceEventType,
              sourceEventId: input.sourceEventId,
            },
          },
        });
        if (sourceExisting) {
          throw new DuskLedgerIdempotencyConflictError(
            `Source event ${input.sourceEventType}:${input.sourceEventId} was already recorded with another idempotency key.`,
          );
        }
        throw error;
      }
      assertSameIdempotentRequest(existing, input);
      return {
        entry: existing,
        balance: await this.getBalance(input.discordUserId),
        duplicate: true,
      };
    }
  }

  private async appendInTransaction(
    tx: DuskLedgerTransaction,
    input: NormalizedLedgerInput,
  ): Promise<DuskLedgerMutationResult> {
    const existing = await tx.duskLedgerEntry.findUnique({
      where: { walletId_idempotencyKey: { walletId: input.discordUserId, idempotencyKey: input.idempotencyKey } },
    });
    if (existing) {
      assertSameIdempotentRequest(existing, input);
      return this.buildMutationResult(tx, existing, true);
    }

    await tx.duskWallet.upsert({
      where: { discordUserId: input.discordUserId },
      create: { discordUserId: input.discordUserId },
      update: {},
    });

    if (input.amount < 0) {
      const debit = await tx.duskWallet.updateMany({
        where: { discordUserId: input.discordUserId, balance: { gte: -input.amount } },
        data: { balance: { decrement: -input.amount } },
      });
      if (debit.count !== 1) {
        throw new DuskInsufficientBalanceError("The wallet does not have enough Duskits for this operation.");
      }
    } else {
      await tx.duskWallet.update({
        where: { discordUserId: input.discordUserId },
        data: { balance: { increment: input.amount } },
      });
    }

    const entry = await tx.duskLedgerEntry.create({
      data: {
        walletId: input.discordUserId,
        amount: input.amount,
        transactionType: input.transactionType,
        sourceEventType: input.sourceEventType,
        sourceEventId: input.sourceEventId,
        idempotencyKey: input.idempotencyKey,
        attribution: input.attribution ?? undefined,
        policyVersion: input.policyVersion ?? undefined,
        reason: input.reason,
        actorDiscordUserId: input.actorDiscordUserId ?? undefined,
        reversalOfId: input.reversalOfId ?? undefined,
      },
    });
    return this.buildMutationResult(tx, entry, false);
  }

  private async buildMutationResult(
    tx: DuskLedgerTransaction,
    entry: DuskLedgerEntry,
    duplicate: boolean,
  ): Promise<DuskLedgerMutationResult> {
    const wallet = await tx.duskWallet.findUnique({
      where: { discordUserId: entry.walletId },
      select: { balance: true },
    });
    if (!wallet) throw new Error("Dusk wallet disappeared while reading the ledger result.");
    return { entry, balance: wallet.balance, duplicate };
  }

  private async runSerializable<T>(work: (tx: DuskLedgerTransaction) => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= SERIALIZABLE_RETRY_LIMIT; attempt += 1) {
      try {
        return await prisma.$transaction(work, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (!isPrismaErrorCode(error, "P2034") || attempt === SERIALIZABLE_RETRY_LIMIT) {
          throw error;
        }
      }
    }
    throw new Error("Unreachable serializable transaction retry state.");
  }
}

export const duskLedgerService = new DuskLedgerService();
