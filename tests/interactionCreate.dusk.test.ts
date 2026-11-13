import { beforeEach, describe, expect, it, vi } from "vitest";

type ListenerHandler = (interaction: unknown) => Promise<void>;

function makeDuskInteraction(commandName = "dusk") {
  const collectorHandlers = new Map<string, (value?: unknown) => Promise<void> | void>();
  const collector = {
    on: vi.fn((event: string, callback: (value?: unknown) => Promise<void> | void) => {
      collectorHandlers.set(event, callback);
      return collector;
    }),
  };
  const message = {
    createMessageComponentCollector: vi.fn(() => collector),
  };
  const interaction: any = {
    id: "dusk-interaction-1",
    commandName,
    guildId: "guild-1",
    guild: {
      id: "guild-1",
      name: "Guild One",
      members: {
        fetch: vi.fn().mockResolvedValue({
          id: "target-1",
          displayName: "Target Member",
          user: { username: "target" },
        }),
      },
    },
    user: { id: "discord-1", tag: "tester#0001" },
    deferred: false,
    replied: false,
    inGuild: () => true,
    memberPermissions: { has: () => commandName === "dusk-admin" },
    member: { roles: [] },
    isAutocomplete: () => false,
    isButton: () => false,
    isUserSelectMenu: () => false,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    isChatInputCommand: () => true,
    options: {
      data: [],
      getSubcommand: vi.fn(() => (commandName === "dusk-admin" ? "audit" : null)),
      getSubcommandGroup: vi.fn(() => null),
      getUser: vi.fn(() => ({ id: "target-1" })),
      getString: vi.fn(() => {
        throw new Error("/dusk must not inspect visibility options");
      }),
    },
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    reply: vi.fn(async () => {
      interaction.replied = true;
    }),
    editReply: vi.fn().mockResolvedValue(undefined),
    fetchReply: vi.fn().mockResolvedValue(message),
    followUp: vi.fn().mockResolvedValue(undefined),
  };
  return { interaction, collector, collectorHandlers };
}

async function loadInteractionHandler(): Promise<ListenerHandler> {
  const { CommandPermissionService } = await import("../src/services/CommandPermissionService");
  vi.spyOn(CommandPermissionService.prototype, "canUseAnyTarget").mockResolvedValue(true);

  const { default: registerInteractionCreate } = await import("../src/listeners/interactionCreate");
  const handlers = new Map<string, ListenerHandler>();
  const client = {
    on: vi.fn((event: string, callback: ListenerHandler) => {
      handlers.set(event, callback);
    }),
  } as any;
  registerInteractionCreate(client, {} as any);

  const handler = handlers.get("interactionCreate");
  if (!handler) throw new Error("interactionCreate listener was not registered");
  return handler;
}

function responseLabels(payload: any): string[] {
  return (payload?.components ?? []).flatMap((row: any) =>
    (row?.components ?? []).map((component: any) => component?.data?.label ?? component?.label),
  );
}

function expectNoPublicPostButton(payload: any): void {
  expect(responseLabels(payload)).not.toContain("Post to Channel");
}

describe("interactionCreate /dusk private response integration", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("keeps the initial wallet and collector cleanup private", async () => {
    const { duskLedgerService } = await import("../src/services/DuskLedgerService");
    vi.spyOn(duskLedgerService, "getBalance").mockResolvedValue(12);
    vi.spyOn(duskLedgerService, "getLifetimeEarned").mockResolvedValue(20);
    vi.spyOn(duskLedgerService, "listEntries").mockResolvedValue([]);
    const handler = await loadInteractionHandler();
    const { interaction, collectorHandlers } = makeDuskInteraction();

    await handler(interaction);

    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(interaction.options.getString).not.toHaveBeenCalled();
    expectNoPublicPostButton(interaction.editReply.mock.calls[0][0]);

    const end = collectorHandlers.get("end");
    expect(end).toBeTypeOf("function");
    await end?.();
    expect(interaction.editReply).toHaveBeenLastCalledWith({ components: [] });
    expectNoPublicPostButton(interaction.editReply.mock.calls.at(-1)?.[0]);
  }, 30000);

  it("keeps history updates private and scoped to the caller", async () => {
    const { duskLedgerService } = await import("../src/services/DuskLedgerService");
    vi.spyOn(duskLedgerService, "getBalance").mockResolvedValue(12);
    vi.spyOn(duskLedgerService, "getLifetimeEarned").mockResolvedValue(20);
    vi.spyOn(duskLedgerService, "listEntries").mockResolvedValue([]);
    vi.spyOn(duskLedgerService, "listEntryPage").mockResolvedValue({
      entries: [],
      hasMore: false,
      nextCursor: null,
    });
    const handler = await loadInteractionHandler();
    const { interaction, collectorHandlers } = makeDuskInteraction();

    await handler(interaction);
    const collect = collectorHandlers.get("collect");
    expect(collect).toBeTypeOf("function");

    const historyButton = {
      customId: "dusk:dusk-interaction-1:history",
      user: { id: "discord-1" },
      replied: false,
      deferred: false,
      reply: vi.fn(),
      update: vi.fn().mockResolvedValue(undefined),
    };
    await collect?.(historyButton);

    expect(duskLedgerService.listEntryPage).toHaveBeenCalledWith("discord-1", null, 8);
    expect(historyButton.update).toHaveBeenCalledTimes(1);
    expectNoPublicPostButton(historyButton.update.mock.calls[0][0]);
  }, 30000);

  it("keeps a failed wallet read private without a public-post control", async () => {
    const { duskLedgerService } = await import("../src/services/DuskLedgerService");
    vi.spyOn(duskLedgerService, "getBalance").mockRejectedValue(new Error("db unavailable"));
    const handler = await loadInteractionHandler();
    const { interaction } = makeDuskInteraction();

    await handler(interaction);

    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Duskits wallet is temporarily unavailable. Please try again later.",
        components: [],
      }),
    );
    expectNoPublicPostButton(interaction.editReply.mock.calls.at(-1)?.[0]);
  }, 30000);

  it("keeps /dusk-admin audit private and outside the global post wrapper", async () => {
    const { duskLedgerService } = await import("../src/services/DuskLedgerService");
    vi.spyOn(duskLedgerService, "getBalance").mockResolvedValue(12);
    vi.spyOn(duskLedgerService, "getLifetimeEarned").mockResolvedValue(20);
    vi.spyOn(duskLedgerService, "listAuditEntryPage").mockResolvedValue({
      entries: [],
      hasMore: false,
      nextCursor: null,
    });
    vi.spyOn(duskLedgerService, "listReversalRequests").mockResolvedValue([]);
    const handler = await loadInteractionHandler();
    const { interaction } = makeDuskInteraction("dusk-admin");

    await handler(interaction);

    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expectNoPublicPostButton(interaction.editReply.mock.calls[0][0]);
    expect(interaction.editReply.mock.calls[0][0].allowedMentions).toEqual({ parse: [] });
  }, 30000);
});
