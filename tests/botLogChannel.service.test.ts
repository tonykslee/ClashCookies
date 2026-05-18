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

    expect(stub.storage.get("bot_logs_channel:guild-1")).toBe(
      "111111111111111111",
    );
    expect(stub.storage.get("bot_logs_channel:guild-1:base-swap")).toBe(
      "222222222222222222",
    );
    expect(await service.getChannelId("guild-1")).toBe("111111111111111111");
    expect(await service.getChannelIdForType("guild-1", "base-swap")).toBe(
      "222222222222222222",
    );

    await service.clearChannelIdForType("guild-1", "base-swap");

    expect(stub.storage.get("bot_logs_channel:guild-1")).toBe(
      "111111111111111111",
    );
    expect(stub.storage.get("bot_logs_channel:guild-1:base-swap")).toBeUndefined();
    expect(await service.getChannelId("guild-1")).toBe("111111111111111111");
    expect(await service.getChannelIdForType("guild-1", "base-swap")).toBeNull();
  });
});
