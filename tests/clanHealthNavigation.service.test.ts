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
  listEndedByClanSyncNumbers: vi.fn(),
}));
const historicalWindowMock = vi.hoisted(() => ({
  resolveLatestSyncWindow: vi.fn(),
}));
const trendMock = vi.hoisted(() => ({
  getTrend: vi.fn(),
}));
const homeRosterMock = vi.hoisted(() => ({
  getClanHomeRoster: vi.fn(),
}));
const homeMembershipMock = vi.hoisted(() => ({
  keepHomeTransferCandidate: vi.fn(),
  confirmHomeTransferCandidate: vi.fn(),
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
vi.mock("../src/services/ClanHealthHistoricalWindowService", () => ({
  ClanHealthHistoricalWindowService: class {
    resolveLatestSyncWindow = historicalWindowMock.resolveLatestSyncWindow;
  },
}));
vi.mock("../src/services/HomeRosterService", () => ({
  homeRosterService: { getClanHomeRoster: homeRosterMock.getClanHomeRoster },
}));

import {
  buildClanHealthNavigationCustomId,
  buildClanHealthWarHistoryNavigationCustomId,
  buildClanHealthTrendsNavigationCustomId,
  buildClanHealthHomeNavigationCustomId,
  buildClanHealthTransferNavigationCustomId,
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

function transferMember(input: {
  id: string;
  playerTag: string;
  playerName: string;
  qualifiedAtSyncTime: Date;
  toClanTag: string;
  toClanName?: string | null;
}): any {
  return {
    playerTag: input.playerTag,
    playerName: input.playerName,
    homeClanTag: "#AAA111",
    startedAtSyncTime: new Date("2026-01-01T00:00:00.000Z"),
    qualifiedAtSyncTime: input.qualifiedAtSyncTime,
    presence: "AWAY",
    currentClanTag: input.toClanTag,
    currentClanName: input.toClanName ?? null,
    currentLocationObservedAt: input.qualifiedAtSyncTime,
    pendingTransfer: {
      id: input.id,
      toClanTag: input.toClanTag,
      toClanName: input.toClanName ?? null,
      startedAtSyncTime: new Date("2026-01-01T00:00:00.000Z"),
      qualifiedAtSyncTime: input.qualifiedAtSyncTime,
    },
  };
}

function transferRoster(...members: any[]): any {
  return {
    guildId: "guild-1",
    clanTag: "#AAA111",
    clanName: "Alpha",
    homeMemberCount: members.length,
    presentCount: 0,
    awayCount: members.length,
    unknownCount: 0,
    openHomeSpots: 50 - members.length,
    currentClanMemberCount: members.length,
    unassignedPresentCount: 0,
    pendingTransferCount: members.length,
    currentRosterCoverage: "CURRENT",
    currentRosterObservedAt: new Date("2026-03-01T00:00:00.000Z"),
    members,
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
      window: { kind: "days", days: 60, cutoff: new Date("2026-01-01T00:00:00.000Z") },
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
    historyMock.listEndedByClanSyncNumbers.mockReset();
    homeRosterMock.getClanHomeRoster.mockReset();
    homeMembershipMock.keepHomeTransferCandidate.mockReset();
    homeMembershipMock.confirmHomeTransferCandidate.mockReset();
    homeRosterMock.getClanHomeRoster.mockResolvedValue({
      guildId: "guild-1",
      clanTag: "#AAA111",
      clanName: "Alpha",
      homeMemberCount: 0,
      presentCount: 0,
      awayCount: 0,
      unknownCount: 0,
      openHomeSpots: 50,
      currentClanMemberCount: 0,
      unassignedPresentCount: 0,
      pendingTransferCount: 0,
      currentRosterCoverage: "CURRENT" as const,
      currentRosterObservedAt: new Date("2026-03-01T00:00:00.000Z"),
      members: [],
    });
    historicalWindowMock.resolveLatestSyncWindow.mockReset();
    historicalWindowMock.resolveLatestSyncWindow.mockResolvedValue({
      kind: "syncs",
      requestedSyncCount: 30,
      startSyncNumber: 516,
      endSyncNumber: 545,
      syncNumbers: Array.from({ length: 30 }, (_, index) => 516 + index),
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
      "clan-health:war-history:AAA111:s30",
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

    const homeId = buildClanHealthHomeNavigationCustomId("home-roster", "#pylq02");
    expect(homeId).toBe("clan-health:home-roster:PYLQ02");
    expect(parseClanHealthNavigationCustomId(homeId)).toEqual({
      action: "home-roster",
      clanTag: "PYLQ02",
    });
    expect(parseClanHealthNavigationCustomId("clan-health:away:#PYLQ02")).toBeNull();
    expect(parseClanHealthNavigationCustomId("clan-health:transfers:!!!")).toBeNull();

    const historyId = buildClanHealthWarHistoryNavigationCustomId("#pylq02", 60);
    expect(historyId).toBe("clan-health:war-history:PYLQ02:60");
    expect(parseClanHealthNavigationCustomId(historyId)).toEqual({
      action: "war-history",
      clanTag: "PYLQ02",
      historicalWindow: { kind: "days", days: 60, cutoff: new Date(0) },
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
      historicalWindow: { kind: "days", days: 60, cutoff: new Date(0) },
      historicalWindowDays: 60,
    });
    expect(parseClanHealthNavigationCustomId("clan-health:trends:PYLQ02")).toBeNull();
    expect(parseClanHealthNavigationCustomId("clan-health:trends:PYLQ02:6")).toBeNull();
    expect(parseClanHealthNavigationCustomId("clan-health:trends:PYLQ02:181")).toBeNull();
    expect(parseClanHealthNavigationCustomId("clan-health:trends:PYLQ02:60.5")).toBeNull();

    expect(parseClanHealthNavigationCustomId("clan-health:war-history:!!!:s30")).toBeNull();
    expect(parseClanHealthNavigationCustomId("clan-health:trends::s30")).toBeNull();
    expect(parseClanHealthNavigationCustomId("clan-health:war-history:#AAA111:s30")).toBeNull();
    expect(parseClanHealthNavigationCustomId("clan-health:war-history:AAA111:s30")).toMatchObject({
      action: "war-history",
      clanTag: "AAA111",
      historicalWindow: { kind: "syncs", requestedSyncCount: 30 },
    });
    expect(parseClanHealthNavigationCustomId("clan-health:trends:AAA111:s30")).toMatchObject({
      action: "trends",
      clanTag: "AAA111",
      historicalWindow: { kind: "syncs", requestedSyncCount: 30 },
    });
  });

  it("carries a selected historical window in the War History button ID", () => {
    const row = buildClanHealthNavigationRow("#AAA111", 90).toJSON();
    expect(row.components[4]?.custom_id).toBe("clan-health:war-history:AAA111:90");
  });

  it("round-trips bounded transfer review IDs and rejects malformed candidates", () => {
    const id = buildClanHealthTransferNavigationCustomId("transfer-confirm", "#AAA111", "candidate-1");
    expect(id).toBe("clan-health:transfer-confirm:AAA111:candidate-1");
    expect(id.length).toBeLessThanOrEqual(100);
    expect(parseClanHealthNavigationCustomId(id)).toEqual({
      action: "transfer-confirm",
      clanTag: "AAA111",
      candidateId: "candidate-1",
    });
    expect(parseClanHealthNavigationCustomId("clan-health:transfer-next:AAA111:")).toBeNull();
    expect(parseClanHealthNavigationCustomId("clan-health:transfer-next:AAA111:candidate:extra")).toBeNull();
    expect(parseClanHealthNavigationCustomId(`clan-health:transfer-next:AAA111:${"x".repeat(65)}`)).toBeNull();
    expect(() => buildClanHealthTransferNavigationCustomId("transfer-keep", "#AAA111", "bad:id")).toThrow();
  });

  it("adds a second row with only the windowed Trends action", () => {
    const row = buildClanHealthTrendsNavigationRow("#AAA111", 60).toJSON();
    expect(row.components).toHaveLength(4);
    expect(row.components.map((button) => button.label)).toEqual([
      "View Home Roster",
      "View Away",
      "View Transfers",
      "View Trends",
    ]);
    expect(row.components.map((button) => button.custom_id)).toEqual([
      "clan-health:home-roster:AAA111",
      "clan-health:away:AAA111",
      "clan-health:transfers:AAA111",
      "clan-health:trends:AAA111:60",
    ]);
    expect(row.components.every((button) => (button.custom_id?.length ?? 0) <= 100)).toBe(true);
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

  it.each([
    ["home-roster", "View Home Roster"],
    ["away", "View Away"],
    ["transfers", "View Transfers"],
  ] as const)("routes read-only Home action %s through clan-health permission", async (action) => {
    const interaction = makeButton(`clan-health:${action}:AAA111`);
    await handleClanHealthNavigationButtonInteraction(interaction as any);

    expect(permissionMock.canUseAnyTarget).toHaveBeenCalledWith(["clan-health"], interaction);
    expect(homeRosterMock.getClanHomeRoster).toHaveBeenCalledWith({
      guildId: "guild-1",
      clanTag: "#AAA111",
    });
    expect(interaction.editReply).toHaveBeenCalled();
    expect(interaction.message.edit).not.toHaveBeenCalled();
  });

  it("renders no decision controls when no transfer candidates remain", async () => {
    const interaction = makeButton("clan-health:transfers:AAA111");
    await handleClanHealthNavigationButtonInteraction(interaction as any);

    expect(interaction.editReply).toHaveBeenCalledWith({
      content: "No pending Home transfer candidates.",
      components: [],
    });
    expect(interaction.message.edit).not.toHaveBeenCalled();
  });

  it("renders one bounded transfer candidate panel with Keep and Confirm controls", async () => {
    const candidate = transferMember({
      id: "candidate-1",
      playerTag: "#P001",
      playerName: "John",
      qualifiedAtSyncTime: new Date("2026-03-01T00:00:00.000Z"),
      toClanTag: "#BBB222",
      toClanName: "Eternal Blaze",
    });
    homeRosterMock.getClanHomeRoster.mockResolvedValueOnce(transferRoster(candidate));
    const interaction = makeButton("clan-health:transfers:AAA111");
    await handleClanHealthNavigationButtonInteraction(interaction as any);

    const payload = interaction.editReply.mock.calls[0]?.[0];
    expect(payload.content).toContain("John `#P001`");
    expect(payload.content).toContain("Candidate **1/1**");
    expect(payload.components).toHaveLength(1);
    expect(payload.components[0].components).toHaveLength(4);
    expect(payload.components[0].components.map((button: any) => button.data.label)).toEqual([
      "Previous",
      "Next",
      "Keep Home",
      "Confirm Transfer",
    ]);
    expect(payload.components[0].components[2].data.custom_id).toBe("clan-health:transfer-keep:AAA111:candidate-1");
    expect(payload.components[0].components[3].data.style).toBe(4);
    expect(payload.components[0].components.every((button: any) => button.data.custom_id.length <= 100)).toBe(true);
  });

  it("pages multiple transfer candidates deterministically and re-reads on Next", async () => {
    const first = transferMember({
      id: "candidate-1",
      playerTag: "#P001",
      playerName: "Ava",
      qualifiedAtSyncTime: new Date("2026-03-01T00:00:00.000Z"),
      toClanTag: "#BBB222",
    });
    const second = transferMember({
      id: "candidate-2",
      playerTag: "#P002",
      playerName: "Zoe",
      qualifiedAtSyncTime: new Date("2026-03-02T00:00:00.000Z"),
      toClanTag: "#CCC333",
    });
    homeRosterMock.getClanHomeRoster.mockResolvedValueOnce(transferRoster(second, first));
    const firstInteraction = makeButton("clan-health:transfers:AAA111");
    await handleClanHealthNavigationButtonInteraction(firstInteraction as any);
    expect(firstInteraction.editReply.mock.calls[0]?.[0]?.content).toContain("Candidate **1/2**");
    expect(firstInteraction.editReply.mock.calls[0]?.[0]?.content).toContain("Ava");

    homeRosterMock.getClanHomeRoster.mockResolvedValueOnce(transferRoster(second, first));
    const nextInteraction = makeButton("clan-health:transfer-next:AAA111:candidate-1");
    await handleClanHealthNavigationButtonInteraction(nextInteraction as any);
    expect(nextInteraction.editReply.mock.calls[0]?.[0]?.content).toContain("Candidate **2/2**");
    expect(nextInteraction.editReply.mock.calls[0]?.[0]?.content).toContain("Zoe");
    expect(nextInteraction.message.edit).not.toHaveBeenCalled();
  });

  it("recovers when the displayed candidate disappears before navigation", async () => {
    const candidate = transferMember({
      id: "candidate-gone",
      playerTag: "#P001",
      playerName: "John",
      qualifiedAtSyncTime: new Date("2026-03-01T00:00:00.000Z"),
      toClanTag: "#BBB222",
    });
    homeRosterMock.getClanHomeRoster.mockResolvedValueOnce(transferRoster());
    const interaction = makeButton("clan-health:transfer-next:AAA111:candidate-gone");
    await handleClanHealthNavigationButtonInteraction(interaction as any);

    expect(interaction.editReply).toHaveBeenCalledWith({
      content: "The previously displayed candidate is no longer pending. Showing the current candidates.\n\nNo pending Home transfer candidates.",
      components: [],
    });
    expect(candidate).toBeDefined();
  });

  it("passes the scoped candidate to Keep Home and refreshes the panel", async () => {
    const candidate = transferMember({
      id: "candidate-keep",
      playerTag: "#P001",
      playerName: "John",
      qualifiedAtSyncTime: new Date("2026-03-01T00:00:00.000Z"),
      toClanTag: "#BBB222",
      toClanName: "Eternal Blaze",
    });
    homeRosterMock.getClanHomeRoster
      .mockResolvedValueOnce(transferRoster(candidate))
      .mockResolvedValueOnce(transferRoster());
    homeMembershipMock.keepHomeTransferCandidate.mockResolvedValueOnce({
      status: "KEPT_HOME",
      candidate: {
        id: "candidate-keep",
        guildId: "guild-1",
        playerTag: "#P001",
        homeMembershipPeriodId: "home-1",
        fromClanTag: "#AAA111",
        toClanTag: "#BBB222",
        startedAtSyncTime: new Date("2026-01-01T00:00:00.000Z"),
        qualifiedAtSyncTime: new Date("2026-03-01T00:00:00.000Z"),
        status: "KEPT_HOME",
        decidedAt: new Date("2026-03-03T00:00:00.000Z"),
        decidedByDiscordUserId: "leader-1",
      },
    });
    const interaction = makeButton("clan-health:transfer-keep:AAA111:candidate-keep");
    await handleClanHealthNavigationButtonInteraction(
      interaction as any,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      homeMembershipMock as any,
      () => false,
    );

    expect(homeMembershipMock.keepHomeTransferCandidate).toHaveBeenCalledWith({
      candidateId: "candidate-keep",
      actorDiscordUserId: "leader-1",
      guildId: "guild-1",
      expectedFromClanTag: "#AAA111",
    });
    expect(homeRosterMock.getClanHomeRoster).toHaveBeenCalledTimes(2);
    expect(String(interaction.editReply.mock.calls[0]?.[0]?.content)).toContain("Home kept");
    expect(interaction.message.edit).not.toHaveBeenCalled();
  });

  it("passes the scoped candidate to Confirm Transfer and refreshes the panel", async () => {
    const candidate = transferMember({
      id: "candidate-confirm",
      playerTag: "#P001",
      playerName: "John",
      qualifiedAtSyncTime: new Date("2026-03-01T00:00:00.000Z"),
      toClanTag: "#BBB222",
      toClanName: "Eternal Blaze",
    });
    homeRosterMock.getClanHomeRoster
      .mockResolvedValueOnce(transferRoster(candidate))
      .mockResolvedValueOnce(transferRoster());
    homeMembershipMock.confirmHomeTransferCandidate.mockResolvedValueOnce({
      status: "CONFIRMED",
      candidate: {
        id: "candidate-confirm",
        guildId: "guild-1",
        playerTag: "#P001",
        homeMembershipPeriodId: "home-1",
        fromClanTag: "#AAA111",
        toClanTag: "#BBB222",
        startedAtSyncTime: new Date("2026-01-01T00:00:00.000Z"),
        qualifiedAtSyncTime: new Date("2026-03-01T00:00:00.000Z"),
        status: "CONFIRMED",
        decidedAt: new Date("2026-03-03T00:00:00.000Z"),
        decidedByDiscordUserId: "leader-1",
      },
    });
    const interaction = makeButton("clan-health:transfer-confirm:AAA111:candidate-confirm");
    await handleClanHealthNavigationButtonInteraction(
      interaction as any,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      homeMembershipMock as any,
      () => false,
    );

    expect(homeMembershipMock.confirmHomeTransferCandidate).toHaveBeenCalledWith({
      candidateId: "candidate-confirm",
      actorDiscordUserId: "leader-1",
      guildId: "guild-1",
      expectedFromClanTag: "#AAA111",
    });
    expect(String(interaction.editReply.mock.calls[0]?.[0]?.content)).toContain("Home transferred");
  });

  it("blocks transfer decisions in mirror mode before the mutation API", async () => {
    const interaction = makeButton("clan-health:transfer-keep:AAA111:candidate-1");
    await handleClanHealthNavigationButtonInteraction(
      interaction as any,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      homeMembershipMock as any,
      () => true,
    );

    expect(interaction.editReply).toHaveBeenCalledWith("Home transfer decisions are disabled in mirror mode.");
    expect(homeMembershipMock.keepHomeTransferCandidate).not.toHaveBeenCalled();
    expect(homeMembershipMock.confirmHomeTransferCandidate).not.toHaveBeenCalled();
  });

  it("rechecks permission before transfer decisions", async () => {
    permissionMock.canUseAnyTarget.mockResolvedValue(false);
    const interaction = makeButton("clan-health:transfer-confirm:AAA111:candidate-1");
    await handleClanHealthNavigationButtonInteraction(
      interaction as any,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      homeMembershipMock as any,
      () => false,
    );

    expect(permissionMock.canUseAnyTarget).toHaveBeenCalledWith(["clan-health"], interaction);
    expect(homeMembershipMock.confirmHomeTransferCandidate).not.toHaveBeenCalled();
    expect(interaction.deferReply).not.toHaveBeenCalled();
  });

  it("handles an unexpected decision failure with a friendly ephemeral response", async () => {
    const candidate = transferMember({
      id: "candidate-error",
      playerTag: "#P001",
      playerName: "John",
      qualifiedAtSyncTime: new Date("2026-03-01T00:00:00.000Z"),
      toClanTag: "#BBB222",
    });
    homeRosterMock.getClanHomeRoster.mockResolvedValueOnce(transferRoster(candidate));
    homeMembershipMock.confirmHomeTransferCandidate.mockRejectedValueOnce(new Error("unexpected"));
    const interaction = makeButton("clan-health:transfer-confirm:AAA111:candidate-error");
    await handleClanHealthNavigationButtonInteraction(
      interaction as any,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      homeMembershipMock as any,
      () => false,
    );

    expect(interaction.editReply).toHaveBeenLastCalledWith("Failed to open this Clan Health detail. Please try again.");
    expect(interaction.message.edit).not.toHaveBeenCalled();
  });

  it("splits a full Home roster into Discord-safe ephemeral messages without decision controls", async () => {
    homeRosterMock.getClanHomeRoster.mockResolvedValueOnce({
      guildId: "guild-1",
      clanTag: "#AAA111",
      clanName: "Alpha",
      homeMemberCount: 50,
      presentCount: 50,
      awayCount: 0,
      unknownCount: 0,
      openHomeSpots: 0,
      currentClanMemberCount: 50,
      unassignedPresentCount: 0,
      pendingTransferCount: 0,
      currentRosterCoverage: "CURRENT" as const,
      currentRosterObservedAt: new Date("2026-03-01T00:00:00.000Z"),
      members: Array.from({ length: 50 }, (_, index) => ({
        playerTag: `#P${index.toString(36).toUpperCase().padStart(3, "0")}`,
        playerName: `Player ${index}`,
        homeClanTag: "#AAA111",
        startedAtSyncTime: new Date("2026-01-01T00:00:00.000Z"),
        qualifiedAtSyncTime: new Date("2026-01-03T00:00:00.000Z"),
        presence: "PRESENT" as const,
        currentClanTag: null,
        currentClanName: null,
        currentLocationObservedAt: null,
        pendingTransfer: null,
      })),
    });
    const interaction = makeButton("clan-health:home-roster:AAA111");
    await handleClanHealthNavigationButtonInteraction(interaction as any);

    const messages = [
      interaction.editReply.mock.calls[0]?.[0],
      ...interaction.followUp.mock.calls.map((call: any[]) => call[0]?.content),
    ].filter((message): message is string => typeof message === "string");
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages.every((message) => message.length <= 2000)).toBe(true);
    expect(messages.join("\n")).not.toContain("Confirm Transfer");
    expect(messages.join("\n")).not.toContain("Keep Home");
  });

  it("does not claim that nobody is away when Home coverage is stale", async () => {
    homeRosterMock.getClanHomeRoster.mockResolvedValueOnce({
      guildId: "guild-1",
      clanTag: "#AAA111",
      clanName: "Alpha",
      homeMemberCount: 50,
      presentCount: 0,
      awayCount: 0,
      unknownCount: 50,
      openHomeSpots: 0,
      currentClanMemberCount: null,
      unassignedPresentCount: null,
      pendingTransferCount: 0,
      currentRosterCoverage: "STALE" as const,
      currentRosterObservedAt: new Date("2026-02-28T00:00:00.000Z"),
      members: [],
    });
    const interaction = makeButton("clan-health:away:AAA111");
    await handleClanHealthNavigationButtonInteraction(interaction as any);

    const content = String(interaction.editReply.mock.calls[0]?.[0]);
    expect(content).toContain("coverage for Alpha is stale");
    expect(content).not.toContain("No Home members are currently known to be away");
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

  it("re-resolves the default s30 range at click time", async () => {
    const interaction = makeButton("clan-health:war-history:AAA111:s30");
    const historyService = {
      listEndedByClanSince: historyMock.listEndedByClanSince,
      listEndedByClanSyncNumbers: historyMock.listEndedByClanSyncNumbers,
    };
    historyMock.listEndedByClanSyncNumbers.mockResolvedValue([]);
    historicalWindowMock.resolveLatestSyncWindow.mockResolvedValue({
      kind: "syncs",
      requestedSyncCount: 30,
      startSyncNumber: 516,
      endSyncNumber: 545,
      syncNumbers: Array.from({ length: 30 }, (_, index) => 516 + index),
    });

    await handleClanHealthNavigationButtonInteraction(
      interaction as any,
      undefined,
      historyService as any,
      undefined,
      historicalWindowMock as any,
    );

    expect(historicalWindowMock.resolveLatestSyncWindow).toHaveBeenCalledWith({
      guildId: "guild-1",
    });
    expect(historyMock.listEndedByClanSyncNumbers).toHaveBeenCalledWith({
      clanTag: "#AAA111",
      syncNumbers: Array.from({ length: 30 }, (_, index) => 516 + index),
    });
    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(interaction.message.edit).not.toHaveBeenCalled();
  });

  it("renders an honest unavailable message when s30 baseline resolution fails", async () => {
    const customId = "clan-health:war-history:AAA111:s30";
    expect(parseClanHealthNavigationCustomId(customId)).not.toBeNull();
    const interaction = makeButton(customId);
    const historyService = {
      listEndedByClanSince: historyMock.listEndedByClanSince,
      listEndedByClanSyncNumbers: historyMock.listEndedByClanSyncNumbers,
    };
    historicalWindowMock.resolveLatestSyncWindow.mockResolvedValue({
      kind: "unavailable",
      requestedSyncCount: 30,
      reason: "latest_sync_unavailable",
    });

    await handleClanHealthNavigationButtonInteraction(
      interaction as any,
      undefined,
      historyService as any,
      undefined,
      historicalWindowMock as any,
    );

    expect(historyMock.listEndedByClanSince).not.toHaveBeenCalled();
    expect(historyMock.listEndedByClanSyncNumbers).not.toHaveBeenCalled();
    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(interaction.message.edit).not.toHaveBeenCalled();
    const description = String(interaction.editReply.mock.calls[0]?.[0]?.embeds[0]?.data.description);
    expect(description).toContain("Latest sync range unavailable. Historical war data was not queried.");
    expect(description).not.toContain("undefined");
    expect(description).not.toContain("days");
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
      window: {
        kind: "days",
        days: 60,
        cutoff: expect.any(Date),
      },
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
