import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  trackedClan: {
    findMany: vi.fn(),
  },
  clanWarHistory: {
    findFirst: vi.fn(),
  },
  apiUsage: {
    upsert: vi.fn(() => Promise.resolve(undefined)),
  },
}));

const fwaPoliceServiceMock = vi.hoisted(() => ({
  setClanConfig: vi.fn(),
  getStatusReport: vi.fn(),
  sendSampleMessage: vi.fn(),
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
  hasInitializedPrismaClient: () => false,
}));

vi.mock("../src/services/FwaPoliceService", () => ({
  fwaPoliceService: fwaPoliceServiceMock,
}));

import { Fwa } from "../src/commands/Fwa";
import { PointsSyncService } from "../src/services/PointsSyncService";

function makeInteraction(input: {
  subcommand: string;
  clan?: string | null;
  violation?: string;
  show?: "DM" | "LOG";
  enableDm?: boolean;
  enableLog?: boolean;
  isAdmin?: boolean;
}) {
  const deferReply = vi.fn().mockResolvedValue(undefined);
  const editReply = vi.fn().mockResolvedValue(undefined);
  const interaction = {
    id: "interaction-1",
    guildId: "guild-1",
    channelId: "channel-1",
    user: { id: "111111111111111111" },
    client: {},
    memberPermissions: {
      has: vi.fn(() => input.isAdmin ?? true),
    },
    deferReply,
    editReply,
    inGuild: vi.fn(() => true),
    options: {
      getSubcommandGroup: vi.fn(() => "police"),
      getSubcommand: vi.fn(() => input.subcommand),
      getString: vi.fn((name: string) => {
        if (name === "visibility") return null;
        if (name === "clan") return input.clan ?? null;
        if (name === "violation") return input.violation ?? null;
        if (name === "show") return input.show ?? null;
        if (name === "tag") return null;
        return null;
      }),
      getBoolean: vi.fn((name: string) => {
        if (name === "enable-dm") return input.enableDm ?? null;
        if (name === "enable-log") return input.enableLog ?? null;
        return null;
      }),
    },
  };
  return { interaction, editReply };
}

describe("/fwa police command output", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(PointsSyncService.prototype, "findLatestSyncNum").mockResolvedValue(
      null,
    );
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.clanWarHistory.findFirst.mockResolvedValue(null);
    fwaPoliceServiceMock.getStatusReport.mockResolvedValue({
      ok: true,
      report: {
        scope: "guild",
        policeEnabled: true,
        dmEnabled: true,
        logEnabled: true,
        storedPoliceLogChannelOverrideId: null,
        storedBotLogChannelId: "bot-log-1",
        storedBotLogChannelHealth: "ok",
        fallbackBehavior:
          "tracked-clan log-channel when configured, otherwise /bot-logs fallback, otherwise unresolved",
        enabledViolationTypes: [
          "EARLY_NON_MIRROR_TRIPLE",
          "STRICT_WINDOW_MIRROR_MISS_WIN",
        ],
        trackedClanSummary: {
          total: 2,
          policeEnabled: 2,
          dmEnabled: 2,
          logEnabled: 2,
          withTrackedLogChannel: 1,
          logEnabledWithoutTrackedLogChannel: 1,
        },
        clan: null,
        warnings: [],
      },
    });
    fwaPoliceServiceMock.sendSampleMessage.mockResolvedValue({
      ok: true,
      deliveredTo: "DM",
      rendered: "sample",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders guild police status with effective fallback details", async () => {
    const run = makeInteraction({
      subcommand: "status",
    });
    await Fwa.run({} as any, run.interaction as any, {} as any);

    expect(fwaPoliceServiceMock.getStatusReport).toHaveBeenCalledWith({
      client: run.interaction.client,
      guildId: "guild-1",
      clanTag: null,
    });
    const content = String(run.editReply.mock.calls[0]?.[0]?.content ?? "");
    expect(content).toContain("FWA Police status (guild scope)");
    expect(content).toContain("FWA Police enabled: yes");
    expect(content).toContain("DM sending enabled: yes");
    expect(content).toContain("Stored /bot-logs fallback: <#bot-log-1> (ok)");
  });

  it("renders clan-scoped status and warnings when resolved channel is unavailable", async () => {
    fwaPoliceServiceMock.getStatusReport.mockResolvedValue({
      ok: true,
      report: {
        scope: "clan",
        policeEnabled: true,
        dmEnabled: true,
        logEnabled: true,
        storedPoliceLogChannelOverrideId: null,
        storedBotLogChannelId: "bot-log-1",
        storedBotLogChannelHealth: "ok",
        fallbackBehavior:
          "tracked-clan log-channel when configured, otherwise /bot-logs fallback, otherwise unresolved",
        enabledViolationTypes: ["EARLY_NON_MIRROR_TRIPLE"],
        trackedClanSummary: {
          total: 1,
          policeEnabled: 1,
          dmEnabled: 1,
          logEnabled: 1,
          withTrackedLogChannel: 1,
          logEnabledWithoutTrackedLogChannel: 0,
        },
        clan: {
          clanTag: "#2QG2C08UP",
          clanName: "Alpha",
          policeEnabled: true,
          dmEnabled: true,
          logEnabled: true,
          storedTrackedLogChannelId: "clan-log-1",
          storedTrackedLogChannelHealth: "missing_or_inaccessible",
          effectiveLogChannelId: "clan-log-1",
          effectiveLogChannelSource: "tracked_clan",
          effectiveLogChannelHealth: "missing_or_inaccessible",
        },
        warnings: ["Effective log destination <#clan-log-1> is missing or inaccessible."],
      },
    });

    const run = makeInteraction({
      subcommand: "status",
      clan: "#2QG2C08UP",
    });
    await Fwa.run({} as any, run.interaction as any, {} as any);

    const content = String(run.editReply.mock.calls[0]?.[0]?.content ?? "");
    expect(content).toContain("FWA Police status (clan scope)");
    expect(content).toContain("Clan: Alpha (#2QG2C08UP)");
    expect(content).toContain("Warnings:");
    expect(content).toContain("missing or inaccessible");
  });

  it("requires administrator permissions for police status", async () => {
    const run = makeInteraction({
      subcommand: "status",
      isAdmin: false,
    });
    await Fwa.run({} as any, run.interaction as any, {} as any);

    expect(fwaPoliceServiceMock.getStatusReport).not.toHaveBeenCalled();
    const content = String(run.editReply.mock.calls[0]?.[0]?.content ?? "");
    expect(content).toContain("Only administrators can use `/fwa police status`.");
  });

  it("renders configure summary and persists toggle values", async () => {
    fwaPoliceServiceMock.setClanConfig.mockResolvedValue({
      clanTag: "#2QG2C08UP",
      clanName: "Alpha",
      enableDm: true,
      enableLog: false,
    });

    const run = makeInteraction({
      subcommand: "configure",
      clan: "2QG2C08UP",
      enableDm: true,
      enableLog: false,
    });
    await Fwa.run({} as any, run.interaction as any, {} as any);

    expect(fwaPoliceServiceMock.setClanConfig).toHaveBeenCalledWith({
      clanTag: "2QG2C08UP",
      enableDm: true,
      enableLog: false,
    });
    const content = String(run.editReply.mock.calls[0]?.[0]?.content ?? "");
    expect(content).toContain("FWA police updated for **Alpha** (#2QG2C08UP).");
    expect(content).toContain("DM alerts: ON | Clan logs: OFF");
  });

  it("returns a clear error for send LOG when clan log channel is missing", async () => {
    fwaPoliceServiceMock.sendSampleMessage.mockResolvedValue({
      ok: false,
      error: "LOG_CHANNEL_NOT_CONFIGURED",
    });
    const run = makeInteraction({
      subcommand: "send",
      clan: "#2QG2C08UP",
      violation: "EARLY_NON_MIRROR_TRIPLE",
      show: "LOG",
    });

    await Fwa.run({} as any, run.interaction as any, {} as any);

    const content = String(run.editReply.mock.calls[0]?.[0]?.content ?? "");
    expect(content).toContain("no tracked clan log channel");
    expect(content).toContain("/bot-logs");
  });

  it("passes selected violation/clan to send preview flow", async () => {
    const run = makeInteraction({
      subcommand: "send",
      clan: "#2QG2C08UP",
      violation: "EARLY_NON_MIRROR_TRIPLE",
      show: "DM",
    });

    await Fwa.run({} as any, run.interaction as any, {} as any);

    expect(fwaPoliceServiceMock.sendSampleMessage).toHaveBeenCalledWith({
      client: run.interaction.client,
      guildId: "guild-1",
      clanTag: "2QG2C08UP",
      violation: "EARLY_NON_MIRROR_TRIPLE",
      destination: "DM",
      requestingUserId: "111111111111111111",
    });
  });
});
