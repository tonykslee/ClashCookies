import {
  DuskLedgerBeneficiaryMode,
  DuskLedgerEntry,
  DuskLedgerReversalRequest,
  DuskLedgerTransactionType,
  Prisma,
} from "@prisma/client";

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
  beneficiaryMode?: DuskLedgerBeneficiaryMode;
  beneficiaryKey?: string | null;
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

export type DuskLedgerAppliedResult = {
  outcome: "applied";
  entry: DuskLedgerEntry;
  balance: number;
  duplicate: boolean;
};

export type DuskLedgerPendingReversalResult = {
  outcome: "pending_review";
  reversalRequest: DuskLedgerReversalRequest;
  balance: number;
  duplicate: boolean;
};

export type DuskLedgerMutationResult = DuskLedgerAppliedResult | DuskLedgerPendingReversalResult;

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

export class DuskLedgerEventAlreadyClaimedError extends Error {
  readonly code = "DUSK_LEDGER_EVENT_ALREADY_CLAIMED";
}

export class DuskLedgerReversalPendingError extends Error {
  readonly code = "DUSK_LEDGER_REVERSAL_PENDING";
}

type NormalizedLedgerInput = CommonLedgerInput & {
  amount: number;
  transactionType: DuskLedgerTransactionType;
  beneficiaryMode?: DuskLedgerBeneficiaryMode | null;
  beneficiaryKey?: string | null;
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

function normalizeActorDiscordUserId(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  return normalizeRequiredString(value, "actorDiscordUserId", 64);
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
    actorDiscordUserId: normalizeActorDiscordUserId(input.actorDiscordUserId),
    attribution: input.attribution ?? null,
    policyVersion,
  };
}

function normalizeBeneficiary(input: DuskEarningInput): {
  beneficiaryMode: DuskLedgerBeneficiaryMode;
  beneficiaryKey: string | null;
} {
  const beneficiaryMode = input.beneficiaryMode ?? DuskLedgerBeneficiaryMode.SINGLE_RECIPIENT;
  const beneficiaryKey = input.beneficiaryKey?.trim() || null;
  if (beneficiaryMode === DuskLedgerBeneficiaryMode.SINGLE_RECIPIENT && beneficiaryKey) {
    throw new DuskLedgerValidationError("Single-recipient earning events cannot include a beneficiaryKey.");
  }
  if (beneficiaryMode === DuskLedgerBeneficiaryMode.MULTI_BENEFICIARY && !beneficiaryKey) {
    throw new DuskLedgerValidationError("Multi-beneficiary earning events require a beneficiaryKey.");
  }
  if (beneficiaryKey && beneficiaryKey.length > 128) {
    throw new DuskLedgerValidationError("beneficiaryKey must be at most 128 characters.");
  }
  return { beneficiaryMode, beneficiaryKey };
}

function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalizeJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalizeJson(entry)}`)
    .join(",")}}`;
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
    existing.beneficiaryMode !== (requested.beneficiaryMode ?? null) ||
    existing.beneficiaryKey !== (requested.beneficiaryKey ?? null) ||
    existing.sourceEventType !== requested.sourceEventType ||
    existing.sourceEventId !== requested.sourceEventId ||
    existing.reversalOfId !== (requested.reversalOfId ?? null) ||
    existing.policyVersion !== (requested.policyVersion ?? null) ||
    existing.actorDiscordUserId !== (requested.actorDiscordUserId ?? null) ||
    existing.reason !== requested.reason ||
    canonicalizeJson(existing.attribution) !== canonicalizeJson(requested.attribution)
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
    let wallet = await prisma.duskWallet.findUnique({ where: { discordUserId: walletId } });
    if (wallet) return { discordUserId: wallet.discordUserId, balance: wallet.balance };
    try {
      wallet = await prisma.duskWallet.create({ data: { discordUserId: walletId } });
    } catch (error) {
      if (!isPrismaErrorCode(error, "P2002")) throw error;
      wallet = await prisma.duskWallet.findUnique({ where: { discordUserId: walletId } });
      if (!wallet) throw error;
    }
    return { discordUserId: wallet.discordUserId, balance: wallet.balance };
  }

  /** Purpose: append a positive earning entry; no reward source calls this in M1a. */
  async recordEarning(input: DuskEarningInput): Promise<DuskLedgerMutationResult> {
    const common = normalizeCommonInput(input);
    const beneficiary = normalizeBeneficiary(input);
    return this.appendSignedEntry({
      ...common,
      amount: normalizeAmount(input.amount, false),
      transactionType: DuskLedgerTransactionType.EARNING,
      ...beneficiary,
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

    try {
      return await this.runSerializable(async (tx) => {
        const existing = await tx.duskLedgerEntry.findUnique({
          where: { walletId_idempotencyKey: { walletId, idempotencyKey: common.idempotencyKey } },
        });
        if (existing) {
          assertSameIdempotentRequest(existing, {
            ...common,
            amount: existing.amount,
            transactionType: DuskLedgerTransactionType.REVERSAL,
            reversalOfId: originalEntryId,
          });
          return this.buildMutationResult(tx, existing, true);
        }

        const pendingByKey = await tx.duskLedgerReversalRequest.findUnique({
          where: { walletId_idempotencyKey: { walletId, idempotencyKey: common.idempotencyKey } },
        });
        if (pendingByKey) {
          assertSamePendingReversalRequest(pendingByKey, common, originalEntryId);
          return this.buildPendingReversalResult(tx, pendingByKey, true);
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
        const pendingForOriginal = await tx.duskLedgerReversalRequest.findUnique({
          where: { originalEntryId: original.id },
        });
        if (pendingForOriginal) {
          throw new DuskLedgerReversalPendingError(
            "The original ledger entry already has a pending reversal review.",
          );
        }

        try {
          return await this.appendInTransaction(tx, {
            ...common,
            amount: -original.amount,
            transactionType: DuskLedgerTransactionType.REVERSAL,
            reversalOfId: original.id,
          });
        } catch (error) {
          if (!(error instanceof DuskInsufficientBalanceError)) throw error;
          const reversalRequest = await tx.duskLedgerReversalRequest.create({
            data: {
              walletId,
              originalEntryId: original.id,
              requestedAmount: -original.amount,
              sourceEventType: common.sourceEventType,
              sourceEventId: common.sourceEventId,
              idempotencyKey: common.idempotencyKey,
              attribution: common.attribution ?? undefined,
              policyVersion: common.policyVersion ?? undefined,
              reason: common.reason,
              actorDiscordUserId: common.actorDiscordUserId!,
            },
          });
          return this.buildPendingReversalResult(tx, reversalRequest, false);
        }
      });
    } catch (error) {
      if (!isPrismaErrorCode(error, "P2002")) throw error;
      return this.recoverReversalConflict({ common, originalEntryId, walletId, error });
    }
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

  /** Purpose: expose unresolved reversal requests for a future audited M1b review surface. */
  async listPendingReversals(discordUserId: string, take = 100): Promise<DuskLedgerReversalRequest[]> {
    const normalizedTake = Math.min(Math.max(Math.trunc(take), 1), 500);
    return prisma.duskLedgerReversalRequest.findMany({
      where: { walletId: normalizeDiscordUserId(discordUserId), resolution: null },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
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
        if (input.transactionType === DuskLedgerTransactionType.EARNING) {
          const sourceEvent = await prisma.duskLedgerSourceEvent.findUnique({
            where: {
              sourceEventType_sourceEventId: {
                sourceEventType: input.sourceEventType,
                sourceEventId: input.sourceEventId,
              },
            },
          });
          if (sourceEvent) {
            const matchingClaim = await prisma.duskLedgerSourceEventClaim.findFirst({
              where: {
                sourceEventId: sourceEvent.id,
                beneficiaryKey: input.beneficiaryKey ?? null,
              },
            });
            const singleRecipientClaim =
              input.beneficiaryMode === DuskLedgerBeneficiaryMode.SINGLE_RECIPIENT
                ? await prisma.duskLedgerSourceEventClaim.findFirst({
                    where: { sourceEventId: sourceEvent.id },
                  })
                : null;
            if (sourceEvent.beneficiaryMode !== input.beneficiaryMode || matchingClaim || singleRecipientClaim) {
              throw new DuskLedgerEventAlreadyClaimedError(
                `Source event ${input.sourceEventType}:${input.sourceEventId} was already claimed.`,
              );
            }
          }
        }
        const sourceExisting = await prisma.duskLedgerEntry.findFirst({
          where: {
            walletId: input.discordUserId,
            sourceEventType: input.sourceEventType,
            sourceEventId: input.sourceEventId,
            beneficiaryKey: input.beneficiaryKey ?? null,
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
        outcome: "applied",
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

    let sourceEventId: string | null = null;
    if (input.transactionType === DuskLedgerTransactionType.EARNING) {
      sourceEventId = await this.ensureEarningSourceEvent(tx, input);
    }

    await this.createWalletIfAbsent(tx, input.discordUserId);

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
        beneficiaryMode: input.beneficiaryMode ?? undefined,
        beneficiaryKey: input.beneficiaryKey ?? undefined,
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
    if (sourceEventId) {
      await tx.duskLedgerSourceEventClaim.create({
        data: {
          sourceEventId,
          beneficiaryKey: input.beneficiaryKey ?? undefined,
          walletId: input.discordUserId,
          ledgerEntryId: entry.id,
        },
      });
    }
    return this.buildMutationResult(tx, entry, false);
  }

  private async ensureEarningSourceEvent(
    tx: DuskLedgerTransaction,
    input: NormalizedLedgerInput,
  ): Promise<string> {
    if (!input.beneficiaryMode) {
      throw new DuskLedgerValidationError("Earning entries require beneficiary semantics.");
    }
    const sourceEventKey = {
      sourceEventType: input.sourceEventType,
      sourceEventId: input.sourceEventId,
    };
    let sourceEvent = await tx.duskLedgerSourceEvent.findUnique({
      where: { sourceEventType_sourceEventId: sourceEventKey },
    });
    if (!sourceEvent) {
      sourceEvent = await tx.duskLedgerSourceEvent.create({
        data: {
          ...sourceEventKey,
          beneficiaryMode: input.beneficiaryMode,
        },
      });
    }
    if (sourceEvent.beneficiaryMode !== input.beneficiaryMode) {
      throw new DuskLedgerEventAlreadyClaimedError(
        `Source event ${input.sourceEventType}:${input.sourceEventId} has different beneficiary semantics.`,
      );
    }

    const existingClaim = await tx.duskLedgerSourceEventClaim.findFirst({
      where: {
        sourceEventId: sourceEvent.id,
        beneficiaryKey: input.beneficiaryKey ?? null,
      },
    });
    if (existingClaim) {
      throw new DuskLedgerEventAlreadyClaimedError(
        `Source event ${input.sourceEventType}:${input.sourceEventId} is already claimed for this beneficiary.`,
      );
    }
    if (input.beneficiaryMode === DuskLedgerBeneficiaryMode.SINGLE_RECIPIENT) {
      const anyClaim = await tx.duskLedgerSourceEventClaim.findFirst({
        where: { sourceEventId: sourceEvent.id },
      });
      if (anyClaim) {
        throw new DuskLedgerEventAlreadyClaimedError(
          `Single-recipient source event ${input.sourceEventType}:${input.sourceEventId} is already claimed.`,
        );
      }
    }
    return sourceEvent.id;
  }

  private async createWalletIfAbsent(tx: DuskLedgerTransaction, walletId: string): Promise<void> {
    const existing = await tx.duskWallet.findUnique({ where: { discordUserId: walletId } });
    if (existing) return;
    await tx.duskWallet.create({ data: { discordUserId: walletId } });
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
    return { outcome: "applied", entry, balance: wallet.balance, duplicate };
  }

  private async buildPendingReversalResult(
    tx: DuskLedgerTransaction,
    reversalRequest: DuskLedgerReversalRequest,
    duplicate: boolean,
  ): Promise<DuskLedgerPendingReversalResult> {
    const wallet = await tx.duskWallet.findUnique({
      where: { discordUserId: reversalRequest.walletId },
      select: { balance: true },
    });
    if (!wallet) throw new Error("Dusk wallet disappeared while reading the pending reversal result.");
    return { outcome: "pending_review", reversalRequest, balance: wallet.balance, duplicate };
  }

  private async recoverReversalConflict({
    common,
    originalEntryId,
    walletId,
    error,
  }: {
    common: CommonLedgerInput;
    originalEntryId: string;
    walletId: string;
    error: unknown;
  }): Promise<DuskLedgerMutationResult> {
    const existing = await prisma.duskLedgerEntry.findUnique({
      where: { walletId_idempotencyKey: { walletId, idempotencyKey: common.idempotencyKey } },
    });
    if (existing) {
      assertSameIdempotentRequest(existing, {
        ...common,
        amount: existing.amount,
        transactionType: DuskLedgerTransactionType.REVERSAL,
        reversalOfId: originalEntryId,
      });
      return this.buildMutationResult(prisma, existing, true);
    }

    const pendingByKey = await prisma.duskLedgerReversalRequest.findUnique({
      where: { walletId_idempotencyKey: { walletId, idempotencyKey: common.idempotencyKey } },
    });
    if (pendingByKey) {
      assertSamePendingReversalRequest(pendingByKey, common, originalEntryId);
      return this.buildPendingReversalResult(prisma, pendingByKey, true);
    }

    const entryWithSource = await prisma.duskLedgerEntry.findFirst({
      where: {
        walletId,
        sourceEventType: common.sourceEventType,
        sourceEventId: common.sourceEventId,
        beneficiaryKey: null,
      },
    });
    if (entryWithSource) {
      throw new DuskLedgerIdempotencyConflictError(
        `Source event ${common.sourceEventType}:${common.sourceEventId} was already used for another ledger entry.`,
      );
    }

    const requestWithSource = await prisma.duskLedgerReversalRequest.findUnique({
      where: {
        sourceEventType_sourceEventId: {
          sourceEventType: common.sourceEventType,
          sourceEventId: common.sourceEventId,
        },
      },
    });
    if (requestWithSource) {
      throw new DuskLedgerIdempotencyConflictError(
        `Source event ${common.sourceEventType}:${common.sourceEventId} was already used for another reversal.`,
      );
    }

    const priorReversal = await prisma.duskLedgerEntry.findUnique({ where: { reversalOfId: originalEntryId } });
    if (priorReversal) {
      throw new DuskLedgerAlreadyReversedError("The original ledger entry already has a reversal.");
    }
    const pendingForOriginal = await prisma.duskLedgerReversalRequest.findUnique({
      where: { originalEntryId },
    });
    if (pendingForOriginal) {
      throw new DuskLedgerReversalPendingError(
        "The original ledger entry already has a pending reversal review.",
      );
    }
    throw error;
  }

  private async runSerializable<T>(work: (tx: DuskLedgerTransaction) => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= SERIALIZABLE_RETRY_LIMIT; attempt += 1) {
      try {
        return await prisma.$transaction(work, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (!(isPrismaErrorCode(error, "P2034") || isPrismaErrorCode(error, "P2002")) || attempt === SERIALIZABLE_RETRY_LIMIT) {
          throw error;
        }
      }
    }
    throw new Error("Unreachable serializable transaction retry state.");
  }
}

function assertSamePendingReversalRequest(
  existing: DuskLedgerReversalRequest,
  requested: CommonLedgerInput,
  originalEntryId: string,
): void {
  if (
    existing.originalEntryId !== originalEntryId ||
    existing.sourceEventType !== requested.sourceEventType ||
    existing.sourceEventId !== requested.sourceEventId ||
    existing.policyVersion !== (requested.policyVersion ?? null) ||
    existing.actorDiscordUserId !== requested.actorDiscordUserId ||
    existing.reason !== requested.reason ||
    canonicalizeJson(existing.attribution) !== canonicalizeJson(requested.attribution)
  ) {
    throw new DuskLedgerIdempotencyConflictError(
      `Idempotency key ${requested.idempotencyKey} was already used for a different reversal request.`,
    );
  }
}

export const duskLedgerService = new DuskLedgerService();
