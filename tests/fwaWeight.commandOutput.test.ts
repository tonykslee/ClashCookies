import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  trackedClan: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
  },
  fwaClanCatalog: {
    findMany: vi.fn(),
  },
  fwaWeightAlertConfig: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
  clanWarHistory: {
    findFirst: vi.fn(),
  },
  apiUsage: {
    upsert: vi.fn(() => Promise.resolve(undefined)),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
  hasInitializedPrismaClient: () => false,
}));

import { Fwa } from "../src/commands/Fwa";
import { PointsSyncService } from "../src/services/PointsSyncService";

type WeightSubcommand = "weight-health" | "weight-alert";

function makeInteraction(params: {
  subcommand: WeightSubcommand;
  tag: string | null;
  visibility?: "private" | "public";
  afterDays?: number | null;
  enabled?: boolean | null;
  guildId?: string;
}) {
  const deferReply = vi.fn().mockResolvedValue(undefined);
  const editReply = vi.fn().mockResolvedValue(undefined);
  const interaction = {
    guildId: params.guildId ?? "guild-1",
    user: { id: "user-1" },
    memberPermissions: { has: vi.fn(() => true) },
    deferReply,
    editReply,
    inGuild: vi.fn(() => true),
    options: {
      getSubcommandGroup: vi.fn(() => null),
      getSubcommand: vi.fn(() => params.subcommand),
      getString: vi.fn((name: string) => {
        if (name === "tag") return params.tag;
        if (name === "visibility") return params.visibility ?? "private";
        if (name === "after-days") return params.afterDays ?? null;
        if (name === "enabled") return params.enabled ?? null;
        return null;
      }),
      getInteger: vi.fn((name: string) => name === "after-days" ? params.afterDays ?? null : null),
      getBoolean: vi.fn((name: string) => name === "enabled" ? params.enabled ?? null : null),
    },
  };
  return { interaction, editReply };
}

describe("/fwa persisted weight command output", () => {
  const now = new Date("2026-08-09T12:00:00.000Z");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.clearAllMocks();
    vi.spyOn(PointsSyncService.prototype, "findLatestSyncNum").mockResolvedValue(null);
    prismaMock.trackedClan.findFirst.mockResolvedValue({ name: "Alpha" });
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.fwaClanCatalog.findMany.mockResolvedValue([]);
    prismaMock.clanWarHistory.findFirst.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reads one explicit clan from persisted FwaClanCatalog data through weight-health", async () => {
    prismaMock.fwaClanCatalog.findMany.mockResolvedValue([
      { clanTag: "#ABC123", weightSubmitDate: new Date("2026-08-07T12:00:00.000Z") },
    ]);
    const { interaction, editReply } = makeInteraction({
      subcommand: "weight-health",
      tag: "abc123",
    });

    await Fwa.run({} as any, interaction as any, {} as any);

    expect(prismaMock.fwaClanCatalog.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.fwaClanCatalog.findMany).toHaveBeenCalledWith({
      where: { clanTag: { in: ["#ABC123"] } },
      select: { clanTag: true, weightSubmitDate: true },
    });
    expect(String(editReply.mock.calls[0]?.[0]?.content ?? "")).toContain("2d 0h ago ✅");
  });

  it("bulk-reads all tracked clans and classifies missing/null catalog data safely", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#AAA111", name: "Recent" },
      { tag: "#BBB222", name: "Outdated" },
      { tag: "#CCC333", name: "Severe" },
      { tag: "#DDD444", name: "Null Date" },
      { tag: "#EEE555", name: "Missing Row" },
    ]);
    prismaMock.fwaClanCatalog.findMany.mockResolvedValue([
      { clanTag: "#AAA111", weightSubmitDate: new Date("2026-08-08T12:00:00.000Z") },
      { clanTag: "#BBB222", weightSubmitDate: new Date("2026-08-01T12:00:00.000Z") },
      { clanTag: "#CCC333", weightSubmitDate: new Date("2026-07-01T12:00:00.000Z") },
      { clanTag: "#DDD444", weightSubmitDate: null },
    ]);
    const { interaction, editReply } = makeInteraction({
      subcommand: "weight-health",
      tag: null,
    });

    await Fwa.run({} as any, interaction as any, {} as any);

    expect(prismaMock.fwaClanCatalog.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.fwaClanCatalog.findMany).toHaveBeenCalledWith({
      where: {
        clanTag: { in: ["#AAA111", "#BBB222", "#CCC333", "#DDD444", "#EEE555"] },
      },
      select: { clanTag: true, weightSubmitDate: true },
    });
    const content = String(editReply.mock.calls[0]?.[0]?.content ?? "");
    expect(content).toContain("Recent (#AAA111)");
    expect(content).toContain("Outdated (#BBB222)");
    expect(content).toContain("Severe (#CCC333)");
    expect(content).toContain("Null Date (#DDD444) \u2014 unavailable");
    expect(content).toContain("Missing Row (#EEE555) \u2014 unavailable");
    expect(content).toContain("Summary: recent=1, outdated=1, severe=1, unknown=2");
    expect(content).toContain("\u2705");
    expect(content).toContain("\u26a0\ufe0f");
    expect(content).toContain("\u274c");
    expect(content).toContain("\u2753");
  });

  it("shows missing alert routing without making an external request", async () => {
    prismaMock.trackedClan.findFirst.mockResolvedValue({
      name: "Alpha",
      tag: "#ABC123",
      leaderChannelId: null,
      leadRoleId: "role-1",
    });
    prismaMock.fwaWeightAlertConfig.findUnique.mockResolvedValue(null);
    const { interaction, editReply } = makeInteraction({
      subcommand: "weight-alert",
      tag: "#ABC123",
    });

    await Fwa.run({} as any, interaction as any, {} as any);

    const content = String(editReply.mock.calls[0]?.[0]?.content ?? "");
    expect(content).toContain("not configured (disabled)");
    expect(content).toContain("Threshold: **not configured**");
    expect(content).toContain("Leader channel: not configured");
    expect(content).toContain("Lead role: <@&role-1> (configured)");
    expect(content).toContain("Routing readiness: **NOT READY**");
    expect(content).toContain("Automatic delivery is evaluated after successful fresh Clans.json catalog syncs.");
    expect(content).not.toContain("not enabled by this command yet");
  });

  it("sets a threshold and enables the alert by default", async () => {
    prismaMock.trackedClan.findFirst.mockResolvedValue({
      name: "Alpha",
      tag: "#ABC123",
      leaderChannelId: "channel-1",
      leadRoleId: "role-1",
    });
    prismaMock.fwaWeightAlertConfig.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        enabled: true,
        thresholdDays: 10,
        updatedByDiscordUserId: "user-1",
        createdAt: new Date("2026-08-09T00:00:00.000Z"),
        updatedAt: new Date("2026-08-09T00:00:00.000Z"),
      });
    const { interaction, editReply } = makeInteraction({
      subcommand: "weight-alert",
      tag: "ABC123",
      afterDays: 10,
    });

    await Fwa.run({} as any, interaction as any, {} as any);

    expect(prismaMock.fwaWeightAlertConfig.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ enabled: true, thresholdDays: 10 }),
      }),
    );
    expect(String(editReply.mock.calls[0]?.[0]?.content ?? "")).toContain(
      "State: **enabled**",
    );
    expect(String(editReply.mock.calls[0]?.[0]?.content ?? "")).toContain(
      "Threshold: **10 day(s)**",
    );
  });

  it("honors an explicit disable mutation", async () => {
    prismaMock.trackedClan.findFirst.mockResolvedValue({
      name: "Alpha",
      tag: "#ABC123",
      leaderChannelId: "channel-1",
      leadRoleId: "role-1",
    });
    prismaMock.fwaWeightAlertConfig.findUnique
      .mockResolvedValueOnce({ thresholdDays: 10, enabled: true })
      .mockResolvedValueOnce({
        enabled: false,
        thresholdDays: 10,
        updatedByDiscordUserId: "user-1",
        createdAt: new Date("2026-08-09T00:00:00.000Z"),
        updatedAt: new Date("2026-08-09T00:00:00.000Z"),
      });
    const { interaction, editReply } = makeInteraction({
      subcommand: "weight-alert",
      tag: "ABC123",
      enabled: false,
    });

    await Fwa.run({} as any, interaction as any, {} as any);

    expect(prismaMock.fwaWeightAlertConfig.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ enabled: false, thresholdDays: 10 }),
      }),
    );
    expect(String(editReply.mock.calls[0]?.[0]?.content ?? "")).toContain(
      "State: **disabled**",
    );
  });

  it("shows deterministic validation for an out-of-range threshold", async () => {
    const { interaction, editReply } = makeInteraction({
      subcommand: "weight-alert",
      tag: "ABC123",
      afterDays: 366,
    });

    await Fwa.run({} as any, interaction as any, {} as any);

    expect(String(editReply.mock.calls[0]?.[0]?.content ?? "")).toContain(
      "after-days must be an integer from 1 to 365",
    );
    expect(prismaMock.trackedClan.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.fwaWeightAlertConfig.upsert).not.toHaveBeenCalled();
  });
});
