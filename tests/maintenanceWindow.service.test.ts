import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MaintenanceRow = {
  guildId: string;
  active: boolean;
  detectedAt: Date | null;
  lastObservedAt: Date | null;
  lastOverAt: Date | null;
  detectedClanTag: string | null;
  detectedStatusCode: number | null;
  lastChannelId: string | null;
  lastChannelSource: "maintenance" | "generic" | null;
  createdAt: Date;
  updatedAt: Date;
};

const maintenanceStore = new Map<string, MaintenanceRow>();

const prismaMock = vi.hoisted(() => ({
  maintenanceWindowRuntimeState: {
    findUnique: vi.fn(async ({ where }: { where: { guildId: string } }) =>
      maintenanceStore.get(where.guildId) ?? null,
    ),
    upsert: vi.fn(async (input: any) => {
      const existing = maintenanceStore.get(input.where.guildId);
      const row: MaintenanceRow = {
        guildId: input.where.guildId,
        active: input.create.active ?? input.update.active ?? false,
        detectedAt:
          input.update.detectedAt !== undefined
            ? input.update.detectedAt
            : input.create.detectedAt ?? existing?.detectedAt ?? null,
        lastObservedAt:
          input.update.lastObservedAt !== undefined
            ? input.update.lastObservedAt
            : input.create.lastObservedAt ?? existing?.lastObservedAt ?? null,
        lastOverAt:
          input.update.lastOverAt !== undefined
            ? input.update.lastOverAt
            : input.create.lastOverAt ?? existing?.lastOverAt ?? null,
        detectedClanTag:
          input.update.detectedClanTag !== undefined
            ? input.update.detectedClanTag
            : input.create.detectedClanTag ?? existing?.detectedClanTag ?? null,
        detectedStatusCode:
          input.update.detectedStatusCode !== undefined
            ? input.update.detectedStatusCode
            : input.create.detectedStatusCode ?? existing?.detectedStatusCode ?? null,
        lastChannelId:
          input.update.lastChannelId !== undefined
            ? input.update.lastChannelId
            : input.create.lastChannelId ?? existing?.lastChannelId ?? null,
        lastChannelSource:
          input.update.lastChannelSource !== undefined
            ? input.update.lastChannelSource
            : input.create.lastChannelSource ?? existing?.lastChannelSource ?? null,
        createdAt: existing?.createdAt ?? new Date("2026-05-21T12:00:00.000Z"),
        updatedAt: new Date("2026-05-21T12:00:00.000Z"),
      };
      maintenanceStore.set(input.where.guildId, row);
      return row;
    }),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import { MaintenanceWindowService, isExplicitMaintenanceErrorForTest } from "../src/services/MaintenanceWindowService";

function makeChannel(send: ReturnType<typeof vi.fn>) {
  return {
    isTextBased: () => true,
    send,
  };
}

describe("MaintenanceWindowService", () => {
  beforeEach(() => {
    maintenanceStore.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("detects maintenance once, dedupes repeated failures, and posts recovery once across service instances", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const fetch = vi.fn().mockImplementation(async (channelId: string) => {
      if (channelId === "maintenance-channel") return makeChannel(send);
      if (channelId === "generic-channel") return makeChannel(send);
      return null;
    });
    const botLogChannels = {
      getChannelIdForType: vi.fn().mockResolvedValue("maintenance-channel"),
      getChannelId: vi.fn().mockResolvedValue("generic-channel"),
    };
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
    const firstService = new MaintenanceWindowService(
      { channels: { fetch } } as any,
      botLogChannels as any,
    );
    const secondService = new MaintenanceWindowService(
      { channels: { fetch } } as any,
      botLogChannels as any,
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await firstService.observeWarFetch({
      guildId: "guild-1",
      clanTag: "#ABC123",
      observation: { kind: "failure", statusCode: 503 },
      error: explicitMaintenanceError,
    });
    await secondService.observeWarFetch({
      guildId: "guild-1",
      clanTag: "#ABC123",
      observation: { kind: "failure", statusCode: 503 },
      error: explicitMaintenanceError,
    });
    await secondService.observeWarFetch({
      guildId: "guild-1",
      clanTag: "#ABC123",
      observation: { kind: "success" },
    });
    await secondService.observeWarFetch({
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
    expect(maintenanceStore.get("guild-1")?.active).toBe(false);
    expect(maintenanceStore.get("guild-1")?.detectedClanTag).toBe("#ABC123");
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
    expect(maintenanceStore.size).toBe(0);
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

    expect(
      warnSpy.mock.calls.some((call) =>
        String(call[0]).includes("event=skipped_no_channel"),
      ),
    ).toBe(true);
    expect(maintenanceStore.get("guild-1")?.active).toBe(true);
  });
});
