import { describe, expect, it } from "vitest";
import {
  BotLogChannelService,
  type BotLogChannelType,
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
      "base-swap" as BotLogChannelType,
      "222222222222222222",
    );
    await service.setChannelIdForType(
      "guild-1",
      "sync" as BotLogChannelType,
      "333333333333333333",
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
    expect(await service.getChannelId("guild-1")).toBe("111111111111111111");
    expect(await service.getChannelIdForType("guild-1", "base-swap")).toBe(
      "222222222222222222",
    );
    expect(await service.getChannelIdForType("guild-1", "sync")).toBe(
      "333333333333333333",
    );

    await service.clearChannelIdForType("guild-1", "base-swap");

    expect(stub.storage.get("bot_logs_channel:guild-1")).toBe(
      "111111111111111111",
    );
    expect(stub.storage.get("bot_logs_channel:guild-1:base-swap")).toBeUndefined();
    expect(stub.storage.get("bot_logs_channel:guild-1:sync")).toBe(
      "333333333333333333",
    );
    expect(await service.getChannelId("guild-1")).toBe("111111111111111111");
    expect(await service.getChannelIdForType("guild-1", "base-swap")).toBeNull();
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
      "base-swap" as BotLogChannelType,
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
