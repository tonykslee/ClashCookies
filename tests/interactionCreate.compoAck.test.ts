import type { ChatInputCommandInteraction, Client } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Command } from "../src/Command";

type ListenerHandler = (interaction: unknown) => Promise<void>;
type CompoRun = (client: Client, interaction: ChatInputCommandInteraction, cocService: unknown) => Promise<void>;

function makeCompoSlashInteraction() {
  const interaction: any = {
    id: "interaction-1",
    commandName: "compo",
    guildId: "guild-1",
    guild: { id: "guild-1", name: "Guild One" },
    user: { id: "user-1", tag: "tester#0001" },
    deferred: false,
    replied: false,
    inGuild: () => true,
    memberPermissions: {
      has: () => false,
    },
    member: {
      roles: ["123"],
    },
    isAutocomplete: () => false,
    isButton: () => false,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    isChatInputCommand: () => true,
    options: {
      data: [],
      getSubcommand: vi.fn(() => "state"),
      getSubcommandGroup: vi.fn(() => null),
      getString: vi.fn(() => null),
    },
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    reply: vi.fn(async () => {
      interaction.replied = true;
    }),
    editReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
  };
  return interaction;
}

async function loadInteractionHandler(runMock: ReturnType<typeof vi.fn>): Promise<{
  handler: ListenerHandler;
  restoreCommand: () => void;
}> {
  const { Commands } = await import("../src/Commands");
  const compoCommand = Commands.find((cmd): cmd is Command => cmd.name === "compo");
  if (!compoCommand) {
    throw new Error("Could not find /compo command");
  }

  const runSpy = vi.spyOn(compoCommand, "run").mockImplementation(runMock as unknown as CompoRun);

  const { default: registerInteractionCreate } = await import(
    "../src/listeners/interactionCreate"
  );
  const handlers = new Map<string, ListenerHandler>();
  const client = {
    on: vi.fn((event: string, callback: ListenerHandler) => {
      handlers.set(event, callback);
    }),
  } as unknown as Client;

  registerInteractionCreate(client, {} as any);

  const handler = handlers.get("interactionCreate");
  if (!handler) {
    throw new Error("interactionCreate listener was not registered");
  }

  return {
    handler,
    restoreCommand: () => {
      runSpy.mockRestore();
    },
  };
}

describe("interactionCreate /compo early acknowledgement", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not pre-acknowledge /compo in the interaction listener", async () => {
    const runMock = vi.fn().mockResolvedValue(undefined);
    const { CommandPermissionService } = await import("../src/services/CommandPermissionService");
    let resolveCanUse: (value: boolean) => void = () => undefined;
    const canUsePromise = new Promise<boolean>((resolve) => {
      resolveCanUse = resolve;
    });
    const canUseSpy = vi
      .spyOn(CommandPermissionService.prototype, "canUseAnyTarget")
      .mockReturnValue(canUsePromise);
    const { handler, restoreCommand } = await loadInteractionHandler(runMock as unknown as ReturnType<typeof vi.fn>);
    const interaction = makeCompoSlashInteraction();
    const deferReplySpy = interaction.deferReply;
    const editReplySpy = interaction.editReply;
    const replySpy = interaction.reply;

    const pending = handler(interaction);
    for (let i = 0; i < 20 && canUseSpy.mock.calls.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(deferReplySpy).not.toHaveBeenCalled();
    expect(editReplySpy).not.toHaveBeenCalled();
    expect(replySpy).not.toHaveBeenCalled();
    expect(canUseSpy).toHaveBeenCalled();
    expect(runMock).not.toHaveBeenCalled();

    resolveCanUse(true);
    await pending;
    restoreCommand();
    expect(runMock).toHaveBeenCalledTimes(1);
  }, 30000);

  it("uses post-ack error response path when /compo fails after defer", async () => {
    const { CommandPermissionService } = await import("../src/services/CommandPermissionService");
    vi.spyOn(CommandPermissionService.prototype, "canUseAnyTarget").mockResolvedValue(true);
    const runMockImpl: CompoRun = async (_client, interaction, _cocService) => {
      await interaction.deferReply({ ephemeral: true });
      throw new Error("boom");
    };
    const runMock = vi.fn(runMockImpl);
    const { handler, restoreCommand } = await loadInteractionHandler(runMock as unknown as ReturnType<typeof vi.fn>);
    const interaction = makeCompoSlashInteraction();
    const deferReplySpy = interaction.deferReply;
    const editReplySpy = interaction.editReply;
    const replySpy = interaction.reply;

    await handler(interaction);
    restoreCommand();

    expect(deferReplySpy).toHaveBeenCalledTimes(1);
    expect(editReplySpy).toHaveBeenCalled();
    expect(replySpy).not.toHaveBeenCalled();
    const payload = editReplySpy.mock.calls.at(-1)?.[0];
    const message =
      typeof payload === "string"
        ? payload
        : String((payload as { content?: unknown } | undefined)?.content ?? "");
    expect(message).toContain("Something went wrong.");
  }, 30000);
});
