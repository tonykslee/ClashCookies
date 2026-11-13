import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

const txMock = vi.hoisted(() => ({
  duskWallet: {
    upsert: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    findUnique: vi.fn(),
  },
  duskLedgerEntry: {
    findUnique: vi.fn(),
    create: vi.fn(),
    findMany: vi.fn(),
  },
}));

const prismaMock = vi.hoisted(() => ({
  duskWallet: {
    upsert: vi.fn(),
    findUnique: vi.fn(),
  },
  duskLedgerEntry: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
  },
  $transaction: vi.fn(),
}));

vi.mock("../src/prisma", () => ({ prisma: prismaMock }));

import {
  DuskInsufficientBalanceError,
  DuskLedgerAlreadyReversedError,
  DuskLedgerIdempotencyConflictError,
  DuskLedgerService,
  DuskLedgerValidationError,
} from "../src/services/DuskLedgerService";

const baseInput = {
  discordUserId: "discord-1",
  sourceEventType: "test",
  sourceEventId: "event-1",
  idempotencyKey: "request-1",
  reason: "focused test",
};

function makeEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "entry-1",
    walletId: "discord-1",
    amount: 10,
    transactionType: "EARNING",
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
  txMock.duskWallet.upsert.mockResolvedValue({ discordUserId: "discord-1", balance: 0 });
  txMock.duskWallet.update.mockResolvedValue({ discordUserId: "discord-1", balance: 10 });
  txMock.duskWallet.updateMany.mockResolvedValue({ count: 1 });
  txMock.duskWallet.findUnique.mockResolvedValue({ balance: 10 });
  txMock.duskLedgerEntry.findUnique.mockResolvedValue(null);
  txMock.duskLedgerEntry.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
    makeEntry(data),
  );
}

describe("DuskLedgerService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configureSuccessfulTransaction();
    prismaMock.duskWallet.upsert.mockResolvedValue({ discordUserId: "discord-1", balance: 0 });
    prismaMock.duskWallet.findUnique.mockResolvedValue({ balance: 0 });
    prismaMock.duskLedgerEntry.findUnique.mockResolvedValue(null);
  });

  it("creates a zero-balance wallet keyed only by Discord identity", async () => {
    const service = new DuskLedgerService();

    await expect(service.ensureWallet(" discord-1 ")).resolves.toEqual({
      discordUserId: "discord-1",
      balance: 0,
    });
    expect(prismaMock.duskWallet.upsert).toHaveBeenCalledWith({
      where: { discordUserId: "discord-1" },
      create: { discordUserId: "discord-1" },
      update: {},
    });
    expect(JSON.stringify(prismaMock.duskWallet.upsert.mock.calls[0])).not.toContain("playerTag");
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

    expect(txMock.duskWallet.upsert).toHaveBeenCalledTimes(2);
    expect(txMock.duskWallet.upsert.mock.calls.every(([args]) => args.where.discordUserId === "discord-1")).toBe(true);
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
      entry: existing,
      balance: 10,
      duplicate: true,
    });
    expect(txMock.duskWallet.upsert).not.toHaveBeenCalled();
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
    ).resolves.toMatchObject({ entry: reversal, balance: 0, duplicate: true });
    expect(txMock.duskLedgerEntry.create).not.toHaveBeenCalled();
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
    expect(migration).toContain('CREATE UNIQUE INDEX "DuskLedgerEntry_walletId_sourceEventType_sourceEventId_key"');
    expect(migration).not.toMatch(/DROP\s+(TABLE|COLUMN|INDEX)/i);
    expect(migration).not.toMatch(/DELETE\s+FROM/i);
  });
});
