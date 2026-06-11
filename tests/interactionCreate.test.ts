import type { ChatInputCommandInteraction, Client } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Command } from "../src/Command";
import {
  buildLinkListRefreshButtonCustomId,
} from "../src/commands/Link";

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
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { CommandPermissionService } = await import("../src/services/CommandPermissionService");
    vi.spyOn(CommandPermissionService.prototype, "canUseAnyTarget").mockResolvedValue(true);
    const runMock = vi.fn().mockResolvedValue(undefined);
    const { handler, restoreCommand } = await loadInteractionHandler(runMock as unknown as ReturnType<typeof vi.fn>);
    const interaction = makeCompoSlashInteraction();

    await handler(interaction);
    restoreCommand();

    expect(
      infoSpy.mock.calls.some((call) =>
        String(call[0] ?? "").includes("stage=compo_module_loaded"),
      ),
    ).toBe(true);
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(
      logSpy.mock.calls.some((call) =>
        String(call[0] ?? "").includes("stage=before_handler_run") &&
        String(call[0] ?? "").includes("handler=compo.run") &&
        String(call[0] ?? "").includes("runFnType=function") &&
        String(call[0] ?? "").includes("handlerKeys="),
      ),
    ).toBe(true);
    expect(
      logSpy.mock.calls.some((call) =>
        String(call[0] ?? "").includes("stage=after_handler_run") &&
        String(call[0] ?? "").includes("handler=compo.run") &&
        String(call[0] ?? "").includes("runFnType=function"),
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

  it("logs handler_run watchdog checkpoints while /compo stays pending", async () => {
    vi.useFakeTimers();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { CommandPermissionService } = await import("../src/services/CommandPermissionService");
    vi.spyOn(CommandPermissionService.prototype, "canUseAnyTarget").mockResolvedValue(true);
    let resolveRun!: () => void;
    const runPromise = new Promise<void>((resolve) => {
      resolveRun = resolve;
    });
    const runMock = vi.fn().mockReturnValue(runPromise);
    const { handler, restoreCommand } = await loadInteractionHandler(runMock as unknown as ReturnType<typeof vi.fn>);
    const interaction = makeCompoSlashInteraction();

    try {
      const handlerPromise = handler(interaction);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(3000);
      expect(
        logSpy.mock.calls.some((call) =>
          String(call[0] ?? "").includes("stage=handler_run_begin") &&
          String(call[0] ?? "").includes("handler=compo.run"),
        ),
      ).toBe(true);
      expect(
        logSpy.mock.calls.some((call) =>
          String(call[0] ?? "").includes("stage=handler_run_still_running") &&
          String(call[0] ?? "").includes("thresholdMs=3000"),
        ),
      ).toBe(true);

      await vi.advanceTimersByTimeAsync(5000);
      expect(
        logSpy.mock.calls.some((call) =>
          String(call[0] ?? "").includes("stage=handler_run_still_running") &&
          String(call[0] ?? "").includes("thresholdMs=8000"),
        ),
      ).toBe(true);

      await vi.advanceTimersByTimeAsync(7000);
      expect(
        logSpy.mock.calls.some((call) =>
          String(call[0] ?? "").includes("stage=handler_run_still_running") &&
          String(call[0] ?? "").includes("thresholdMs=15000"),
        ),
      ).toBe(true);

      resolveRun();
      await handlerPromise;
      restoreCommand();

      expect(
        logSpy.mock.calls.some((call) =>
          String(call[0] ?? "").includes("stage=handler_run_done") &&
          String(call[0] ?? "").includes("handler=compo.run"),
        ),
      ).toBe(true);
      expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining("handler_run_failed"));
    } finally {
      vi.useRealTimers();
    }
  }, 30000);
});

describe("interactionCreate /link list refresh button routing", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes refresh buttons to the button handler and not the select handler", async () => {
    const LinkModule = await import("../src/commands/Link");
    const refreshSpy = vi
      .spyOn(LinkModule, "handleLinkListRefreshButton")
      .mockResolvedValue(undefined);
    const selectSpy = vi
      .spyOn(LinkModule, "handleLinkListSelectMenu")
      .mockResolvedValue(undefined);
    const columnsSpy = vi
      .spyOn(LinkModule, "handleLinkListColumnsSelectMenu")
      .mockResolvedValue(undefined);

    const { handler } = await loadInteractionHandler(
      vi.fn().mockResolvedValue(undefined),
    );
    const interaction = {
      customId: buildLinkListRefreshButtonCustomId(
        "111111111111111111",
        "#PQL0289",
        "discord",
      ),
      isAutocomplete: () => false,
      isButton: () => true,
      isStringSelectMenu: () => false,
      isUserSelectMenu: () => false,
      isModalSubmit: () => false,
      isChatInputCommand: () => false,
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      deferred: false,
      replied: false,
      reply: vi.fn().mockResolvedValue(undefined),
      deferUpdate: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      followUp: vi.fn().mockResolvedValue(undefined),
    };

    await handler(interaction as any);

    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(selectSpy).not.toHaveBeenCalled();
    expect(columnsSpy).not.toHaveBeenCalled();
  }, 30000);
});

describe("interactionCreate /link list columns select menu routing", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes columns select menus to the button handler and not the clan select handler", async () => {
    const LinkModule = await import("../src/commands/Link");
    const columnsSpy = vi
      .spyOn(LinkModule, "handleLinkListColumnsSelectMenu")
      .mockResolvedValue(undefined);
    const selectSpy = vi
      .spyOn(LinkModule, "handleLinkListSelectMenu")
      .mockResolvedValue(undefined);

    const { handler } = await loadInteractionHandler(
      vi.fn().mockResolvedValue(undefined),
    );
    const interaction = {
      customId: LinkModule.buildLinkListColumnsSelectCustomIdForTest(
        "111111111111111111",
        "#PQL0289",
        "discord",
        ["townhall", "player-name"],
      ),
      isAutocomplete: () => false,
      isButton: () => false,
      isStringSelectMenu: () => true,
      isUserSelectMenu: () => false,
      isModalSubmit: () => false,
      isChatInputCommand: () => false,
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      deferred: false,
      replied: false,
      values: ["weight"],
      reply: vi.fn().mockResolvedValue(undefined),
      deferUpdate: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      followUp: vi.fn().mockResolvedValue(undefined),
    };

    await handler(interaction as any);

    expect(columnsSpy).toHaveBeenCalledTimes(1);
    expect(selectSpy).not.toHaveBeenCalled();
  }, 30000);
});

describe("interactionCreate /sync time FWA clan list refresh routing", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes the refresh button to the sync-time FWA clan list handler", async () => {
    const SyncTimeModule = await import(
      "../src/services/SyncTimeFwaClanListViewService"
    );
    const refreshSpy = vi
      .spyOn(SyncTimeModule, "handleSyncTimeFwaClanListRefreshButton")
      .mockResolvedValue(undefined);

    const { handler } = await loadInteractionHandler();
    const interaction = {
      customId: SyncTimeModule.SYNC_TIME_FWA_CLAN_LIST_REFRESH_BUTTON_CUSTOM_ID,
      isAutocomplete: () => false,
      isButton: () => true,
      isStringSelectMenu: () => false,
      isUserSelectMenu: () => false,
      isModalSubmit: () => false,
      isChatInputCommand: () => false,
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      deferred: false,
      replied: false,
      reply: vi.fn().mockResolvedValue(undefined),
      deferUpdate: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      followUp: vi.fn().mockResolvedValue(undefined),
      message: {
        id: "sync-message-1",
        edit: vi.fn().mockResolvedValue(undefined),
      },
      inGuild: () => true,
    };

    await handler(interaction as any);

    expect(refreshSpy).toHaveBeenCalledTimes(1);
  }, 30000);
});
