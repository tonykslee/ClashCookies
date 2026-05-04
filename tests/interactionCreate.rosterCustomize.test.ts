import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "discord.js";
import { handleRosterPostCustomizeMenuInteraction } from "../src/commands/Roster";

vi.mock("../src/commands/Roster", async () => {
  const actual = await vi.importActual<typeof import("../src/commands/Roster")>(
    "../src/commands/Roster",
  );
  return {
    ...actual,
    handleRosterPostCustomizeMenuInteraction: vi.fn(async () => {
      throw new Error("boom");
    }),
  };
});

type ListenerHandler = (interaction: unknown) => Promise<void>;

async function loadInteractionHandler(): Promise<ListenerHandler> {
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
  return handler;
}

function makeRosterCustomizeInteraction() {
  return {
    customId: "roster-post-customize:columns:roster-1",
    values: ["player_name"],
    deferred: false,
    replied: false,
    isAutocomplete: () => false,
    isButton: () => false,
    isChatInputCommand: () => false,
    isModalSubmit: () => false,
    isStringSelectMenu: () => true,
    isUserSelectMenu: () => false,
    inGuild: () => true,
    guildId: "guild-1",
    user: { id: "user-1", tag: "tester#0001" },
    memberPermissions: {
      has: () => true,
    },
    reply: vi.fn().mockRejectedValue(Object.assign(new Error("Unknown interaction"), { code: 10062 })),
    followUp: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
  };
}

describe("interactionCreate roster customize fallback", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("swallows fallback reply failures when the roster customize interaction already expired", async () => {
    const handler = await loadInteractionHandler();
    const interaction = makeRosterCustomizeInteraction();

    await expect(handler(interaction as any)).resolves.toBeUndefined();

    expect(interaction.reply).toHaveBeenCalled();
    expect(interaction.followUp).not.toHaveBeenCalled();
  }, 30000);

  it("returns without attempting a fallback response when the select interaction already expired", async () => {
    vi.mocked(handleRosterPostCustomizeMenuInteraction).mockRejectedValueOnce(
      Object.assign(new Error("Unknown interaction"), { code: 10062 }),
    );
    const handler = await loadInteractionHandler();
    const interaction = makeRosterCustomizeInteraction();
    interaction.reply = vi.fn().mockResolvedValue(undefined);
    interaction.followUp = vi.fn().mockResolvedValue(undefined);

    await expect(handler(interaction as any)).resolves.toBeUndefined();

    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.followUp).not.toHaveBeenCalled();
  }, 30000);
});
