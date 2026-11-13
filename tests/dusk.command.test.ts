import { beforeEach, describe, expect, it, vi } from "vitest";
import { Dusk } from "../src/commands/Dusk";
import { Commands } from "../src/Commands";
import { hasPermissionTargetForCommand } from "../src/services/CommandPermissionService";
import { duskLedgerService } from "../src/services/DuskLedgerService";

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
    policyVersion: "draft",
    reason: "verified work",
    actorDiscordUserId: null,
    reversalOfId: null,
    createdAt: new Date("2026-11-12T20:00:00.000Z"),
    ...overrides,
  } as any;
}

function makeInteraction(userId = "discord-1") {
  const collector = {
    on: vi.fn(),
  };
  const message = {
    createMessageComponentCollector: vi.fn(() => collector),
  };
  return {
    interaction: {
      id: "interaction-1",
      user: { id: userId },
      deferReply: vi.fn(),
      editReply: vi.fn(),
      fetchReply: vi.fn().mockResolvedValue(message),
      options: {
        getString: vi.fn(() => {
          throw new Error("/dusk must not inspect target-user options");
        }),
      },
    },
    collector,
  };
}

describe("/dusk", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(duskLedgerService, "getBalance").mockResolvedValue(0);
    vi.spyOn(duskLedgerService, "getLifetimeEarned").mockResolvedValue(0);
    vi.spyOn(duskLedgerService, "listEntries").mockResolvedValue([]);
    vi.spyOn(duskLedgerService, "listEntryPage").mockResolvedValue({
      entries: [],
      hasMore: false,
      nextCursor: null,
    });
  });

  it("is registered, permission-targeted, and fixed private by default", () => {
    expect(Commands.find((command) => command.name === "dusk")).toBe(Dusk);
    expect(hasPermissionTargetForCommand("dusk")).toBe(true);
    expect(Dusk.suppressVisibilityOption).toBe(true);
    expect(Dusk.options).toBeUndefined();
  });

  it("shows zero for an uninitialized wallet without creating one", async () => {
    const { interaction } = makeInteraction();

    await Dusk.run({} as any, interaction as any, {} as any);

    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(duskLedgerService.getBalance).toHaveBeenCalledWith("discord-1");
    expect(duskLedgerService.getLifetimeEarned).toHaveBeenCalledWith("discord-1");
    expect(duskLedgerService.listEntries).toHaveBeenCalledWith("discord-1", 5);
    const response = interaction.editReply.mock.calls[0][0];
    const embed = response.embeds[0].toJSON();
    expect(embed.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Available balance", value: "0 Duskits" }),
        expect.objectContaining({ name: "Lifetime earned", value: "0 Duskits" }),
      ]),
    );
    expect(response.components[0].components[0].data.label).toBe("View History");
  });

  it("uses only the caller's Discord identity and displays qualifying lifetime earnings", async () => {
    vi.spyOn(duskLedgerService, "getBalance").mockResolvedValue(35);
    vi.spyOn(duskLedgerService, "getLifetimeEarned").mockResolvedValue(80);
    vi.spyOn(duskLedgerService, "listEntries").mockResolvedValue([
      makeEntry({ amount: 25 }),
      makeEntry({ id: "entry-2", amount: -10, transactionType: "SPEND", reason: "market" }),
    ]);
    const { interaction } = makeInteraction("caller-only");

    await Dusk.run({} as any, interaction as any, {} as any);

    expect(duskLedgerService.getBalance).toHaveBeenCalledWith("caller-only");
    expect(duskLedgerService.getLifetimeEarned).toHaveBeenCalledWith("caller-only");
    expect(duskLedgerService.listEntries).toHaveBeenCalledWith("caller-only", 5);
    expect(interaction.options.getString).not.toHaveBeenCalled();
    const embed = interaction.editReply.mock.calls[0][0].embeds[0].toJSON();
    expect(embed.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Available balance", value: "35 Duskits" }),
        expect.objectContaining({ name: "Lifetime earned", value: "80 Duskits" }),
      ]),
    );
  });

  it("keeps history pagination private and user-scoped", async () => {
    const nextCursor = { id: "entry-1", createdAt: new Date("2026-11-12T20:00:00.000Z") };
    vi.spyOn(duskLedgerService, "listEntryPage")
      .mockResolvedValueOnce({ entries: [makeEntry()], hasMore: true, nextCursor })
      .mockResolvedValueOnce({ entries: [], hasMore: false, nextCursor: null });
    const { interaction, collector } = makeInteraction("caller-only");

    await Dusk.run({} as any, interaction as any, {} as any);
    const collect = collector.on.mock.calls.find(([event]) => event === "collect")?.[1];
    expect(collect).toBeTypeOf("function");

    const unauthorizedButton = {
      customId: "dusk:interaction-1:history",
      user: { id: "different-user" },
      reply: vi.fn(),
      update: vi.fn(),
    };
    await collect(unauthorizedButton);
    expect(unauthorizedButton.reply).toHaveBeenCalledWith({
      content: "This wallet history belongs to another user.",
      ephemeral: true,
    });
    expect(unauthorizedButton.update).not.toHaveBeenCalled();

    const historyButton = {
      customId: "dusk:interaction-1:history",
      user: { id: "caller-only" },
      reply: vi.fn(),
      update: vi.fn(),
      replied: false,
      deferred: false,
    };
    await collect(historyButton);
    expect(duskLedgerService.listEntryPage).toHaveBeenCalledWith("caller-only", null, 8);
    expect(historyButton.update).toHaveBeenCalled();

    const olderButton = {
      customId: "dusk:interaction-1:older",
      user: { id: "caller-only" },
      reply: vi.fn(),
      update: vi.fn(),
      replied: false,
      deferred: false,
    };
    await collect(olderButton);
    expect(duskLedgerService.listEntryPage).toHaveBeenCalledWith("caller-only", nextCursor, 8);
    expect(olderButton.update).toHaveBeenCalled();
  });

  it("shows a private failure message when the DB read fails", async () => {
    vi.spyOn(duskLedgerService, "getBalance").mockRejectedValue(new Error("db unavailable"));
    const { interaction } = makeInteraction();

    await Dusk.run({} as any, interaction as any, {} as any);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Duskits wallet is temporarily unavailable. Please try again later.",
        components: [],
      }),
    );
  });
});
