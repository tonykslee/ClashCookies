import { describe, expect, it, vi } from "vitest";
import { LayoutAlertMode } from "@prisma/client";
import {
  LayoutAlertConfigService,
  LayoutAlertPolicyValidationError,
  formatLayoutAlertPolicyLine,
  parseLayoutAlertType,
  validateLayoutAlertCommandOptions,
} from "../src/services/LayoutAlertConfigService";

function buildLayout(overrides: Record<string, unknown> = {}) {
  return {
    id: "layout-1",
    layoutLink: "https://link.clashofclans.com/en?action=OpenLayout&id=TH18%3AWB%3APAYLOAD18",
    title: null,
    description: null,
    imageUrl: null,
    postedByDiscordUserId: "user-1",
    discordGuildId: "guild-1",
    discordChannelId: "channel-1",
    discordMessageId: "message-1",
    submittedAt: new Date("2026-08-01T00:00:00.000Z"),
    lastConfirmedAt: null,
    lastConfirmedByDiscordUserId: null,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  } as any;
}

function makeDb(layout = buildLayout()) {
  return {
    layoutRecord: { findUnique: vi.fn().mockResolvedValue(layout) },
    layoutAlertConfig: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockImplementation(async (input) => ({
        layoutId: input.where.layoutId,
        mode: input.create.mode,
        customChannelId: input.create.customChannelId,
      })),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
}

describe("LayoutAlertConfigService", () => {
  it("parses the shared command choices and omits policy when disabled", async () => {
    expect(parseLayoutAlertType(" DM ")).toBe("dm");
    expect(parseLayoutAlertType(null)).toBeNull();
    expect(() => parseLayoutAlertType("email")).toThrow(LayoutAlertPolicyValidationError);

    const db = makeDb();
    const service = new LayoutAlertConfigService({ db: db as any });
    expect(await service.getPolicy("layout-1")).toBeNull();
    await service.disablePolicy("layout-1");
    expect(db.layoutAlertConfig.deleteMany).toHaveBeenCalledWith({ where: { layoutId: "layout-1" } });
  });

  it.each([
    [LayoutAlertMode.DM, null],
    [LayoutAlertMode.DEFAULT_CHANNEL, null],
    [LayoutAlertMode.BOTH, null],
    [LayoutAlertMode.CUSTOM_CHANNEL, "777777777777777777"],
  ])("stores the structural policy shape for %s", async (mode, customChannelId) => {
    const db = makeDb();
    const service = new LayoutAlertConfigService({ db: db as any });
    await service.setPolicy({ layoutId: "layout-1", mode, customChannelId });
    expect(db.layoutAlertConfig.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ layoutId: "layout-1", mode, customChannelId }),
      update: expect.objectContaining({ mode, customChannelId }),
    }));
  });

  it("requires a custom channel only for custom-channel mode", async () => {
    const db = makeDb();
    const service = new LayoutAlertConfigService({ db: db as any });
    await expect(service.setPolicy({ layoutId: "layout-1", mode: LayoutAlertMode.CUSTOM_CHANNEL }))
      .rejects.toThrow("require a Discord channel");
    await expect(service.setPolicy({
      layoutId: "layout-1",
      mode: LayoutAlertMode.DM,
      customChannelId: "777777777777777777",
    })).rejects.toThrow("Only custom-channel");
    expect(db.layoutAlertConfig.upsert).not.toHaveBeenCalled();
  });

  it("requires canonical provenance and a recorded poster for DM policies", async () => {
    const legacyDb = makeDb(buildLayout({ discordMessageId: null }));
    const legacyService = new LayoutAlertConfigService({ db: legacyDb as any });
    await expect(legacyService.setPolicy({ layoutId: "layout-1", mode: LayoutAlertMode.DEFAULT_CHANNEL }))
      .rejects.toThrow("canonical Discord layout post");

    const noPosterDb = makeDb(buildLayout({ postedByDiscordUserId: null }));
    const noPosterService = new LayoutAlertConfigService({ db: noPosterDb as any });
    await expect(noPosterService.setPolicy({ layoutId: "layout-1", mode: LayoutAlertMode.BOTH }))
      .rejects.toThrow("This legacy layout has no recorded poster");
  });

  it("validates command routing scope before persistence", () => {
    expect(() => validateLayoutAlertCommandOptions({
      type: "custom-channel",
      channel: { id: "1", guildId: "other", type: 0 },
      guildId: "guild-1",
    })).toThrow("same server");
    expect(() => validateLayoutAlertCommandOptions({
      type: "default-channel",
      channel: null,
      guildId: "guild-1",
      defaultChannelId: null,
    })).toThrow("No layout-alerts channel");
  });

  it("renders effective routing without persisting a copied default channel", () => {
    const policy = { mode: LayoutAlertMode.BOTH, customChannelId: null } as any;
    expect(formatLayoutAlertPolicyLine(policy, "123")).toBe("Expiration alert: DM + <#123>");
    expect(formatLayoutAlertPolicyLine(policy, null)).toContain("Default channel not configured");
    expect(formatLayoutAlertPolicyLine({ mode: LayoutAlertMode.CUSTOM_CHANNEL, customChannelId: "456" } as any))
      .toBe("Expiration alert: <#456>");
  });
});
