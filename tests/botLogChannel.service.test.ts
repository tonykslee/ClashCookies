import { describe, expect, it } from "vitest";
import {
  BotLogChannelService,
} from "../src/services/BotLogChannelService";

function createSettingsStub() {
  const storage = new Map<string, string>();
  return {
    storage,
    settings: {
      get: async (key: string) => storage.get(key) ?? null,
      set: async (key: string, value: string) => {
        storage.set(key, value);
      },
      delete: async (key: string) => {
        storage.delete(key);
      },
    },
  };
}

describe("BotLogChannelService typed routing", () => {
  it("keeps the generic and base-swap channel settings separate", async () => {
    const stub = createSettingsStub();
    const service = new BotLogChannelService(stub.settings as any);

    await service.setChannelId("guild-1", "111111111111111111");
    await service.setChannelIdForType(
      "guild-1",
      "base-swap",
      "222222222222222222",
    );
    await service.setChannelIdForType(
      "guild-1",
      "sync",
      "333333333333333333",
    );
    await service.setChannelIdForType(
      "guild-1",
      "checklist",
      "444444444444444444",
    );

    expect(stub.storage.get("bot_logs_channel:guild-1")).toBe(
      "111111111111111111",
    );
    expect(stub.storage.get("bot_logs_channel:guild-1:base-swap")).toBe(
      "222222222222222222",
    );
    expect(stub.storage.get("bot_logs_channel:guild-1:sync")).toBe(
      "333333333333333333",
    );
    expect(stub.storage.get("bot_logs_channel:guild-1:checklist")).toBe(
      "444444444444444444",
    );
    expect(await service.getChannelId("guild-1")).toBe("111111111111111111");
    expect(await service.getChannelIdForType("guild-1", "base-swap")).toBe(
      "222222222222222222",
    );
    expect(await service.getChannelIdForType("guild-1", "sync")).toBe(
      "333333333333333333",
    );
    expect(await service.getChannelIdForType("guild-1", "checklist")).toBe(
      "444444444444444444",
    );

    await service.clearChannelIdForType("guild-1", "base-swap");

    expect(stub.storage.get("bot_logs_channel:guild-1")).toBe(
      "111111111111111111",
    );
    expect(stub.storage.get("bot_logs_channel:guild-1:base-swap")).toBeUndefined();
    expect(stub.storage.get("bot_logs_channel:guild-1:sync")).toBe(
      "333333333333333333",
    );
    expect(stub.storage.get("bot_logs_channel:guild-1:checklist")).toBe(
      "444444444444444444",
    );
    expect(await service.getChannelId("guild-1")).toBe("111111111111111111");
    expect(await service.getChannelIdForType("guild-1", "base-swap")).toBeNull();
  });

  it("keeps routed ban-log settings separate from the typed bot-log channels", async () => {
    const stub = createSettingsStub();
    const service = new BotLogChannelService(stub.settings as any);

    await service.setRoutingConfigForType({
      guildId: "guild-1",
      type: "ban-log",
      routingMode: "BOT_LOG",
    });
    await service.setRoutingConfigForType({
      guildId: "guild-1",
      type: "ban-join-alert",
      routingMode: "CUSTOM",
      channelId: "555555555555555555",
    });

    expect(stub.storage.get("bot_logs_routing:guild-1:ban-log")).toBe(
      JSON.stringify({ routingMode: "BOT_LOG", channelId: null }),
    );
    expect(stub.storage.get("bot_logs_routing:guild-1:ban-join-alert")).toBe(
      JSON.stringify({ routingMode: "CUSTOM", channelId: "555555555555555555" }),
    );
    await expect(service.getRoutingConfigForType("guild-1", "ban-log")).resolves.toEqual({
      routingMode: "BOT_LOG",
      channelId: null,
      legacy: false,
      configured: true,
    });
    await expect(service.getRoutingConfigForType("guild-1", "ban-join-alert")).resolves.toEqual({
      routingMode: "CUSTOM",
      channelId: "555555555555555555",
      legacy: false,
      configured: true,
    });
  });

  it("defaults ban-log to disabled and ban-join-alert to clan-lead when unset", async () => {
    const stub = createSettingsStub();
    const service = new BotLogChannelService(stub.settings as any);

    await expect(service.getRoutingConfigForType("guild-1", "ban-log")).resolves.toEqual({
      routingMode: "DISABLED",
      channelId: null,
      legacy: false,
      configured: false,
    });
    await expect(service.getRoutingConfigForType("guild-1", "ban-join-alert")).resolves.toEqual({
      routingMode: "CLAN_LEAD",
      channelId: null,
      legacy: false,
      configured: false,
    });
  });

  it("persists base-swap routing config separately from legacy typed channels", async () => {
    const stub = createSettingsStub();
    const service = new BotLogChannelService(stub.settings as any);

    await service.setBaseSwapRoutingConfig({
      guildId: "guild-1",
      routingMode: "CLAN_LOG",
    });

    expect(stub.storage.get("bot_logs_base_swap_routing:guild-1")).toBe(
      JSON.stringify({ routingMode: "CLAN_LOG", channelId: null }),
    );
    await expect(service.getBaseSwapRoutingConfig("guild-1")).resolves.toEqual({
      routingMode: "CLAN_LOG",
      channelId: null,
      legacy: false,
    });

    await service.setBaseSwapRoutingConfig({
      guildId: "guild-1",
      routingMode: "CUSTOM",
      channelId: "333333333333333333",
    });
    await expect(service.getBaseSwapRoutingConfig("guild-1")).resolves.toEqual({
      routingMode: "CUSTOM",
      channelId: "333333333333333333",
      legacy: false,
    });

    await service.clearBaseSwapRoutingConfig("guild-1");

    expect(stub.storage.get("bot_logs_base_swap_routing:guild-1")).toBeUndefined();
    await expect(service.getBaseSwapRoutingConfig("guild-1")).resolves.toBeNull();
  });

  it("treats legacy typed base-swap channels as custom routing until explicit config exists", async () => {
    const stub = createSettingsStub();
    const service = new BotLogChannelService(stub.settings as any);

    await service.setChannelIdForType(
      "guild-1",
      "base-swap",
      "222222222222222222",
    );

    await expect(service.getBaseSwapRoutingConfig("guild-1")).resolves.toEqual({
      routingMode: "CUSTOM",
      channelId: "222222222222222222",
      legacy: true,
    });

    await service.setBaseSwapRoutingConfig({
      guildId: "guild-1",
      routingMode: "DISABLED",
    });

    await expect(service.getBaseSwapRoutingConfig("guild-1")).resolves.toEqual({
      routingMode: "DISABLED",
      channelId: null,
      legacy: false,
    });
  });
});
