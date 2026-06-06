import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FwaBasesChecklistReminderCandidate } from "../src/services/fwa/basesChecklistReminderService";

const plannerMocks = vi.hoisted(() => ({
  findPending: vi.fn(),
  buildContent: vi.fn(() => "REMINDER CONTENT"),
}));

const dozzleLogMock = vi.hoisted(() => ({
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
}));

const pollingModeMock = vi.hoisted(() => ({
  isMirrorPollingMode: vi.fn(() => false),
  resolveRuntimeEnvironment: vi.fn(() => "test"),
}));

vi.mock("../src/helper/dozzleLogger", () => ({
  dozzleLog: dozzleLogMock,
}));

vi.mock("../src/services/PollingModeService", () => pollingModeMock);

vi.mock("../src/services/fwa/basesChecklistReminderService", () => ({
  findPendingFwaBasesChecklistReminderCandidates: plannerMocks.findPending,
  buildFwaBasesChecklistReminderContent: plannerMocks.buildContent,
}));

const prismaMock = vi.hoisted(() => ({
  trackedMessage: {
    create: vi.fn(),
    findUnique: vi.fn(),
  },
  trackedClan: {
    findFirst: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import { trackedMessageService } from "../src/services/TrackedMessageService";

type ClientLike = {
  channels: {
    fetch: ReturnType<typeof vi.fn>;
  };
};

function makeCandidate(overrides: Partial<FwaBasesChecklistReminderCandidate> = {}): FwaBasesChecklistReminderCandidate {
  return {
    guildId: "guild-1",
    clanTag: "#ABC",
    clanName: "Alpha Clan",
    clanShortName: "Alpha",
    clanRoleId: "role-1",
    matchType: "BL",
    destinationChannelId: "channel-1",
    destinationChannelKind: "leader",
    reminderMessageId: "fwa_match_checklist_bases_reminder|guild=guild-1|clan=#ABC|war=1001|opponent=OPP1|start=2026-05-26T18:00:00.000Z|bucket=3",
    warId: 1001,
    opponentTag: "#OPP1",
    battleDayStart: new Date("2026-05-26T18:00:00.000Z"),
    dueBucketHours: 3,
    remainingBucketHours: [1],
    ...overrides,
  };
}

function makeClient(input?: {
  channel?: unknown;
  fetchError?: Error;
}): {
  client: ClientLike;
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn().mockResolvedValue({ id: "sent-1" });
  const channel =
    input?.channel ??
    {
      isTextBased: () => true,
      send,
    };
  const client: ClientLike = {
    channels: {
      fetch: vi.fn(async () => {
        if (input?.fetchError) throw input.fetchError;
        return channel as any;
      }),
    },
  };
  return { client, send };
}

async function createScheduler(client: ClientLike) {
  const { FwaBasesChecklistReminderSchedulerService } = await import(
    "../src/services/fwa/basesChecklistReminderSchedulerService"
  );
  return new FwaBasesChecklistReminderSchedulerService(client as any);
}

describe("FwaBasesChecklistReminderSchedulerService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    plannerMocks.findPending.mockResolvedValue([]);
    plannerMocks.buildContent.mockReturnValue("REMINDER CONTENT");
    prismaMock.trackedClan.findFirst.mockResolvedValue({
      tag: "#ABC",
      name: "Alpha Clan",
      leaderChannelId: "channel-1",
    });
    vi.spyOn(trackedMessageService, "resolveLatestActiveSyncPost").mockResolvedValue(null as any);
    vi.spyOn(trackedMessageService, "findLatestActiveFwaBaseSwapTrackedMessageForClan").mockResolvedValue(null as any);
    vi.spyOn(trackedMessageService, "findLatestActiveFwaMatchChecklistBasesCompletionForClan").mockResolvedValue(
      null as any,
    );
    vi.spyOn(trackedMessageService, "claimFwaBasesChecklistReminderMarker").mockResolvedValue(true as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends one reminder to the configured channel with role mentions enabled", async () => {
    plannerMocks.findPending.mockResolvedValue([makeCandidate()]);
    const { client, send } = makeClient();
    const scheduler = await createScheduler(client);

    const counts = await scheduler.runCycle(new Date("2026-05-26T15:00:00.000Z").getTime());

    expect(counts).toEqual({
      evaluated: 1,
      sent: 1,
      deduped: 0,
      skipped: 0,
      failed: 0,
    });
    expect(client.channels.fetch).toHaveBeenCalledWith("channel-1");
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "REMINDER CONTENT",
        allowedMentions: { roles: ["role-1"], parse: [] },
      }),
    );
    expect(dozzleLogMock.info).toHaveBeenCalledWith(
      expect.stringContaining("bucketHours=3"),
    );
    expect(dozzleLogMock.info).toHaveBeenCalledWith(
      expect.stringContaining("destinationChannelId=channel-1"),
    );
    expect(trackedMessageService.claimFwaBasesChecklistReminderMarker).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        clanTag: "#ABC",
        bucketHours: 3,
      }),
    );
    expect(
      trackedMessageService.findLatestActiveFwaMatchChecklistBasesCompletionForClan,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        clanTag: "#ABC",
        warId: 1001,
        opponentTag: "#OPP1",
      }),
    );
  });

  it("skips sending when the final recheck shows the clan is no longer unchecked", async () => {
    plannerMocks.findPending.mockResolvedValue([makeCandidate()]);
    vi.mocked(trackedMessageService.findLatestActiveFwaMatchChecklistBasesCompletionForClan).mockResolvedValueOnce(
      {
        id: "completion-1",
        guildId: "guild-1",
        channelId: "channel-1",
        messageId: "fwa_match_checklist_bases_completion|guild=guild-1|clan=#ABC|war=1001|opponent=#OPP1|start=2026-05-26T18:00:00.000Z",
        referenceId: "sync-message-1",
        clanTag: "#ABC",
        createdAt: new Date("2026-05-26T14:00:00.000Z"),
        expiresAt: null,
        metadata: {
          kind: "bases_completion",
          createdByUserId: "user-1",
          createdAtIso: "2026-05-26T14:00:00.000Z",
          syncMessageId: null,
          syncReferenceId: null,
          clanTag: "#ABC",
          clanName: "Alpha Clan",
          checked: true,
          warId: 1001,
          opponentTag: "#OPP1",
          warStartTimeIso: "2026-05-26T18:00:00.000Z",
        },
      } as any,
    );
    const { client, send } = makeClient();
    const scheduler = await createScheduler(client);

    const counts = await scheduler.runCycle(new Date("2026-05-26T15:00:00.000Z").getTime());

    expect(counts).toEqual({
      evaluated: 1,
      sent: 0,
      deduped: 0,
      skipped: 1,
      failed: 0,
    });
    expect(trackedMessageService.claimFwaBasesChecklistReminderMarker).not.toHaveBeenCalled();
    expect(client.channels.fetch).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(dozzleLogMock.info).toHaveBeenCalledWith(
      expect.stringContaining("reason=bases_completion_exists"),
    );
  });

  it("counts a deduped marker and skips sending", async () => {
    plannerMocks.findPending.mockResolvedValue([makeCandidate()]);
    vi.mocked(trackedMessageService.claimFwaBasesChecklistReminderMarker).mockResolvedValueOnce(false as any);
    const { client, send } = makeClient();
    const scheduler = await createScheduler(client);

    const counts = await scheduler.runCycle(new Date("2026-05-26T15:00:00.000Z").getTime());

    expect(counts).toEqual({
      evaluated: 1,
      sent: 0,
      deduped: 1,
      skipped: 0,
      failed: 0,
    });
    expect(client.channels.fetch).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("skips MM clans without claiming a reminder marker or sending", async () => {
    plannerMocks.findPending.mockResolvedValue([makeCandidate({ matchType: "MM" })]);
    const { client, send } = makeClient();
    const scheduler = await createScheduler(client);

    const counts = await scheduler.runCycle(new Date("2026-05-26T15:00:00.000Z").getTime());

    expect(counts).toEqual({
      evaluated: 1,
      sent: 0,
      deduped: 0,
      skipped: 1,
      failed: 0,
    });
    expect(trackedMessageService.claimFwaBasesChecklistReminderMarker).not.toHaveBeenCalled();
    expect(client.channels.fetch).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(dozzleLogMock.info).toHaveBeenCalledWith(
      expect.stringContaining("reason=mm_match_type"),
    );
  });

  it("skips a candidate when no destination channel is configured", async () => {
    plannerMocks.findPending.mockResolvedValue([makeCandidate({ destinationChannelId: null, destinationChannelKind: null })]);
    const { client, send } = makeClient();
    const scheduler = await createScheduler(client);

    const counts = await scheduler.runCycle(new Date("2026-05-26T15:00:00.000Z").getTime());

    expect(counts).toEqual({
      evaluated: 1,
      sent: 0,
      deduped: 0,
      skipped: 1,
      failed: 0,
    });
    expect(client.channels.fetch).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(dozzleLogMock.warn).toHaveBeenCalledWith(
      expect.stringContaining("reason=missing_channel"),
    );
    expect(dozzleLogMock.warn).toHaveBeenCalledWith(
      expect.stringContaining("bucketHours=3"),
    );
  });

  it("skips a candidate when the configured channel is unavailable", async () => {
    plannerMocks.findPending.mockResolvedValue([makeCandidate()]);
    const { client, send } = makeClient({
      channel: {},
    });
    const scheduler = await createScheduler(client);

    const counts = await scheduler.runCycle(new Date("2026-05-26T15:00:00.000Z").getTime());

    expect(counts).toEqual({
      evaluated: 1,
      sent: 0,
      deduped: 0,
      skipped: 1,
      failed: 0,
    });
    expect(send).not.toHaveBeenCalled();
    expect(dozzleLogMock.warn).toHaveBeenCalledWith(
      expect.stringContaining("reason=unavailable_channel"),
    );
    expect(dozzleLogMock.warn).toHaveBeenCalledWith(
      expect.stringContaining("destinationChannelId="),
    );
  });

  it("counts a failed send when Discord rejects the reminder", async () => {
    plannerMocks.findPending.mockResolvedValue([makeCandidate()]);
    const { client, send } = makeClient();
    send.mockRejectedValueOnce({ code: 50013, message: "missing perms" });
    const scheduler = await createScheduler(client);

    const counts = await scheduler.runCycle(new Date("2026-05-26T15:00:00.000Z").getTime());

    expect(counts).toEqual({
      evaluated: 1,
      sent: 0,
      deduped: 0,
      skipped: 0,
      failed: 1,
    });
    expect(dozzleLogMock.error).toHaveBeenCalledWith(
      expect.stringContaining("reason=missing_permissions"),
    );
    expect(dozzleLogMock.error).toHaveBeenCalledWith(
      expect.stringContaining("bucketHours=3"),
    );
  });

  it("skips cycle execution in mirror and staging modes", async () => {
    const { client } = makeClient();
    const scheduler = await createScheduler(client);

    pollingModeMock.isMirrorPollingMode.mockReturnValueOnce(true);
    await expect(scheduler.runCycle()).resolves.toEqual({
      evaluated: 0,
      sent: 0,
      deduped: 0,
      skipped: 0,
      failed: 0,
    });
    expect(plannerMocks.findPending).not.toHaveBeenCalled();

    pollingModeMock.isMirrorPollingMode.mockReturnValueOnce(false);
    pollingModeMock.resolveRuntimeEnvironment.mockReturnValueOnce("staging");
    await expect(scheduler.runCycle()).resolves.toEqual({
      evaluated: 0,
      sent: 0,
      deduped: 0,
      skipped: 0,
      failed: 0,
    });
    expect(plannerMocks.findPending).not.toHaveBeenCalled();
  });

  it("prevents overlapping cycles with an in-flight guard", async () => {
    let resolvePending: ((value: FwaBasesChecklistReminderCandidate[]) => void) | null = null;
    plannerMocks.findPending.mockImplementation(
      () =>
        new Promise<FwaBasesChecklistReminderCandidate[]>((resolve) => {
          resolvePending = resolve;
        }),
    );
    const { client } = makeClient();
    const scheduler = await createScheduler(client);

    const firstRun = scheduler.runCycle();
    const secondRun = scheduler.runCycle();

    await expect(secondRun).resolves.toEqual({
      evaluated: 0,
      sent: 0,
      deduped: 0,
      skipped: 0,
      failed: 0,
    });

    resolvePending?.([]);
    await expect(firstRun).resolves.toEqual({
      evaluated: 0,
      sent: 0,
      deduped: 0,
      skipped: 0,
      failed: 0,
    });
  });
});
