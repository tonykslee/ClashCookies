import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

const txMock = vi.hoisted(() => ({
  duskWallet: {
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    findUnique: vi.fn(),
  },
  duskLedgerEntry: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    findMany: vi.fn(),
  },
  duskLedgerSourceEvent: {
    create: vi.fn(),
    findUnique: vi.fn(),
  },
  duskLedgerSourceEventClaim: {
    findFirst: vi.fn(),
    create: vi.fn(),
  },
  duskLedgerReversalRequest: {
    findUnique: vi.fn(),
    create: vi.fn(),
    findMany: vi.fn(),
  },
  repWorkActivityEvent: {
    findUnique: vi.fn(),
  },
}));

const prismaMock = vi.hoisted(() => ({
  duskWallet: {
    create: vi.fn(),
    findUnique: vi.fn(),
  },
  duskLedgerEntry: {
    aggregate: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
  },
  duskLedgerSourceEvent: {
    findUnique: vi.fn(),
  },
  duskLedgerSourceEventClaim: {
    findFirst: vi.fn(),
  },
  duskLedgerReversalRequest: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
  },
  repWorkActivityEvent: {
    findUnique: vi.fn(),
  },
  $transaction: vi.fn(),
}));

vi.mock("../src/prisma", () => ({ prisma: prismaMock }));

import {
  DuskInsufficientBalanceError,
  DuskLedgerAlreadyReversedError,
  DuskLedgerEventAlreadyClaimedError,
  DuskLedgerIdempotencyConflictError,
  DuskLedgerService,
  DuskLedgerValidationError,
} from "../src/services/DuskLedgerService";
import { DuskReversalResolutionType } from "@prisma/client";

const baseInput = {
  discordUserId: "discord-1",
  sourceEventType: "test",
  sourceEventId: "event-1",
  idempotencyKey: "request-1",
  policyVersion: null,
  actorDiscordUserId: null,
  attribution: null,
  reason: "focused test",
};

function makeEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "entry-1",
    walletId: "discord-1",
    amount: 10,
    transactionType: "EARNING",
    beneficiaryMode: "SINGLE_RECIPIENT",
    beneficiaryKey: null,
    sourceEventType: "test",
    sourceEventId: "event-1",
    idempotencyKey: "request-1",
    attribution: null,
    policyVersion: null,
    reason: "focused test",
    actorDiscordUserId: null,
    reversalOfId: null,
    createdAt: new Date("2026-11-12T20:00:00.000Z"),
    ...overrides,
  };
}

function configureSuccessfulTransaction() {
  prismaMock.$transaction.mockImplementation(async (work: (tx: typeof txMock) => Promise<unknown>) => work(txMock));
  txMock.duskWallet.create.mockImplementation(async ({ data }: { data: { discordUserId: string } }) => ({
    discordUserId: data.discordUserId,
    balance: 0,
  }));
  txMock.duskWallet.update.mockResolvedValue({ discordUserId: "discord-1", balance: 10 });
  txMock.duskWallet.updateMany.mockResolvedValue({ count: 1 });
  txMock.duskWallet.findUnique.mockImplementation(async ({ select }: { select?: unknown }) =>
    select ? { balance: 10 } : null,
  );
  txMock.duskLedgerEntry.findUnique.mockResolvedValue(null);
  txMock.duskLedgerEntry.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
    makeEntry(data),
  );
  txMock.duskLedgerSourceEvent.create.mockImplementation(
    async ({ data }: { data: { beneficiaryMode: string } }) => ({
      id: "source-1",
      beneficiaryMode: data.beneficiaryMode,
    }),
  );
  txMock.duskLedgerSourceEvent.findUnique.mockResolvedValue(null);
  txMock.duskLedgerSourceEventClaim.findFirst.mockResolvedValue(null);
  txMock.duskLedgerSourceEventClaim.create.mockResolvedValue({ id: "claim-1" });
  txMock.duskLedgerReversalRequest.findUnique.mockResolvedValue(null);
  txMock.duskLedgerReversalRequest.create.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => ({ id: "pending-1", createdAt: new Date(), ...data }),
  );
}

describe("DuskLedgerService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configureSuccessfulTransaction();
    prismaMock.duskWallet.create.mockImplementation(async ({ data }: { data: { discordUserId: string } }) => ({
      discordUserId: data.discordUserId,
      balance: 0,
    }));
    prismaMock.duskWallet.findUnique.mockImplementation(async ({ select }: { select?: unknown }) =>
      select ? { balance: 0 } : null,
    );
    prismaMock.duskLedgerEntry.findUnique.mockResolvedValue(null);
    prismaMock.duskLedgerEntry.findFirst.mockResolvedValue(null);
    prismaMock.duskLedgerEntry.aggregate.mockResolvedValue({ _sum: { amount: null } });
    prismaMock.duskLedgerSourceEvent.findUnique.mockResolvedValue(null);
    prismaMock.duskLedgerSourceEventClaim.findFirst.mockResolvedValue(null);
    prismaMock.duskLedgerReversalRequest.findUnique.mockResolvedValue(null);
    prismaMock.duskLedgerEntry.findMany.mockResolvedValue([]);
    prismaMock.duskLedgerReversalRequest.findMany.mockResolvedValue([]);
    prismaMock.repWorkActivityEvent.findUnique.mockResolvedValue(null);
  });

  it("creates a zero-balance wallet keyed only by Discord identity", async () => {
    const service = new DuskLedgerService();

    await expect(service.ensureWallet(" discord-1 ")).resolves.toEqual({
      discordUserId: "discord-1",
      balance: 0,
    });
    expect(prismaMock.duskWallet.create).toHaveBeenCalledWith({
      data: { discordUserId: "discord-1" },
    });
    expect(JSON.stringify(prismaMock.duskWallet.create.mock.calls[0])).not.toContain("playerTag");
  });

  it("returns zero lifetime earnings for an uninitialized wallet without creating it", async () => {
    const service = new DuskLedgerService();

    await expect(service.getBalance("discord-uninitialized")).resolves.toBe(0);
    await expect(service.getLifetimeEarned("discord-uninitialized")).resolves.toBe(0);

    expect(prismaMock.duskWallet.create).not.toHaveBeenCalled();
    expect(prismaMock.duskLedgerEntry.aggregate).toHaveBeenCalledWith({
      where: {
        walletId: "discord-uninitialized",
        transactionType: "EARNING",
        amount: { gt: 0 },
        reversals: { none: {} },
        reversalRequests: {
          none: {
            OR: [
              { resolution: { is: null } },
              { resolution: { is: { resolutionType: DuskReversalResolutionType.APPLIED } } },
            ],
          },
        },
      },
      _sum: { amount: true },
    });
  });

  it("excludes an earning with a pending reversal request from lifetime earned", async () => {
    prismaMock.duskLedgerEntry.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
    const service = new DuskLedgerService();

    await expect(service.getLifetimeEarned("discord-1")).resolves.toBe(0);
    expect(prismaMock.duskLedgerEntry.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          reversalRequests: {
            none: {
              OR: [
                { resolution: { is: null } },
                { resolution: { is: { resolutionType: DuskReversalResolutionType.APPLIED } } },
              ],
            },
          },
        }),
      }),
    );
  });

  it("keeps a legitimate earning with a declined reversal request in lifetime earned", async () => {
    prismaMock.duskLedgerEntry.aggregate.mockResolvedValue({ _sum: { amount: 45 } });
    const service = new DuskLedgerService();

    await expect(service.getLifetimeEarned(" discord-1 ")).resolves.toBe(45);
    expect(prismaMock.duskLedgerEntry.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          walletId: "discord-1",
          transactionType: "EARNING",
          reversals: { none: {} },
          reversalRequests: {
            none: {
              OR: [
                { resolution: { is: null } },
                { resolution: { is: { resolutionType: DuskReversalResolutionType.APPLIED } } },
              ],
            },
          },
        }),
      }),
    );
  });

  it("excludes an earning with an applied reversal request from lifetime earned", async () => {
    prismaMock.duskLedgerEntry.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
    const service = new DuskLedgerService();

    await expect(service.getLifetimeEarned("discord-1")).resolves.toBe(0);
    expect(prismaMock.duskLedgerEntry.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          reversals: { none: {} },
          reversalRequests: {
            none: {
              OR: [
                { resolution: { is: null } },
                { resolution: { is: { resolutionType: DuskReversalResolutionType.APPLIED } } },
              ],
            },
          },
        }),
      }),
    );
  });

  it("reads a stable bounded history page with a compound cursor", async () => {
    const entries = [
      makeEntry({ id: "entry-2", createdAt: new Date("2026-11-12T21:00:00.000Z") }),
      makeEntry({ id: "entry-1" }),
    ];
    prismaMock.duskLedgerEntry.findMany.mockResolvedValue(entries);
    const service = new DuskLedgerService();

    await expect(
      service.listEntryPage(" discord-1 ", {
        id: "entry-3",
        createdAt: new Date("2026-11-12T22:00:00.000Z"),
      }, 1),
    ).resolves.toEqual({
      entries: [entries[0]],
      hasMore: true,
      nextCursor: { id: "entry-2", createdAt: entries[0].createdAt },
    });
    expect(prismaMock.duskLedgerEntry.findMany).toHaveBeenCalledWith({
      where: {
        walletId: "discord-1",
        OR: [
          { createdAt: { lt: new Date("2026-11-12T22:00:00.000Z") } },
          { createdAt: new Date("2026-11-12T22:00:00.000Z"), id: { lt: "entry-3" } },
        ],
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 2,
    });
  });

  it("recovers a concurrent first-wallet create without surfacing P2002", async () => {
    const wallet = { discordUserId: "discord-race", balance: 0 };
    prismaMock.duskWallet.create
      .mockRejectedValueOnce(Object.assign(new Error("wallet unique race"), { code: "P2002" }))
      .mockResolvedValueOnce(wallet);
    prismaMock.duskWallet.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue(wallet);
    const service = new DuskLedgerService();

    await expect(Promise.all([service.ensureWallet("discord-race"), service.ensureWallet("discord-race")])).resolves.toEqual([
      wallet,
      wallet,
    ]);
    expect(prismaMock.duskWallet.findUnique).toHaveBeenCalledWith({ where: { discordUserId: "discord-race" } });
  });

  it("reads an existing canonical event after a create race without updating the immutable row", async () => {
    txMock.duskLedgerSourceEvent.create.mockRejectedValue(
      Object.assign(new Error("source event unique race"), { code: "P2002" }),
    );
    txMock.duskLedgerSourceEvent.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "source-race", beneficiaryMode: "MULTI_BENEFICIARY" });
    const service = new DuskLedgerService();

    await expect(
      service.recordEarning({
        ...baseInput,
        beneficiaryMode: "MULTI_BENEFICIARY",
        beneficiaryKey: "participant-race",
        amount: 10,
      }),
    ).resolves.toMatchObject({ outcome: "applied", duplicate: false });
    expect(txMock.duskLedgerSourceEvent.create).toHaveBeenCalledTimes(1);
    expect(txMock.duskLedgerSourceEvent.findUnique).toHaveBeenCalledTimes(2);
  });

  it("shares one wallet across operations for the same Discord identity", async () => {
    const service = new DuskLedgerService();

    await service.recordEarning({ ...baseInput, amount: 20 });
    await service.spend({
      ...baseInput,
      sourceEventId: "purchase-1",
      idempotencyKey: "purchase-request-1",
      amount: 5,
    });

    expect(txMock.duskWallet.create).toHaveBeenCalledTimes(2);
    expect(txMock.duskWallet.create.mock.calls.every(([args]) => args.data.discordUserId === "discord-1")).toBe(true);
    expect(txMock.duskLedgerEntry.create.mock.calls[1][0].data).toEqual(
      expect.objectContaining({ walletId: "discord-1", amount: -5, transactionType: "SPEND" }),
    );
  });

  it("keeps balance and ledger creation inside one transaction and propagates failure", async () => {
    txMock.duskLedgerEntry.create.mockRejectedValue(new Error("ledger insert failed"));
    const service = new DuskLedgerService();

    await expect(service.recordEarning({ ...baseInput, amount: 10 })).rejects.toThrow("ledger insert failed");
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(txMock.duskWallet.update).toHaveBeenCalledTimes(1);
  });

  it("returns an idempotent duplicate without charging twice", async () => {
    const existing = makeEntry();
    txMock.duskLedgerEntry.findUnique.mockResolvedValue(existing);
    txMock.duskWallet.findUnique.mockResolvedValue({ balance: 10 });
    const service = new DuskLedgerService();

    await expect(service.recordEarning({ ...baseInput, amount: 10 })).resolves.toEqual({
      outcome: "applied",
      entry: existing,
      balance: 10,
      duplicate: true,
    });
    expect(txMock.duskWallet.create).not.toHaveBeenCalled();
    expect(txMock.duskWallet.update).not.toHaveBeenCalled();
    expect(txMock.duskLedgerEntry.create).not.toHaveBeenCalled();
  });

  it("rejects reuse of an idempotency key for different accounting data", async () => {
    txMock.duskLedgerEntry.findUnique.mockResolvedValue(makeEntry({ amount: 9 }));
    const service = new DuskLedgerService();

    await expect(service.recordEarning({ ...baseInput, amount: 10 })).rejects.toBeInstanceOf(
      DuskLedgerIdempotencyConflictError,
    );
  });

  it("rejects cross-wallet claims for an authoritative single-recipient event", async () => {
    const existingClaim = { id: "claim-1", walletId: "discord-1" };
    txMock.duskLedgerSourceEventClaim.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(existingClaim);
    const service = new DuskLedgerService();

    await service.recordEarning({ ...baseInput, amount: 10 });
    await expect(
      service.recordEarning({ ...baseInput, discordUserId: "discord-2", idempotencyKey: "request-2", amount: 10 }),
    ).rejects.toBeInstanceOf(DuskLedgerEventAlreadyClaimedError);
    expect(txMock.duskLedgerEntry.create).toHaveBeenCalledTimes(1);
  });

  it("allows distinct beneficiary claims for a multi-beneficiary event", async () => {
    txMock.duskLedgerSourceEvent.create.mockResolvedValue({
      id: "source-multi",
      beneficiaryMode: "MULTI_BENEFICIARY",
    });
    const service = new DuskLedgerService();

    await service.recordEarning({
      ...baseInput,
      discordUserId: "discord-1",
      amount: 10,
      beneficiaryMode: "MULTI_BENEFICIARY",
      beneficiaryKey: "participant-a",
    });
    await expect(
      service.recordEarning({
        ...baseInput,
        discordUserId: "discord-1",
        idempotencyKey: "request-2",
        amount: 10,
        beneficiaryMode: "MULTI_BENEFICIARY",
        beneficiaryKey: "participant-b",
      }),
    ).resolves.toMatchObject({ outcome: "applied", duplicate: false });
    expect(txMock.duskLedgerSourceEventClaim.create).toHaveBeenCalledTimes(2);
  });

  it("rejects policy, actor, reason, and attribution conflicts on an idempotent replay", async () => {
    const existing = makeEntry({
      policyVersion: "policy-v1",
      actorDiscordUserId: "actor-1",
      attribution: { proof: "a", nested: { first: true } },
      reason: "original reason",
    });
    txMock.duskLedgerEntry.findUnique.mockResolvedValue(existing);
    const service = new DuskLedgerService();

    for (const change of [
      { policyVersion: "policy-v2" },
      { actorDiscordUserId: "actor-2" },
      { reason: "different reason" },
      { attribution: { nested: { first: true }, proof: "changed" } },
    ]) {
      await expect(service.recordEarning({ ...baseInput, amount: 10, ...change })).rejects.toBeInstanceOf(
        DuskLedgerIdempotencyConflictError,
      );
    }
  });

  it("retries serialization conflicts and preserves serializable isolation", async () => {
    const firstError = Object.assign(new Error("serialization conflict"), { code: "P2034" });
    prismaMock.$transaction
      .mockRejectedValueOnce(firstError)
      .mockImplementationOnce(async (work: (tx: typeof txMock) => Promise<unknown>) => work(txMock));
    const service = new DuskLedgerService();

    await expect(service.recordEarning({ ...baseInput, amount: 10 })).resolves.toMatchObject({ duplicate: false });
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(2);
    expect(prismaMock.$transaction.mock.calls[0][1]).toMatchObject({ isolationLevel: "Serializable" });
  });

  it("does not create a spend entry when the conditional debit cannot obtain funds", async () => {
    txMock.duskWallet.updateMany.mockResolvedValue({ count: 0 });
    const service = new DuskLedgerService();

    await expect(service.spend({ ...baseInput, amount: 1 })).rejects.toBeInstanceOf(
      DuskInsufficientBalanceError,
    );
    expect(txMock.duskLedgerEntry.create).not.toHaveBeenCalled();
  });

  it("rejects zero, fractional, and sign-invalid amounts", async () => {
    const service = new DuskLedgerService();

    await expect(service.recordEarning({ ...baseInput, amount: 0 })).rejects.toBeInstanceOf(
      DuskLedgerValidationError,
    );
    await expect(service.recordEarning({ ...baseInput, amount: 1.5 })).rejects.toBeInstanceOf(
      DuskLedgerValidationError,
    );
    await expect(service.spend({ ...baseInput, amount: -1 })).rejects.toBeInstanceOf(
      DuskLedgerValidationError,
    );
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("makes reversal requests idempotent", async () => {
    const reversal = makeEntry({
      id: "reversal-1",
      amount: -10,
      transactionType: "REVERSAL",
      beneficiaryMode: null,
      actorDiscordUserId: "admin-1",
      sourceEventId: "reversal-event",
      idempotencyKey: "reversal-request",
      reversalOfId: "entry-1",
    });
    txMock.duskLedgerEntry.findUnique.mockResolvedValue(reversal);
    txMock.duskWallet.findUnique.mockResolvedValue({ balance: 0 });
    const service = new DuskLedgerService();

    await expect(
      service.reverse({
        ...baseInput,
        sourceEventId: "reversal-event",
        idempotencyKey: "reversal-request",
        originalEntryId: "entry-1",
        actorDiscordUserId: "admin-1",
      }),
    ).resolves.toMatchObject({ outcome: "applied", entry: reversal, balance: 0, duplicate: true });
    expect(txMock.duskLedgerEntry.create).not.toHaveBeenCalled();
  });

  it("records a pending auditable reversal when the original balance was spent", async () => {
    const original = makeEntry({ id: "entry-1", amount: 10 });
    txMock.duskLedgerEntry.findUnique.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
      if (where.id === "entry-1") return original;
      return null;
    });
    txMock.duskWallet.updateMany.mockResolvedValue({ count: 0 });
    txMock.duskWallet.findUnique.mockResolvedValue({ balance: 0 });
    const service = new DuskLedgerService();

    await expect(
      service.reverse({
        ...baseInput,
        sourceEventId: "reversal-event",
        idempotencyKey: "reversal-request",
        originalEntryId: "entry-1",
        actorDiscordUserId: "admin-1",
      }),
    ).resolves.toMatchObject({ outcome: "pending_review", duplicate: false, balance: 0 });
    expect(txMock.duskLedgerReversalRequest.create).toHaveBeenCalledTimes(1);
    expect(txMock.duskLedgerEntry.create).not.toHaveBeenCalled();
  });

  it("returns the same pending reversal for a retry and rejects conflicting replay data", async () => {
    const pending = {
      id: "pending-1",
      walletId: "discord-1",
      originalEntryId: "entry-1",
      requestedAmount: -10,
      sourceEventType: "test",
      sourceEventId: "reversal-event",
      idempotencyKey: "reversal-request",
      attribution: null,
      policyVersion: null,
      reason: "focused test",
      actorDiscordUserId: "admin-1",
      createdAt: new Date(),
    };
    txMock.duskLedgerReversalRequest.findUnique.mockResolvedValue(pending);
    txMock.duskWallet.findUnique.mockResolvedValue({ balance: 0 });
    const service = new DuskLedgerService();

    await expect(
      service.reverse({
        ...baseInput,
        sourceEventId: "reversal-event",
        idempotencyKey: "reversal-request",
        originalEntryId: "entry-1",
        actorDiscordUserId: "admin-1",
      }),
    ).resolves.toMatchObject({ outcome: "pending_review", reversalRequest: pending, duplicate: true });
    await expect(
      service.reverse({
        ...baseInput,
        sourceEventId: "reversal-event",
        idempotencyKey: "reversal-request",
        originalEntryId: "entry-1",
        actorDiscordUserId: "admin-2",
      }),
    ).rejects.toBeInstanceOf(DuskLedgerIdempotencyConflictError);
  });

  it("recovers a concurrent reversal insert deterministically after a unique conflict", async () => {
    const reversal = makeEntry({
      id: "reversal-1",
      amount: -10,
      transactionType: "REVERSAL",
      beneficiaryMode: null,
      sourceEventId: "reversal-event",
      idempotencyKey: "reversal-request",
      actorDiscordUserId: "admin-1",
      reversalOfId: "entry-1",
    });
    prismaMock.$transaction.mockRejectedValue(Object.assign(new Error("unique conflict"), { code: "P2002" }));
    prismaMock.duskLedgerEntry.findUnique.mockResolvedValue(reversal);
    prismaMock.duskWallet.findUnique.mockResolvedValue({ balance: 0 });
    const service = new DuskLedgerService();

    await expect(
      service.reverse({
        ...baseInput,
        sourceEventId: "reversal-event",
        idempotencyKey: "reversal-request",
        originalEntryId: "entry-1",
        actorDiscordUserId: "admin-1",
      }),
    ).resolves.toMatchObject({ outcome: "applied", entry: reversal, duplicate: true });
  });

  it("rejects ambiguous or already-reversed originals", async () => {
    const service = new DuskLedgerService();
    txMock.duskLedgerEntry.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(makeEntry({ transactionType: "EARNING" }))
      .mockResolvedValueOnce(makeEntry({ id: "prior-reversal", transactionType: "REVERSAL" }));

    await expect(
      service.reverse({
        ...baseInput,
        sourceEventId: "reversal-event",
        idempotencyKey: "reversal-request",
        originalEntryId: "entry-1",
        actorDiscordUserId: "admin-1",
      }),
    ).rejects.toBeInstanceOf(DuskLedgerAlreadyReversedError);

    txMock.duskLedgerEntry.findUnique.mockReset();
    txMock.duskLedgerEntry.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(makeEntry({ walletId: "other-discord" }));
    await expect(
      service.reverse({
        ...baseInput,
        sourceEventId: "reversal-event-2",
        idempotencyKey: "reversal-request-2",
        originalEntryId: "entry-1",
        actorDiscordUserId: "admin-1",
      }),
    ).rejects.toBeInstanceOf(DuskLedgerValidationError);
  });

  it("bounds administrator audit history and reversal reads without writing", async () => {
    const service = new DuskLedgerService();

    await expect(service.listAuditEntryPage("member-1", null, 999)).resolves.toEqual({
      entries: [],
      hasMore: false,
      nextCursor: null,
    });
    await expect(service.listReversalRequests("member-1", 999)).resolves.toEqual([]);

    expect(prismaMock.duskLedgerEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 51, where: { walletId: "member-1" } }),
    );
    expect(prismaMock.duskLedgerReversalRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 100, where: { walletId: "member-1" } }),
    );
    expect(prismaMock.duskWallet.create).not.toHaveBeenCalled();
    expect(prismaMock.duskLedgerEntry.create).not.toHaveBeenCalled();
    expect(prismaMock.duskLedgerReversalRequest.findUnique).not.toHaveBeenCalled();
  });

  it("keeps a source reference UNKNOWN when no canonical event or owner evidence exists", async () => {
    const service = new DuskLedgerService();
    prismaMock.duskLedgerEntry.findFirst.mockResolvedValue({
      id: "entry-1",
      walletId: "member-1",
      sourceEventType: "future-source",
      sourceEventId: "future-event-1",
      attribution: { claimed: true },
      policy: null,
      sourceEventClaim: null,
    });

    const result = await service.getSourceEventAudit("member-1", "entry-1", "guild-1");

    expect(result?.sourceEvent).toBeNull();
    expect(result?.claimRecordedForEntry).toBe(false);
    expect(result?.operationalEvidence).toMatchObject({
      status: "UNKNOWN",
      summary: expect.stringContaining("No supported operational evidence owner"),
    });
    expect(prismaMock.duskWallet.create).not.toHaveBeenCalled();
    expect(prismaMock.duskLedgerEntry.create).not.toHaveBeenCalled();
  });

  it("uses the direct claim relation when a bounded source claim sample overflows", async () => {
    const service = new DuskLedgerService();
    const allClaims = Array.from({ length: 101 }, (_, index) => ({
      id: `claim-${index}`,
      beneficiaryKey: `beneficiary-${index}`,
      walletId: index === 0 ? "member-1" : `member-${index + 2}`,
      ledgerEntryId: `entry-${index + 2}`,
      createdAt: new Date("2026-11-12T20:00:00.000Z"),
    }));
    const claims = allClaims.slice(0, 100);
    prismaMock.duskLedgerEntry.findFirst.mockResolvedValue({
      id: "entry-1",
      walletId: "member-1",
      sourceEventType: "unknown-source",
      sourceEventId: "source-1",
      attribution: null,
      policy: null,
      sourceEventClaim: {
        ledgerEntryId: "entry-1",
        sourceEvent: {
          id: "source-row-1",
          sourceEventType: "unknown-source",
          sourceEventId: "source-1",
          beneficiaryMode: "MULTI_BENEFICIARY",
          createdAt: new Date("2026-11-12T20:00:00.000Z"),
          claims,
          _count: { claims: 101 },
        },
      },
    });

    const result = await service.getSourceEventAudit("member-1", "entry-1", "guild-1");

    expect(result?.claimRecordedForEntry).toBe(true);
    expect(result?.claims).toHaveLength(100);
    expect(result?.claimsTotal).toBe(101);
    expect(result?.claimsSampleTruncated).toBe(true);
  });

  it("marks owner evidence contradicted when the operational row crosses wallet or guild scope", async () => {
    const service = new DuskLedgerService();
    prismaMock.duskLedgerEntry.findFirst.mockResolvedValue({
      id: "entry-1",
      walletId: "member-1",
      sourceEventType: "rep-work-activity",
      sourceEventId: "rep-event-1",
      attribution: null,
      policy: null,
      sourceEventClaim: null,
    });
    prismaMock.duskLedgerSourceEvent.findUnique.mockResolvedValue(null);
    prismaMock.repWorkActivityEvent.findUnique.mockResolvedValue({
      id: "rep-event-1",
      guildId: "guild-1",
      activityType: "BASES_CHECKED",
      discordUserId: "different-member",
      clanTag: "#RD",
      syncMessageId: null,
      sourceMessageId: "message-1",
      sourceTrackedMessageId: null,
      warId: null,
      warStartTime: null,
      opponentTag: null,
      eventAt: new Date("2026-11-12T20:00:00.000Z"),
      createdAt: new Date("2026-11-12T20:00:00.000Z"),
    });

    const result = await service.getSourceEventAudit("member-1", "entry-1", "guild-1");

    expect(result?.operationalEvidence).toMatchObject({
      status: "CONTRADICTED",
      owner: "RepWorkActivityService",
    });
  });

  it("protects the migration with nonnegative, uniqueness, and append-only constraints", () => {
    const schema = readFileSync("prisma/schema.prisma", "utf8");
    const migration = readFileSync(
      "prisma/migrations/20261112120000_add_dusk_wallet_ledger_foundation/migration.sql",
      "utf8",
    );

    expect(schema).toContain("model DuskWallet");
    expect(schema).toContain("discordUserId String            @id");
    expect(schema).toContain("@@unique([walletId, idempotencyKey])");
    expect(migration).toContain('CHECK ("balance" >= 0)');
    expect(migration).toContain('CHECK ("amount" <> 0)');
    expect(migration).toContain('CREATE TRIGGER "DuskLedgerEntry_immutable"');
    expect(migration).toContain('CREATE UNIQUE INDEX "DuskLedgerEntry_wallet_source_single_key"');
    expect(migration).toContain('CREATE UNIQUE INDEX "DuskLedgerEntry_wallet_source_multi_key"');
    expect(migration).toContain('CREATE UNIQUE INDEX "DuskLedgerSourceEventClaim_single_event_key"');
    expect(migration).toContain('CREATE UNIQUE INDEX "DuskLedgerSourceEventClaim_multi_event_beneficiary_key"');
    expect(migration).toContain('CREATE TRIGGER "DuskLedgerReversalRequest_immutable"');
    expect(migration).not.toMatch(/DROP\s+(TABLE|COLUMN|INDEX)/i);
    expect(migration).not.toMatch(/DELETE\s+FROM/i);
  });
});
