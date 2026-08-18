import { beforeEach, describe, expect, it, vi } from "vitest";

const permissionMock = vi.hoisted(() => ({ canUseAnyTarget: vi.fn() }));
const inactiveMock = vi.hoisted(() => ({ run: vi.fn() }));
const unlinkedMock = vi.hoisted(() => ({
  buildUnlinkedListLines: vi.fn(),
  listPersistedUnlinkedMembers: vi.fn(),
}));
const compoMock = vi.hoisted(() => ({
  buildCompoAdviceResponsePayload: vi.fn(),
  readAdvice: vi.fn(),
}));
const violationsMock = vi.hoisted(() => ({
  buildFwaViolationsClanDetailPayload: vi.fn(),
}));
const historyMock = vi.hoisted(() => ({
  listEndedByClanSince: vi.fn(),
}));
const trendMock = vi.hoisted(() => ({
  getTrend: vi.fn(),
}));

vi.mock("../src/services/CommandPermissionService", () => ({
  CommandPermissionService: class {
    canUseAnyTarget = permissionMock.canUseAnyTarget;
  },
}));
vi.mock("../src/commands/Inactive", () => ({
  runInactiveClanHealthDetail: inactiveMock.run,
}));
vi.mock("../src/commands/Unlinked", () => ({
  buildUnlinkedListLines: unlinkedMock.buildUnlinkedListLines,
}));
vi.mock("../src/services/UnlinkedMemberAlertService", () => ({
  unlinkedMemberAlertService: {
    listPersistedUnlinkedMembers: unlinkedMock.listPersistedUnlinkedMembers,
  },
}));
vi.mock("../src/commands/Compo", () => ({
  buildCompoAdviceResponsePayload: compoMock.buildCompoAdviceResponsePayload,
}));
vi.mock("../src/services/CompoAdviceService", () => ({
  CompoAdviceService: class {
    readAdvice = compoMock.readAdvice;
  },
}));
vi.mock("../src/commands/fwa/violationsCommand", () => ({
  buildFwaViolationsClanDetailPayload: violationsMock.buildFwaViolationsClanDetailPayload,
}));
vi.mock("../src/services/ClanHealthTrendService", () => ({
  ClanHealthTrendService: class {
    getTrend = trendMock.getTrend;
  },
}));

import {
  buildClanHealthNavigationCustomId,
  buildClanHealthWarHistoryNavigationCustomId,
  buildClanHealthTrendsNavigationCustomId,
  buildClanHealthNavigationRow,
  buildClanHealthTrendsNavigationRow,
  handleClanHealthNavigationButtonInteraction,
  parseClanHealthNavigationCustomId,
} from "../src/commands/ClanHealthNavigation";

function makeButton(customId: string, userId = "leader-1") {
  return {
    customId,
    guildId: "guild-1",
    user: { id: userId },
    client: {},
    inGuild: () => true,
    deferred: false,
    replied: false,
    reply: vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    message: { edit: vi.fn() },
  };
}

describe("Clan Health navigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    permissionMock.canUseAnyTarget.mockResolvedValue(true);
    unlinkedMock.buildUnlinkedListLines.mockReturnValue([
      "Current unresolved unlinked players in #AAA111:",
      "- none",
    ]);
    unlinkedMock.listPersistedUnlinkedMembers.mockResolvedValue([]);
    compoMock.readAdvice.mockResolvedValue({ kind: "ready", selectedView: "auto" });
    compoMock.buildCompoAdviceResponsePayload.mockResolvedValue({ embeds: [] });
    violationsMock.buildFwaViolationsClanDetailPayload.mockResolvedValue({ embeds: [] });
    trendMock.getTrend.mockResolvedValue({
      guildId: "guild-1",
      clanTag: "#AAA111",
      clanName: null,
      cutoff: new Date("2026-01-01T00:00:00.000Z"),
      now: new Date("2026-03-01T00:00:00.000Z"),
      snapshots: [],
      displayedSnapshots: [],
      coverage: { total: 0, oldestSyncTime: null, newestSyncTime: null },
      deviation: { validCount: 0, oldest: null, latest: null, change: null, direction: null, average: null, best: null, worst: null },
      roster: { oldest: null, latest: null, delta: null, average: null, fullCount: 0 },
      unresolved: { oldest: null, latest: null, average: null },
      fillers: { knownOldest: null, knownLatest: null, averageKnown: null, knownCount: 0 },
      algorithmVersions: [],
    });
  });

  it("builds exactly five bounded buttons with deterministic IDs", () => {
    const row = buildClanHealthNavigationRow("#AAA111").toJSON();
    expect(row.components).toHaveLength(5);
    expect(row.components.map((button) => button.label)).toEqual([
      "View Inactive",
      "View Unlinked",
      "View Compo",
      "View Violations",
      "War History",
    ]);
    expect(row.components.map((button) => button.custom_id)).toEqual([
      "clan-health:inactive:AAA111",
      "clan-health:unlinked:AAA111",
      "clan-health:compo:AAA111",
      "clan-health:violations:AAA111",
      "clan-health:war-history:AAA111:30",
    ]);
    expect(row.components.every((button) => (button.custom_id?.length ?? 0) <= 100)).toBe(true);
  });

  it("round-trips normalized action and clan tag and rejects malformed IDs", () => {
    const id = buildClanHealthNavigationCustomId("compo", "#pylq02");
    expect(id).toBe("clan-health:compo:PYLQ02");
    expect(parseClanHealthNavigationCustomId(id)).toEqual({
      action: "compo",
      clanTag: "PYLQ02",
    });
    expect(parseClanHealthNavigationCustomId("clan-health:unknown:PYLQ02")).toBeNull();
    expect(parseClanHealthNavigationCustomId("clan-health:compo:#PYLQ02")).toBeNull();
    expect(parseClanHealthNavigationCustomId("clan-health:compo:")).toBeNull();

    const historyId = buildClanHealthWarHistoryNavigationCustomId("#pylq02", 60);
    expect(historyId).toBe("clan-health:war-history:PYLQ02:60");
    expect(parseClanHealthNavigationCustomId(historyId)).toEqual({
      action: "war-history",
      clanTag: "PYLQ02",
      historicalWindowDays: 60,
    });
    expect(parseClanHealthNavigationCustomId("clan-health:war-history:PYLQ02")).toBeNull();
    expect(parseClanHealthNavigationCustomId("clan-health:war-history:PYLQ02:6")).toBeNull();
    expect(parseClanHealthNavigationCustomId("clan-health:war-history:PYLQ02:181")).toBeNull();
    expect(parseClanHealthNavigationCustomId("clan-health:war-history:PYLQ02:60.5")).toBeNull();

    const trendsId = buildClanHealthTrendsNavigationCustomId("#pylq02", 60);
    expect(trendsId).toBe("clan-health:trends:PYLQ02:60");
    expect(parseClanHealthNavigationCustomId(trendsId)).toEqual({
      action: "trends",
      clanTag: "PYLQ02",
      historicalWindowDays: 60,
    });
    expect(parseClanHealthNavigationCustomId("clan-health:trends:PYLQ02")).toBeNull();
    expect(parseClanHealthNavigationCustomId("clan-health:trends:PYLQ02:6")).toBeNull();
    expect(parseClanHealthNavigationCustomId("clan-health:trends:PYLQ02:181")).toBeNull();
    expect(parseClanHealthNavigationCustomId("clan-health:trends:PYLQ02:60.5")).toBeNull();
  });

  it("carries a selected historical window in the War History button ID", () => {
    const row = buildClanHealthNavigationRow("#AAA111", 90).toJSON();
    expect(row.components[4]?.custom_id).toBe("clan-health:war-history:AAA111:90");
  });

  it("adds a second row with only the windowed Trends action", () => {
    const row = buildClanHealthTrendsNavigationRow("#AAA111", 60).toJSON();
    expect(row.components).toHaveLength(1);
    expect(row.components[0]).toMatchObject({
      label: "View Trends",
      custom_id: "clan-health:trends:AAA111:60",
    });
    expect(row.components[0]?.custom_id?.length ?? 0).toBeLessThanOrEqual(100);
  });

  it.each([
    ["inactive", ["inactive"], "#AAA111"],
    ["unlinked", ["unlinked:list", "unlinked"], "#AAA111"],
    ["compo", ["compo:advice"], "#AAA111"],
    ["violations", ["fwa:violations"], "#AAA111"],
  ] as const)("routes %s to its owning workflow with an ephemeral response", async (action, target, clanTag) => {
    const interaction = makeButton(buildClanHealthNavigationCustomId(action, clanTag));
    await handleClanHealthNavigationButtonInteraction(interaction as any);

    expect(permissionMock.canUseAnyTarget).toHaveBeenCalledWith(target, interaction);
    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(interaction.message.edit).not.toHaveBeenCalled();
    expect(interaction.update).toBeUndefined();
  });

  it("keeps the originating clan scope for inactive, unlinked, compo, and violations", async () => {
    await handleClanHealthNavigationButtonInteraction(
      makeButton(buildClanHealthNavigationCustomId("inactive", "#AAA111")) as any,
    );
    expect(inactiveMock.run).toHaveBeenCalledWith(expect.anything(), { clanTag: "#AAA111" });

    await handleClanHealthNavigationButtonInteraction(
      makeButton(buildClanHealthNavigationCustomId("unlinked", "#AAA111")) as any,
    );
    expect(unlinkedMock.listPersistedUnlinkedMembers).toHaveBeenCalledWith({
      guildId: "guild-1",
      clanTag: "#AAA111",
    });

    await handleClanHealthNavigationButtonInteraction(
      makeButton(buildClanHealthNavigationCustomId("compo", "#AAA111")) as any,
    );
    expect(compoMock.readAdvice).toHaveBeenCalledWith({
      guildId: "guild-1",
      targetTag: "#AAA111",
      mode: "actual",
      view: "auto",
    });

    await handleClanHealthNavigationButtonInteraction(
      makeButton(buildClanHealthNavigationCustomId("violations", "#AAA111")) as any,
    );
    expect(violationsMock.buildFwaViolationsClanDetailPayload).toHaveBeenCalledWith(
      expect.objectContaining({ guildId: "guild-1", clanTag: "#AAA111" }),
    );
  });

  it("does not bind the tracked-clan button to the original command user", async () => {
    const firstLeader = makeButton(
      buildClanHealthNavigationCustomId("compo", "#AAA111"),
      "leader-1",
    );
    const secondLeader = makeButton(
      buildClanHealthNavigationCustomId("compo", "#AAA111"),
      "leader-2",
    );

    await handleClanHealthNavigationButtonInteraction(firstLeader as any);
    await handleClanHealthNavigationButtonInteraction(secondLeader as any);

    expect(compoMock.readAdvice).toHaveBeenCalledTimes(2);
    expect(permissionMock.canUseAnyTarget).toHaveBeenNthCalledWith(1, ["compo:advice"], firstLeader);
    expect(permissionMock.canUseAnyTarget).toHaveBeenNthCalledWith(2, ["compo:advice"], secondLeader);
  });

  it("opens persisted ended history with the carried window and caps display at ten", async () => {
    const rows = Array.from({ length: 12 }, (_, index) => ({
      warId: index + 1,
      syncNumber: index + 1,
      matchType: "FWA" as const,
      clanStars: 30,
      clanDestruction: 100,
      opponentStars: 28,
      opponentDestruction: 95,
      pointsAfterWar: 1500,
      expectedOutcome: "WIN",
      actualOutcome: "WIN",
      warStartTime: new Date("2026-03-01T00:00:00.000Z"),
      warEndTime: new Date("2026-03-01T02:00:00.000Z"),
      clanName: "Alpha",
      clanTag: "#AAA111",
      opponentName: "Opponent",
      opponentTag: "#BBB222",
    }));
    historyMock.listEndedByClanSince.mockResolvedValue(rows);
    const interaction = makeButton("clan-health:war-history:AAA111:60", "leader-2");
    const historyService = { listEndedByClanSince: historyMock.listEndedByClanSince };

    await handleClanHealthNavigationButtonInteraction(
      interaction as any,
      undefined,
      historyService as any,
    );

    expect(permissionMock.canUseAnyTarget).toHaveBeenCalledWith(["war"], interaction);
    expect(historyMock.listEndedByClanSince).toHaveBeenCalledWith({
      clanTag: "#AAA111",
      cutoff: expect.any(Date),
    });
    const cutoff = historyMock.listEndedByClanSince.mock.calls[0][0].cutoff as Date;
    expect(Date.now() - cutoff.getTime()).toBeGreaterThan(59 * 24 * 60 * 60 * 1000);
    expect(Date.now() - cutoff.getTime()).toBeLessThan(61 * 24 * 60 * 60 * 1000);
    expect(interaction.editReply).toHaveBeenCalledWith({
      embeds: [
        expect.objectContaining({
          data: expect.objectContaining({
            description: expect.stringContaining("Showing latest 10 of 12 ended wars in last 60 days"),
          }),
        }),
      ],
    });
    const embed = interaction.editReply.mock.calls[0][0].embeds[0];
    expect(embed.data.fields).toHaveLength(10);
    expect(interaction.message.edit).not.toHaveBeenCalled();
  });

  it("renders an unambiguous ephemeral zero-history state", async () => {
    historyMock.listEndedByClanSince.mockResolvedValue([]);
    const interaction = makeButton("clan-health:war-history:AAA111:45");

    await handleClanHealthNavigationButtonInteraction(
      interaction as any,
      undefined,
      { listEndedByClanSince: historyMock.listEndedByClanSince } as any,
    );

    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(interaction.editReply).toHaveBeenCalledWith({
      embeds: [
        expect.objectContaining({
          data: expect.objectContaining({
            title: "War History - #AAA111",
            description: "Last 45 days • 0 ended wars.",
          }),
        }),
      ],
    });
    expect(interaction.editReply.mock.calls[0][0].embeds[0].data.title).not.toContain(
      "#AAA111 (#AAA111)",
    );
    expect(interaction.message.edit).not.toHaveBeenCalled();
  });

  it("preserves denial behavior for the War History permission", async () => {
    permissionMock.canUseAnyTarget.mockResolvedValue(false);
    const denied = makeButton("clan-health:war-history:AAA111:30");
    await handleClanHealthNavigationButtonInteraction(denied as any, undefined, {
      listEndedByClanSince: historyMock.listEndedByClanSince,
    } as any);
    expect(permissionMock.canUseAnyTarget).toHaveBeenCalledWith(["war"], denied);
    expect(denied.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
    expect(denied.deferReply).not.toHaveBeenCalled();
  });

  it("routes Trends through Clan Health permission with an ephemeral unchanged-message response", async () => {
    const interaction = makeButton("clan-health:trends:AAA111:60", "leader-2");
    const trendService = { getTrend: trendMock.getTrend };

    await handleClanHealthNavigationButtonInteraction(
      interaction as any,
      undefined,
      undefined,
      trendService as any,
    );

    expect(permissionMock.canUseAnyTarget).toHaveBeenCalledWith(["clan-health"], interaction);
    expect(trendMock.getTrend).toHaveBeenCalledWith({
      guildId: "guild-1",
      clanTag: "#AAA111",
      cutoff: expect.any(Date),
      now: expect.any(Date),
    });
    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(interaction.message.edit).not.toHaveBeenCalled();
    const embedJson = interaction.editReply.mock.calls[0][0].embeds[0].toJSON();
    expect(embedJson.title).toBe("Clan Health Trends - #AAA111");
    expect(embedJson.description).toContain("Last 60 days");
    expect(String(embedJson.fields.find((field: any) => field.name === "Coverage")?.value)).toContain(
      "No sync-boundary readiness snapshots were captured for #AAA111",
    );
  });

  it("fails malformed IDs safely and enforces permission denial", async () => {
    const malformed = makeButton("clan-health:wat:AAA111");
    await handleClanHealthNavigationButtonInteraction(malformed as any);
    expect(malformed.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );

    permissionMock.canUseAnyTarget.mockResolvedValue(false);
    const denied = makeButton(buildClanHealthNavigationCustomId("compo", "#AAA111"));
    await handleClanHealthNavigationButtonInteraction(denied as any);
    expect(denied.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
    expect(denied.deferReply).not.toHaveBeenCalled();
  });
});
