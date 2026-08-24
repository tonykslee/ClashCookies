import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  trackedClan: { findFirst: vi.fn() },
  fwaWeightAlertConfig: { findUnique: vi.fn(), upsert: vi.fn() },
}));

vi.mock("../src/prisma", () => ({ prisma: prismaMock }));

import {
  DEFAULT_FWA_WEIGHT_ALERT_THRESHOLD_DAYS,
  FwaWeightAlertConfigService,
} from "../src/services/FwaWeightAlertConfigService";

describe("FwaWeightAlertConfigService", () => {
  const service = new FwaWeightAlertConfigService();
  const tracked = {
    tag: "#ABC123",
    name: "Alpha",
    leaderChannelId: "channel-1",
    leadRoleId: "role-1",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.trackedClan.findFirst.mockResolvedValue(tracked);
    prismaMock.fwaWeightAlertConfig.findUnique.mockResolvedValue(null);
    prismaMock.fwaWeightAlertConfig.upsert.mockResolvedValue(undefined);
  });

  it("shows an unconfigured alert as disabled and reports routing readiness", async () => {
    const result = await service.getStatus("abc123");
    expect(result).toMatchObject({
      clanTag: "#ABC123",
      config: null,
      routingReady: true,
      leaderChannelId: "channel-1",
      leadRoleId: "role-1",
    });
  });

  it("sets a threshold and enables unless explicitly disabled", async () => {
    const resultConfig = {
      enabled: false,
      thresholdDays: 10,
      updatedByDiscordUserId: "user-1",
      createdAt: new Date("2026-08-24T00:00:00.000Z"),
      updatedAt: new Date("2026-08-24T00:00:00.000Z"),
    };
    prismaMock.fwaWeightAlertConfig.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(resultConfig);
    await service.update("#ABC123", "user-1", { thresholdDays: 10, enabled: false });
    expect(prismaMock.fwaWeightAlertConfig.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ enabled: false, thresholdDays: 10 }),
        update: expect.objectContaining({ enabled: false, thresholdDays: 10 }),
      }),
    );
  });

  it("uses the default threshold when explicitly enabled without an existing threshold", async () => {
    const resultConfig = {
      enabled: true,
      thresholdDays: DEFAULT_FWA_WEIGHT_ALERT_THRESHOLD_DAYS,
      updatedByDiscordUserId: "user-1",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    prismaMock.fwaWeightAlertConfig.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(resultConfig);
    await service.update("#ABC123", "user-1", { enabled: true });
    expect(prismaMock.fwaWeightAlertConfig.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ enabled: true, thresholdDays: 7 }),
      }),
    );
  });

  it.each([0, 366, 1.5])("rejects an invalid threshold %s", async (thresholdDays) => {
    await expect(
      service.update("#ABC123", "user-1", { thresholdDays }),
    ).rejects.toThrow("after-days must be an integer from 1 to 365");
    expect(prismaMock.fwaWeightAlertConfig.upsert).not.toHaveBeenCalled();
  });

  it("persists explicit enable and disable changes", async () => {
    prismaMock.fwaWeightAlertConfig.findUnique
      .mockResolvedValueOnce({ thresholdDays: 12, enabled: true })
      .mockResolvedValueOnce({
        enabled: false,
        thresholdDays: 12,
        updatedByDiscordUserId: "user-1",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    await service.update("#ABC123", "user-1", { enabled: false });
    expect(prismaMock.fwaWeightAlertConfig.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ enabled: false, thresholdDays: 12 }) }),
    );
  });
});
