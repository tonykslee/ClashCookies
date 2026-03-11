import type { Client } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Command } from "../src/Command";

type ListenerHandler = (interaction: unknown) => Promise<void>;

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
  const originalRun = compoCommand.run;
  compoCommand.run = runMock;

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
      compoCommand.run = originalRun;
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

  it("acknowledges /compo before waiting on permission checks", async () => {
    const runMock = vi.fn().mockResolvedValue(undefined);
    const { SettingsService } = await import("../src/services/SettingsService");
    let resolveSettingsGet: (value: string) => void = () => undefined;
    const settingsGetPromise = new Promise<string>((resolve) => {
      resolveSettingsGet = resolve;
    });
    const settingsGetSpy = vi
      .spyOn(SettingsService.prototype, "get")
      .mockReturnValue(settingsGetPromise as Promise<string | null>);
    const { handler, restoreCommand } = await loadInteractionHandler(runMock);
    const interaction = makeCompoSlashInteraction();
    const deferReplySpy = interaction.deferReply;

    const pending = handler(interaction);
    for (let i = 0; i < 20 && settingsGetSpy.mock.calls.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(deferReplySpy).toHaveBeenCalledTimes(1);
    expect(settingsGetSpy).toHaveBeenCalled();
    expect(deferReplySpy.mock.invocationCallOrder[0]).toBeLessThan(
      settingsGetSpy.mock.invocationCallOrder[0]
    );
    expect(runMock).not.toHaveBeenCalled();

    resolveSettingsGet("123");
    await pending;
    restoreCommand();
    expect(runMock).toHaveBeenCalledTimes(1);
  });

  it("uses post-ack error response path when /compo fails after defer", async () => {
    const { SettingsService } = await import("../src/services/SettingsService");
    vi.spyOn(SettingsService.prototype, "get").mockResolvedValue("123");
    const runMock = vi.fn().mockRejectedValue(new Error("boom"));
    const { handler, restoreCommand } = await loadInteractionHandler(runMock);
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
  });
});
