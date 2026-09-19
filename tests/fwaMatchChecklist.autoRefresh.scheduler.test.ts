import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  trackedMessage: { findMany: vi.fn() },
}));
const trackedMessageServiceMock = vi.hoisted(() => ({
  findCurrentFwaMatchChecklistAutoRefreshTargets: vi.fn(),
  claimFwaMatchChecklistAutoRefresh: vi.fn(),
  finalizeFwaMatchChecklistAutoRefresh: vi.fn(),
  refreshFwaMatchChecklistMessage: vi.fn(),
  markMessageDeleted: vi.fn(),
}));
const stateMock = vi.hoisted(() => ({
  buildFwaMatchChecklistRenderStateForGuild: vi.fn(),
}));
const autoPostMock = vi.hoisted(() => ({
  postForSyncTrackedMessage: vi.fn(),
}));
const pollingModeMock = vi.hoisted(() => ({
  isMirrorPollingMode: vi.fn(() => false),
  resolveRuntimeEnvironment: vi.fn(() => "test"),
}));

vi.mock("../src/prisma", () => ({ prisma: prismaMock }));
vi.mock("../src/services/CoCService", () => ({ CoCService: class {} }));
vi.mock("../src/services/PollingModeService", () => pollingModeMock);
vi.mock("../src/services/fwa/matchChecklistAutoPostService", () => ({
  fwaMatchChecklistAutoPostService: autoPostMock,
}));
vi.mock("../src/services/FwaMatchChecklistStateService", () => stateMock);
vi.mock("../src/services/TrackedMessageService", () => ({
  TRACKED_MESSAGE_FEATURE_TYPE: {
    SYNC_TIME_POST: "SYNC_TIME_POST",
    FWA_MATCH_CHECKLIST: "FWA_MATCH_CHECKLIST",
  },
  TRACKED_MESSAGE_STATUS: { ACTIVE: "ACTIVE" },
  parseSyncTimeMetadata: (value: any) => value,
  parseFwaMatchChecklistMetadata: (value: any) => value,
  assessFwaMatchChecklistCompletion: (value: any) => ({
    complete: Boolean(value.rows?.every((row: any) => row.outcome === "WIN")),
    unresolvedCount: value.rows?.every((row: any) => row.outcome === "WIN") ? 0 : 1,
    reason: "typed_rows_unresolved",
  }),
  areFwaMatchChecklistRowsEqual: (current: any[], next: any[]) =>
    JSON.stringify(current) === JSON.stringify(next),
  trackedMessageService: trackedMessageServiceMock,
}));

import {
  FwaMatchChecklistAutoPostSchedulerService,
  FWA_MATCH_CHECKLIST_AUTO_REFRESH_INTERVAL_MS,
} from "../src/services/fwa/matchChecklistAutoPostSchedulerService";
import { getCoCQueueContext } from "../src/services/CoCQueueContext";

const syncEpochSeconds = Math.floor(new Date("2026-05-13T00:00:00.000Z").getTime() / 1000);
const refreshAt = new Date("2026-05-13T00:15:00.000Z").getTime();

function makeRoot() {
  return {
    guildId: "guild-1",
    channelId: "sync-channel",
    messageId: "sync-1",
    expiresAt: new Date("2026-05-13T01:00:00.000Z"),
    createdAt: new Date("2026-05-13T00:00:00.000Z"),
    metadata: { syncEpochSeconds, syncTimeIso: "2026-05-13T00:00:00.000Z", clans: [] },
  };
}

function makeTarget(messageId = "mail-1", referenceId = "sync-1") {
  return {
    guildId: "guild-1",
    channelId: "checklist-channel",
    messageId,
    referenceId,
    syncIdentity: referenceId,
    syncEpochSeconds,
    expiresAt: new Date("2026-05-14T00:00:00.000Z"),
    status: "ACTIVE",
    metadata: {
      kind: "mail_checklist",
      createdByUserId: "system",
      createdAtIso: "2026-05-13T00:02:00.000Z",
      rows: [{ clanTag: "#PYPY", compactCopyLine: "old", outcome: "UNKNOWN" }],
    },
  };
}

function makeMessage() {
  return {
    id: "mail-1",
    reactions: { cache: { values: function* () { yield* []; } } },
    edit: vi.fn().mockResolvedValue(undefined),
  };
}

describe("FWA checklist automatic-refresh production path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.trackedMessage.findMany.mockResolvedValue([makeRoot()]);
    autoPostMock.postForSyncTrackedMessage.mockResolvedValue({ posted: 0, skipped: 0, failed: 0 });
    trackedMessageServiceMock.findCurrentFwaMatchChecklistAutoRefreshTargets.mockResolvedValue([]);
    trackedMessageServiceMock.claimFwaMatchChecklistAutoRefresh.mockResolvedValue({
      claimed: false,
      reason: "not_due",
      claimToken: null,
      metadata: null,
    });
    trackedMessageServiceMock.finalizeFwaMatchChecklistAutoRefresh.mockResolvedValue(true);
    trackedMessageServiceMock.refreshFwaMatchChecklistMessage.mockResolvedValue(true);
    trackedMessageServiceMock.markMessageDeleted.mockResolvedValue(true);
    stateMock.buildFwaMatchChecklistRenderStateForGuild.mockResolvedValue({
      rows: [{ clanTag: "#PYPY", compactCopyLine: "new", outcome: "WIN" }],
      scopeKey: "scope-new",
      expectedTrackedClanTags: ["#PYPY"],
    });
  });

  it("refreshes an eligible checklist at the +15m cadence even after the root expires at +1h", async () => {
    const target = makeTarget();
    const message = makeMessage();
    trackedMessageServiceMock.findCurrentFwaMatchChecklistAutoRefreshTargets.mockResolvedValue([target]);
    trackedMessageServiceMock.claimFwaMatchChecklistAutoRefresh.mockResolvedValue({
      claimed: true,
      reason: "claimed",
      claimToken: "claim-1",
      metadata: target.metadata,
    });
    const client = { channels: { fetch: vi.fn().mockResolvedValue({ messages: { fetch: vi.fn().mockResolvedValue(message) } }) } } as any;

    await new FwaMatchChecklistAutoPostSchedulerService(client).runCycle(refreshAt);

    expect(trackedMessageServiceMock.claimFwaMatchChecklistAutoRefresh).toHaveBeenCalledWith({
      messageId: "mail-1",
      nowMs: refreshAt,
      safetyCutoffAtMs: new Date("2026-05-13T06:00:00.000Z").getTime(),
      intervalMs: FWA_MATCH_CHECKLIST_AUTO_REFRESH_INTERVAL_MS,
    });
    expect(trackedMessageServiceMock.refreshFwaMatchChecklistMessage).toHaveBeenCalled();
  });

  it("does not replay a cadence slot after restart", async () => {
    const target = makeTarget();
    trackedMessageServiceMock.findCurrentFwaMatchChecklistAutoRefreshTargets.mockResolvedValue([target]);
    trackedMessageServiceMock.claimFwaMatchChecklistAutoRefresh.mockResolvedValue({
      claimed: false,
      reason: "not_due",
      claimToken: null,
      metadata: null,
    });
    const client = { channels: { fetch: vi.fn() } } as any;

    await new FwaMatchChecklistAutoPostSchedulerService(client).runCycle(refreshAt);
    await new FwaMatchChecklistAutoPostSchedulerService(client).runCycle(refreshAt);

    expect(trackedMessageServiceMock.claimFwaMatchChecklistAutoRefresh).toHaveBeenCalledTimes(2);
    expect(stateMock.buildFwaMatchChecklistRenderStateForGuild).not.toHaveBeenCalled();
    expect(client.channels.fetch).not.toHaveBeenCalled();
  });

  it("stops a fully resolved target before making CoC or Discord calls", async () => {
    trackedMessageServiceMock.findCurrentFwaMatchChecklistAutoRefreshTargets.mockResolvedValue([makeTarget()]);
    trackedMessageServiceMock.claimFwaMatchChecklistAutoRefresh.mockResolvedValue({
      claimed: false,
      reason: "completed",
      claimToken: null,
      metadata: { autoRefreshCompletedAtIso: "2026-05-13T00:10:00.000Z" },
    });
    const client = { channels: { fetch: vi.fn() } } as any;

    await new FwaMatchChecklistAutoPostSchedulerService(client).runCycle(refreshAt);

    expect(stateMock.buildFwaMatchChecklistRenderStateForGuild).not.toHaveBeenCalled();
    expect(client.channels.fetch).not.toHaveBeenCalled();
  });

  it("does not fetch or edit Discord when typed content is unchanged", async () => {
    const target = makeTarget();
    target.metadata.rows[0].compactCopyLine = "new";
    target.metadata.rows[0].outcome = "WIN";
    target.metadata.scopeKey = "scope";
    trackedMessageServiceMock.findCurrentFwaMatchChecklistAutoRefreshTargets.mockResolvedValue([target]);
    trackedMessageServiceMock.claimFwaMatchChecklistAutoRefresh.mockResolvedValue({
      claimed: true,
      reason: "claimed",
      claimToken: "claim-1",
      metadata: target.metadata,
    });
    stateMock.buildFwaMatchChecklistRenderStateForGuild.mockResolvedValue({
      rows: target.metadata.rows,
      scopeKey: "scope",
      expectedTrackedClanTags: ["#PYPY"],
    });
    const client = { channels: { fetch: vi.fn() } } as any;

    await new FwaMatchChecklistAutoPostSchedulerService(client).runCycle(refreshAt);

    expect(client.channels.fetch).not.toHaveBeenCalled();
    expect(trackedMessageServiceMock.finalizeFwaMatchChecklistAutoRefresh).toHaveBeenCalled();
  });

  it("does not edit unchanged content and isolates one checklist failure from the other", async () => {
    const first = makeTarget("mail-1");
    const second = { ...makeTarget("bases-1"), metadata: { ...makeTarget().metadata, kind: "bases_checklist" } };
    trackedMessageServiceMock.findCurrentFwaMatchChecklistAutoRefreshTargets.mockResolvedValue([first, second]);
    trackedMessageServiceMock.claimFwaMatchChecklistAutoRefresh.mockResolvedValue({
      claimed: true,
      reason: "claimed",
      claimToken: "claim-1",
      metadata: first.metadata,
    });
    stateMock.buildFwaMatchChecklistRenderStateForGuild
      .mockRejectedValueOnce(new Error("CoC unavailable"))
      .mockResolvedValueOnce({ rows: [{ clanTag: "#PYPY", compactCopyLine: "new", outcome: "UNKNOWN" }], scopeKey: "scope", expectedTrackedClanTags: ["#PYPY"] });
    const fetch = vi.fn().mockResolvedValue({ messages: { fetch: vi.fn().mockResolvedValue(makeMessage()) } });

    await new FwaMatchChecklistAutoPostSchedulerService({ channels: { fetch } } as any).runCycle(refreshAt);

    expect(stateMock.buildFwaMatchChecklistRenderStateForGuild).toHaveBeenCalledTimes(2);
    expect(trackedMessageServiceMock.refreshFwaMatchChecklistMessage).toHaveBeenCalledTimes(1);
  });

  it("skips all refresh work in mirror and staging modes", async () => {
    pollingModeMock.isMirrorPollingMode.mockReturnValue(true);
    await new FwaMatchChecklistAutoPostSchedulerService({} as any).runCycle(refreshAt);
    expect(prismaMock.trackedMessage.findMany).not.toHaveBeenCalled();
    expect(trackedMessageServiceMock.findCurrentFwaMatchChecklistAutoRefreshTargets).not.toHaveBeenCalled();

    pollingModeMock.isMirrorPollingMode.mockReturnValue(false);
    pollingModeMock.resolveRuntimeEnvironment.mockReturnValue("staging");
    await new FwaMatchChecklistAutoPostSchedulerService({} as any).runCycle(refreshAt);
    expect(prismaMock.trackedMessage.findMany).not.toHaveBeenCalled();
  });

  it("supplies a background CoC queue context for direct runCycle calls", async () => {
    pollingModeMock.isMirrorPollingMode.mockReturnValue(false);
    pollingModeMock.resolveRuntimeEnvironment.mockReturnValue("test");
    let observedContext: ReturnType<typeof getCoCQueueContext> = null;
    stateMock.buildFwaMatchChecklistRenderStateForGuild.mockImplementation(async () => {
      observedContext = getCoCQueueContext();
      return {
        rows: [{ clanTag: "#PYPY", compactCopyLine: "new", outcome: "UNKNOWN" }],
        scopeKey: "scope-new",
        expectedTrackedClanTags: ["#PYPY"],
      };
    });
    const target = makeTarget();
    trackedMessageServiceMock.findCurrentFwaMatchChecklistAutoRefreshTargets.mockResolvedValue([target]);
    trackedMessageServiceMock.claimFwaMatchChecklistAutoRefresh.mockResolvedValue({
      claimed: true,
      reason: "claimed",
      claimToken: "claim-1",
      metadata: target.metadata,
    });
    const message = makeMessage();
    const client = {
      channels: { fetch: vi.fn().mockResolvedValue({ messages: { fetch: vi.fn().mockResolvedValue(message) } }) },
    };

    await new FwaMatchChecklistAutoPostSchedulerService(client as any).runCycle(refreshAt);

    expect(observedContext).toEqual(expect.objectContaining({
      priority: "background",
      source: "fwa_match_checklist_auto_post_scheduler",
    }));
  });
});
