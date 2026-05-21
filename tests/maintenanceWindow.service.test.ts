import { afterEach, describe, expect, it, vi } from "vitest";
import { MaintenanceWindowService, isExplicitMaintenanceErrorForTest } from "../src/services/MaintenanceWindowService";

function makeChannel(send: ReturnType<typeof vi.fn>) {
  return {
    isTextBased: () => true,
    send,
  };
}

describe("MaintenanceWindowService", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("detects maintenance once, dedupes repeated failures, and posts recovery once", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const fetch = vi
      .fn()
      .mockImplementation(async (channelId: string) => {
        if (channelId === "maintenance-channel") return makeChannel(send);
        if (channelId === "generic-channel") return makeChannel(send);
        return null;
      });
    const botLogChannels = {
      getChannelIdForType: vi.fn().mockResolvedValue("maintenance-channel"),
      getChannelId: vi.fn().mockResolvedValue("generic-channel"),
    };
    const service = new MaintenanceWindowService(
      { channels: { fetch } } as any,
      botLogChannels as any,
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const explicitMaintenanceError = {
      message: "CoC API error 503",
      status: 503,
      response: {
        status: 503,
        data: {
          message: "Service temporarily unavailable because of maintenance.",
        },
      },
    };

    await service.observeWarFetch({
      guildId: "guild-1",
      clanTag: "#ABC123",
      observation: { kind: "failure", statusCode: 503 },
      error: explicitMaintenanceError,
    });
    await service.observeWarFetch({
      guildId: "guild-1",
      clanTag: "#ABC123",
      observation: { kind: "failure", statusCode: 503 },
      error: explicitMaintenanceError,
    });
    await service.observeWarFetch({
      guildId: "guild-1",
      clanTag: "#ABC123",
      observation: { kind: "success" },
    });
    await service.observeWarFetch({
      guildId: "guild-1",
      clanTag: "#ABC123",
      observation: { kind: "success" },
    });

    expect(send).toHaveBeenCalledTimes(2);
    expect(String(send.mock.calls[0]?.[0]?.content ?? "")).toContain(
      "maintenance detected",
    );
    expect(String(send.mock.calls[1]?.[0]?.content ?? "")).toContain(
      "maintenance is over",
    );
    expect(logSpy.mock.calls.some((call) => String(call[0]).includes("event=detected"))).toBe(true);
    expect(logSpy.mock.calls.some((call) => String(call[0]).includes("event=over"))).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("falls back to the generic bot-log channel when the maintenance channel is unavailable", async () => {
    const genericSend = vi.fn().mockResolvedValue(undefined);
    const fetch = vi.fn().mockImplementation(async (channelId: string) => {
      if (channelId === "generic-channel") return makeChannel(genericSend);
      return null;
    });
    const botLogChannels = {
      getChannelIdForType: vi.fn().mockResolvedValue("maintenance-channel"),
      getChannelId: vi.fn().mockResolvedValue("generic-channel"),
    };
    const service = new MaintenanceWindowService(
      { channels: { fetch } } as any,
      botLogChannels as any,
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await service.observeWarFetch({
      guildId: "guild-1",
      clanTag: "#ABC123",
      observation: { kind: "failure", statusCode: 503 },
      error: {
        message: "CoC API error 503",
        status: 503,
        response: {
          status: 503,
          data: { message: "scheduled maintenance" },
        },
      },
    });

    expect(genericSend).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("ignores generic upstream failures without maintenance markers", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const fetch = vi.fn().mockResolvedValue(makeChannel(send));
    const botLogChannels = {
      getChannelIdForType: vi.fn().mockResolvedValue("maintenance-channel"),
      getChannelId: vi.fn().mockResolvedValue("generic-channel"),
    };
    const service = new MaintenanceWindowService(
      { channels: { fetch } } as any,
      botLogChannels as any,
    );

    await service.observeWarFetch({
      guildId: "guild-1",
      clanTag: "#ABC123",
      observation: { kind: "failure", statusCode: 500 },
      error: {
        message: "CoC API error 500",
        status: 500,
        response: {
          status: 500,
          data: { message: "internal server error" },
        },
      },
    });

    expect(send).not.toHaveBeenCalled();
    expect(
      isExplicitMaintenanceErrorForTest({
        error: {
          message: "CoC API error 500",
          status: 500,
          response: {
            status: 500,
            data: { message: "internal server error" },
          },
        },
        statusCode: 500,
      }),
    ).toBe(false);
  });

  it("logs skipped_no_channel when maintenance is detected but no bot-log destination exists", async () => {
    const fetch = vi.fn().mockResolvedValue(null);
    const botLogChannels = {
      getChannelIdForType: vi.fn().mockResolvedValue(null),
      getChannelId: vi.fn().mockResolvedValue(null),
    };
    const service = new MaintenanceWindowService(
      { channels: { fetch } } as any,
      botLogChannels as any,
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await service.observeWarFetch({
      guildId: "guild-1",
      clanTag: "#ABC123",
      observation: { kind: "failure", statusCode: 503 },
      error: {
        message: "CoC API error 503",
        status: 503,
        response: {
          status: 503,
          data: { message: "maintenance in progress" },
        },
      },
    });

    expect(warnSpy.mock.calls.some((call) => String(call[0]).includes("event=skipped_no_channel"))).toBe(true);
  });
});
