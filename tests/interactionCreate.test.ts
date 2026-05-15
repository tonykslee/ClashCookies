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
    isUserSelectMenu: () => false,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    isChatInputCommand: () => true,
    options: {
      data: [],
      getSubcommand: vi.fn(() => "place"),
      getSubcommandGroup: vi.fn(() => null),
      getString: vi.fn(() => "145k"),
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

  const { default: registerInteractionCreate } = await import("../src/listeners/interactionCreate");
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

describe("interactionCreate /compo dispatcher diagnostics", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs before and after handler.run for /compo", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { CommandPermissionService } = await import("../src/services/CommandPermissionService");
    vi.spyOn(CommandPermissionService.prototype, "canUseAnyTarget").mockResolvedValue(true);
    const runMock = vi.fn().mockResolvedValue(undefined);
    const { handler, restoreCommand } = await loadInteractionHandler(runMock as unknown as ReturnType<typeof vi.fn>);
    const interaction = makeCompoSlashInteraction();

    await handler(interaction);
    restoreCommand();

    expect(runMock).toHaveBeenCalledTimes(1);
    expect(
      logSpy.mock.calls.some((call) =>
        String(call[0] ?? "").includes("stage=before_handler_run") &&
        String(call[0] ?? "").includes("handler=compo.run"),
      ),
    ).toBe(true);
    expect(
      logSpy.mock.calls.some((call) =>
        String(call[0] ?? "").includes("stage=after_handler_run") &&
        String(call[0] ?? "").includes("handler=compo.run"),
      ),
    ).toBe(true);
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining("handler_run_failed"));
  }, 30000);

  it("logs handler_run_failed when /compo throws before command checkpoints", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { CommandPermissionService } = await import("../src/services/CommandPermissionService");
    vi.spyOn(CommandPermissionService.prototype, "canUseAnyTarget").mockResolvedValue(true);
    const runMock = vi.fn().mockRejectedValue(new Error("dispatcher boom"));
    const { handler, restoreCommand } = await loadInteractionHandler(runMock as unknown as ReturnType<typeof vi.fn>);
    const interaction = makeCompoSlashInteraction();

    await handler(interaction);
    restoreCommand();

    expect(
      errorSpy.mock.calls.some((call) =>
        String(call[0] ?? "").includes("stage=handler_run_failed") &&
        String(call[0] ?? "").includes("dispatcher boom"),
      ),
    ).toBe(true);
    expect(
      logSpy.mock.calls.some((call) =>
        String(call[0] ?? "").includes("stage=before_handler_run") &&
        String(call[0] ?? "").includes("handler=compo.run"),
      ),
    ).toBe(true);
  }, 30000);
});
