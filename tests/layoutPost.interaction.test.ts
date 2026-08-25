import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "discord.js";

describe("interactionCreate layout post routing", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("routes persistent layout buttons through the shared layout handler", async () => {
    const layoutPostModule = await import("../src/services/LayoutPostService");
    const layoutHandler = vi
      .spyOn(layoutPostModule, "handleLayoutButtonInteraction")
      .mockResolvedValue(undefined);
    const { default: registerInteractionCreate } = await import(
      "../src/listeners/interactionCreate"
    );
    const handlers = new Map<string, (interaction: any) => Promise<void>>();
    const client = {
      on: vi.fn((event: string, callback: (interaction: any) => Promise<void>) => {
        handlers.set(event, callback);
      }),
    } as unknown as Client;

    registerInteractionCreate(client, {} as any);
    const handler = handlers.get("interactionCreate");
    if (!handler) throw new Error("interactionCreate listener was not registered");

    const interaction = {
      customId: layoutPostModule.buildLayoutPostCustomId("info", "layout-1"),
      isAutocomplete: () => false,
      isButton: () => true,
      isUserSelectMenu: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      isChatInputCommand: () => false,
      deferred: false,
      replied: false,
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await handler(interaction);

    expect(layoutHandler).toHaveBeenCalledTimes(1);
    expect(layoutHandler).toHaveBeenCalledWith(interaction);
  }, 30000);
});

