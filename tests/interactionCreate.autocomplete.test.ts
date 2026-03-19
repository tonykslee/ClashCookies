import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "discord.js";
import type { Command } from "../src/Command";

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

/** Purpose: register interactionCreate listener and return the bound interaction handler for tests. */
async function loadInteractionHandler() {
  const { default: registerInteractionCreate } = await import(
    "../src/listeners/interactionCreate"
  );
  const handlers = new Map<string, (interaction: unknown) => Promise<void>>();
  const client = {
    on: vi.fn((event: string, callback: (interaction: unknown) => Promise<void>) => {
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

describe("interactionCreate autocomplete dispatch", () => {
  it("dispatches autocomplete to the matching command handler", async () => {
    const { Commands } = await import("../src/Commands");
    const emojiCommand = Commands.find((cmd): cmd is Command => cmd.name === "emoji");
    if (!emojiCommand) throw new Error("Could not find /emoji command");

    const originalAutocomplete = emojiCommand.autocomplete;
    const autocompleteMock = vi.fn().mockResolvedValue(undefined);
    emojiCommand.autocomplete = autocompleteMock;

    const handler = await loadInteractionHandler();
    const interaction = {
      commandName: "emoji",
      isAutocomplete: () => true,
      respond: vi.fn().mockResolvedValue(undefined),
    };

    await handler(interaction as any);

    expect(autocompleteMock).toHaveBeenCalledWith(interaction);
    emojiCommand.autocomplete = originalAutocomplete;
  });

  it("responds with empty suggestions when command has no autocomplete handler", async () => {
    const handler = await loadInteractionHandler();
    const interaction = {
      commandName: "post",
      isAutocomplete: () => true,
      respond: vi.fn().mockResolvedValue(undefined),
    };

    await handler(interaction as any);

    expect(interaction.respond).toHaveBeenCalledWith([]);
  });
});
