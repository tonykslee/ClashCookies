import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  trackedMessage: {
    findMany: vi.fn(),
  },
}));

const autoPostMock = vi.hoisted(() => ({
  postForSyncTrackedMessage: vi.fn(),
}));

const pollingModeMock = vi.hoisted(() => ({
  isMirrorPollingMode: vi.fn(() => false),
  resolveRuntimeEnvironment: vi.fn(() => "test"),
}));

const dozzleLogMock = vi.hoisted(() => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const SYNC_EPOCH_SECONDS = Math.floor(
  new Date("2026-05-13T00:00:00.000Z").getTime() / 1000,
);
const SYNC_FALLBACK_EXPIRES_AT = new Date(
  (SYNC_EPOCH_SECONDS * 1000) + 48 * 60 * 60 * 1000,
);

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/helper/dozzleLogger", () => ({
  dozzleLog: dozzleLogMock,
}));

vi.mock("../src/services/PollingModeService", () => pollingModeMock);

vi.mock("../src/services/fwa/matchChecklistAutoPostService", () => ({
  fwaMatchChecklistAutoPostService: autoPostMock,
}));

import { FwaMatchChecklistAutoPostSchedulerService } from "../src/services/fwa/matchChecklistAutoPostSchedulerService";

function makeClient() {
  return {
    guilds: {
      fetch: vi.fn(),
    },
  } as any;
}

function makeTrackedSyncMessage(syncEpochSeconds: number) {
  return {
    guildId: "guild-1",
    channelId: "sync-channel-1",
    messageId: "sync-message-1",
    expiresAt: new Date((syncEpochSeconds + 60 * 60) * 1000),
    createdAt: new Date(syncEpochSeconds * 1000),
    metadata: {
      syncTimeIso: new Date(syncEpochSeconds * 1000).toISOString(),
      syncEpochSeconds,
      roleId: "role-1",
      clans: [
        {
          code: "RR",
          clanTag: "#PYPY",
          clanName: "Rocky Road",
          emojiId: "111",
          emojiName: "rr",
          emojiInline: "<:rr:111>",
        },
      ],
    },
  };
}

describe("FwaMatchChecklistAutoPostSchedulerService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (autoPostMock as any).__seen = new Set<string>();
    autoPostMock.postForSyncTrackedMessage.mockImplementation(async ({ viewType }: { viewType: "Mail" | "Bases" }) => {
      const resultKey = `posted:${viewType}`;
      const seen = (autoPostMock as any).__seen ?? ((autoPostMock as any).__seen = new Set<string>());
      if (seen.has(resultKey)) {
        return { posted: 0, skipped: 1, failed: 0 };
      }
      seen.add(resultKey);
      return { posted: 1, skipped: 0, failed: 0 };
    });
  });

  it("posts nothing before sync+1m", async () => {
    prismaMock.trackedMessage.findMany.mockResolvedValue([makeTrackedSyncMessage(SYNC_EPOCH_SECONDS)]);
    const scheduler = new FwaMatchChecklistAutoPostSchedulerService(makeClient());

    const counts = await scheduler.runCycle(new Date("2026-05-13T00:00:59.000Z").getTime());

    expect(counts).toEqual({ evaluated: 1, due: 0, posted: 0, skipped: 0, failed: 0 });
    expect(autoPostMock.postForSyncTrackedMessage).not.toHaveBeenCalled();
  });

  it("posts Mail at sync+1m and Bases at sync+2m", async () => {
    prismaMock.trackedMessage.findMany.mockResolvedValue([makeTrackedSyncMessage(SYNC_EPOCH_SECONDS)]);
    const scheduler = new FwaMatchChecklistAutoPostSchedulerService(makeClient());

    const mailCounts = await scheduler.runCycle(new Date("2026-05-13T00:01:00.000Z").getTime());
    expect(mailCounts).toEqual({ evaluated: 1, due: 1, posted: 1, skipped: 0, failed: 0 });
    expect(autoPostMock.postForSyncTrackedMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        viewType: "Mail",
        tracked: expect.objectContaining({
          messageId: "sync-message-1",
          fallbackExpiresAt: SYNC_FALLBACK_EXPIRES_AT,
        }),
      }),
    );

    const basesCounts = await scheduler.runCycle(new Date("2026-05-13T00:02:00.000Z").getTime());
    expect(basesCounts).toEqual({ evaluated: 1, due: 2, posted: 1, skipped: 1, failed: 0 });
    expect(autoPostMock.postForSyncTrackedMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        viewType: "Bases",
        tracked: expect.objectContaining({
          messageId: "sync-message-1",
          fallbackExpiresAt: SYNC_FALLBACK_EXPIRES_AT,
        }),
      }),
    );
  });

  it("ignores expired sync posts and does not call auto-post", async () => {
    prismaMock.trackedMessage.findMany.mockResolvedValue([
      {
        ...makeTrackedSyncMessage(SYNC_EPOCH_SECONDS),
        expiresAt: new Date("2026-05-13T00:00:30.000Z"),
      },
    ]);
    const scheduler = new FwaMatchChecklistAutoPostSchedulerService(makeClient());

    const counts = await scheduler.runCycle(new Date("2026-05-13T00:02:00.000Z").getTime());

    expect(counts).toEqual({ evaluated: 0, due: 0, posted: 0, skipped: 1, failed: 0 });
    expect(autoPostMock.postForSyncTrackedMessage).not.toHaveBeenCalled();
    expect(dozzleLogMock.info).toHaveBeenCalledWith(
      expect.stringContaining("event=skipped_expired_or_outside_window"),
    );
  });

  it("does not duplicate checklist posts on a rerun", async () => {
    prismaMock.trackedMessage.findMany.mockResolvedValue([makeTrackedSyncMessage(SYNC_EPOCH_SECONDS)]);
    const scheduler = new FwaMatchChecklistAutoPostSchedulerService(makeClient());

    await scheduler.runCycle(new Date("2026-05-13T00:02:00.000Z").getTime());
    const duplicateCounts = await scheduler.runCycle(new Date("2026-05-13T00:02:00.000Z").getTime());

    expect(duplicateCounts).toEqual({ evaluated: 1, due: 2, posted: 0, skipped: 2, failed: 0 });
  });

  it("does not start in mirror or staging mode", () => {
    const scheduler = new FwaMatchChecklistAutoPostSchedulerService(makeClient());

    pollingModeMock.isMirrorPollingMode.mockReturnValue(true);
    expect(scheduler.start()).toEqual({ started: false, reason: "mirror" });

    pollingModeMock.isMirrorPollingMode.mockReturnValue(false);
    pollingModeMock.resolveRuntimeEnvironment.mockReturnValue("staging");
    expect(scheduler.start()).toEqual({ started: false, reason: "staging" });
  });
});
