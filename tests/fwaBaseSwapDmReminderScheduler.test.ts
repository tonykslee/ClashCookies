import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildFwaBaseSwapDmReminderClaimKey,
  type FwaBaseSwapDmReminderCandidate,
} from "../src/services/fwa/baseSwapDmReminderService";

const plannerMocks = vi.hoisted(() => ({
  findPending: vi.fn(),
  claim: vi.fn(),
  release: vi.fn(),
  buildContent: vi.fn(() => "DM CONTENT"),
}));

const dozzleLogMock = vi.hoisted(() => ({
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
}));

const prismaMock = vi.hoisted(() => {
  const state = {
    guildRows: [{ guildId: "guild-1" }],
    pendingTrackedRows: [] as any[],
    trackedClanRow: null as null | {
      tag: string;
      name: string | null;
      leaderChannelId: string | null;
    },
  };

  return {
    state,
    trackedMessageFindMany: vi.fn((args: any) => {
      if (args?.select?.guildId) {
        return Promise.resolve([...state.guildRows]);
      }
      if (args?.select?.metadata) {
        return Promise.resolve([...state.pendingTrackedRows]);
      }
      return Promise.resolve([]);
    }),
    trackedClanFindFirst: vi.fn(() => Promise.resolve(state.trackedClanRow)),
  };
});

const claimedClaimKeys = new Set<string>();

function getClaimKey(candidate: Pick<
  FwaBaseSwapDmReminderCandidate,
  "trackedMessageId" | "referenceId" | "discordUserId" | "dueOffsetHours"
>): string {
  return buildFwaBaseSwapDmReminderClaimKey({
    trackedMessageId: candidate.trackedMessageId,
    referenceId: candidate.referenceId,
    discordUserId: candidate.discordUserId,
    offsetHours: candidate.dueOffsetHours,
  });
}

vi.mock("../src/prisma", () => ({
  prisma: {
    trackedMessage: {
      findMany: prismaMock.trackedMessageFindMany,
    },
    trackedClan: {
      findFirst: prismaMock.trackedClanFindFirst,
    },
    trackedMessageClaim: {
      findFirst: prismaMock.trackedMessageClaimFindFirst,
      createMany: prismaMock.trackedMessageClaimCreateMany,
    },
  },
}));

vi.mock("../src/helper/dozzleLogger", () => ({
  dozzleLog: dozzleLogMock,
}));

type ClientLike = {
  users: {
    fetch: ReturnType<typeof vi.fn>;
  };
  channels: {
    fetch: ReturnType<typeof vi.fn>;
  };
};

function makeCandidate(overrides: Partial<FwaBaseSwapDmReminderCandidate> & { discordUserId: string }): FwaBaseSwapDmReminderCandidate {
  return {
    guildId: "guild-1",
    clanTag: "#ABC",
    clanName: "Alpha Clan",
    matchType: "BL",
    trackedMessageId: "tracked-1",
    referenceId: "reference-1",
    channelId: "channel-1",
    messageId: "message-1",
    postUrl: "https://discord.com/channels/guild-1/channel-1/message-1",
    discordUserId: overrides.discordUserId,
    battleDayStart: new Date("2026-05-26T18:00:00.000Z"),
    dueOffsetHours: 6,
    remainingOffsetHours: [3, 1],
    entries: [
      {
        position: 12,
        playerTag: "#P1",
        playerName: "Player One",
        section: "fwa_bases",
      },
    ],
    ...overrides,
  };
}

function makePendingTrackedRow(input: {
  candidate: FwaBaseSwapDmReminderCandidate;
  clanKind: "FWA" | "CWL";
  swapReminder: boolean;
  entries: Array<{
    position: number;
    playerTag: string;
    playerName: string;
    section: "war_bases" | "base_errors" | "fwa_bases";
    discordUserId: string;
    acknowledged: boolean;
  }>;
  trackedMessageId?: string;
  referenceId?: string | null;
  createdAt?: string;
  expiresAt?: string;
}) {
  return {
    id: input.trackedMessageId ?? input.candidate.trackedMessageId,
    guildId: input.candidate.guildId,
    channelId: input.candidate.channelId,
    messageId: input.candidate.messageId,
    referenceId: input.referenceId ?? input.candidate.referenceId,
    clanTag: input.candidate.clanTag,
    createdAt: new Date(input.createdAt ?? "2026-06-27T16:00:58.000Z"),
    expiresAt: new Date(input.expiresAt ?? "2026-06-27T19:00:58.000Z"),
    metadata: {
      clanKind: input.clanKind,
      clanName: input.candidate.clanName,
      createdByUserId: "321",
      createdAtIso: input.createdAt ?? "2026-06-27T16:00:58.000Z",
      swapReminder: input.swapReminder,
      entries: input.entries,
    },
  };
}

const pendingUserIds = new Set<string>();

function setPendingUserIds(userIds: string[]): void {
  pendingUserIds.clear();
  for (const userId of userIds) {
    pendingUserIds.add(userId);
  }
}

function makeClient(input?: {
  userFetchFailures?: Record<string, Error>;
  userSendFailures?: Record<string, Error>;
  leaderChannelId?: string | null;
}): {
  client: ClientLike;
  userSendSpies: Map<string, ReturnType<typeof vi.fn>>;
  leaderChannelSend: ReturnType<typeof vi.fn>;
  resolveLeaderChannel: ReturnType<typeof vi.fn>;
} {
  const userSendSpies = new Map<string, ReturnType<typeof vi.fn>>();
  const leaderChannelSend = vi.fn().mockResolvedValue(undefined);
  const resolveLeaderChannel = vi.fn(async ({ clanTag }: { clanTag: string }) => {
    if (input?.leaderChannelId === null) return null;
    return {
      clanName: "Alpha Clan",
      clanTag,
      channelId: input?.leaderChannelId ?? "leader-channel-1",
      send: async (payload: unknown) => {
        await leaderChannelSend(payload);
      },
    };
  });

  const client: ClientLike = {
    users: {
      fetch: vi.fn(async (discordUserId: string) => {
        const failure = input?.userFetchFailures?.[discordUserId] ?? null;
        if (failure) throw failure;
        const send = vi.fn(async () => {
          const failure = input?.userSendFailures?.[discordUserId] ?? null;
          if (failure) throw failure;
        });
        userSendSpies.set(discordUserId, send);
        return {
          id: discordUserId,
          send,
        };
      }),
    },
    channels: {
      fetch: vi.fn(async () => {
        if (input?.leaderChannelId === null) return null;
        return {
          isTextBased: () => true,
          send: leaderChannelSend,
        };
      }),
    },
  };

  return { client, userSendSpies, leaderChannelSend, resolveLeaderChannel };
}

async function createScheduler(
  client: ClientLike,
  resolveLeaderChannel?: ReturnType<typeof vi.fn>,
  intervalMs = 60_000,
  options?: {
    useActualStillPending?: boolean;
  },
) {
  vi.resetModules();
  const { FwaBaseSwapDmReminderSchedulerService } = await import(
    "../src/services/fwa/baseSwapDmReminderSchedulerService"
  );
  return new FwaBaseSwapDmReminderSchedulerService(client as any, intervalMs, {
    findPendingCandidates: plannerMocks.findPending,
    claimCandidate: plannerMocks.claim,
    releaseCandidate: plannerMocks.release,
    buildDmContent: plannerMocks.buildContent,
    ...(options?.useActualStillPending
      ? {}
      : { stillPending: async ({ candidate }) => pendingUserIds.has(candidate.discordUserId) }),
    ...(resolveLeaderChannel ? { resolveLeaderChannel } : {}),
  });
}

describe("FwaBaseSwapDmReminderSchedulerService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.state.guildRows = [{ guildId: "guild-1" }];
    prismaMock.state.pendingTrackedRows = [];
    prismaMock.state.trackedClanRow = {
      tag: "#ABC",
      name: "Alpha Clan",
      leaderChannelId: "leader-channel-1",
    };
    pendingUserIds.clear();
    claimedClaimKeys.clear();
    plannerMocks.findPending.mockReset();
    plannerMocks.claim.mockReset();
    plannerMocks.release.mockReset();
    plannerMocks.buildContent.mockReset();
    plannerMocks.buildContent.mockReturnValue("DM CONTENT");
    plannerMocks.findPending.mockResolvedValue([]);
    plannerMocks.claim.mockImplementation(async ({ candidate }: { candidate: FwaBaseSwapDmReminderCandidate }) => {
      const key = getClaimKey(candidate);
      if (claimedClaimKeys.has(key)) return false;
      claimedClaimKeys.add(key);
      return true;
    });
    plannerMocks.release.mockImplementation(async ({ candidate }: { candidate: FwaBaseSwapDmReminderCandidate }) => {
      const key = getClaimKey(candidate);
      const deleted = claimedClaimKeys.delete(key);
      return {
        released: true,
        deletedCount: deleted ? 1 : 0,
      };
    });
  });

  it("sends the incident-shaped FWA reminder when swapReminder is false", async () => {
    const candidate = makeCandidate({
      discordUserId: "143827744717799425",
      clanTag: "#2QVGPQP0U",
      clanName: "Eternal Blaze",
      matchType: "FWA",
      trackedMessageId: "cmqvu48i615324b9ylndebena",
      referenceId: null,
      channelId: "1496618317048184833",
      messageId: "1520278283806052393",
      postUrl:
        "https://discord.com/channels/1324040917602013261/1496618317048184833/1520278283806052393",
      battleDayStart: new Date("2026-06-27T20:00:58.000Z"),
      dueOffsetHours: 3,
      remainingOffsetHours: [1],
      entries: [
        {
          position: 11,
          playerTag: "#8QURGQ8UV",
          playerName: "Bluey!",
          section: "war_bases",
        },
      ],
    });
    plannerMocks.findPending.mockResolvedValue([candidate]);
    prismaMock.state.pendingTrackedRows = [
      {
        id: "tracked-incident-1",
        guildId: candidate.guildId,
        channelId: candidate.channelId,
        messageId: candidate.messageId,
        referenceId: candidate.referenceId,
        clanTag: candidate.clanTag,
        createdAt: new Date("2026-06-27T16:00:58.000Z"),
        expiresAt: new Date("2026-06-27T19:00:58.000Z"),
        metadata: {
          clanKind: "FWA",
          clanName: "Eternal Blaze",
          createdByUserId: "321",
          createdAtIso: "2026-06-27T16:00:58.000Z",
          swapReminder: false,
          entries: [
            {
              position: 11,
              playerTag: "#8QURGQ8UV",
              playerName: "Bluey!",
              discordUserId: "143827744717799425",
              townhallLevel: null,
              section: "war_bases",
              acknowledged: false,
            },
          ],
        },
      },
    ];
    const { client, userSendSpies, resolveLeaderChannel } = makeClient();
    const scheduler = await createScheduler(client, resolveLeaderChannel, 60_000, {
      useActualStillPending: true,
    });

    const counts = await scheduler.runCycle(new Date("2026-06-27T17:00:58.000Z").getTime());

    expect(counts).toEqual({
      evaluated: 1,
      sent: 1,
      deduped: 0,
      failed: 0,
      logFailed: 0,
    });
    expect(plannerMocks.claim).toHaveBeenCalledTimes(1);
    expect(plannerMocks.release).not.toHaveBeenCalled();
    expect(client.users.fetch).toHaveBeenCalledWith("143827744717799425");
    expect(userSendSpies.get("143827744717799425")).toHaveBeenCalledTimes(1);
    expect(plannerMocks.buildContent).toHaveBeenCalledTimes(1);
    expect(prismaMock.trackedMessageFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ metadata: true }),
      }),
    );
  });

  it("skips an acknowledged CWL reminder when the real pending check rejects it", async () => {
    const candidate = makeCandidate({
      discordUserId: "143827744717799425",
      clanTag: "#2QVGPQP0U",
      clanName: "Eternal Blaze",
      matchType: "CWL",
      trackedMessageId: "tracked-cwl-1",
      referenceId: null,
      channelId: "1496618317048184833",
      messageId: "1520278283806052393",
      postUrl:
        "https://discord.com/channels/1324040917602013261/1496618317048184833/1520278283806052393",
      battleDayStart: new Date("2026-06-27T20:00:58.000Z"),
      dueOffsetHours: 3,
      remainingOffsetHours: [1],
      entries: [
        {
          position: 11,
          playerTag: "#8QURGQ8UV",
          playerName: "Bluey!",
          section: "war_bases",
        },
      ],
    });
    plannerMocks.findPending.mockResolvedValue([candidate]);
    prismaMock.state.pendingTrackedRows = [
      {
        id: "tracked-cwl-1",
        guildId: candidate.guildId,
        channelId: candidate.channelId,
        messageId: candidate.messageId,
        referenceId: candidate.referenceId,
        clanTag: candidate.clanTag,
        createdAt: new Date("2026-06-27T16:00:58.000Z"),
        expiresAt: new Date("2026-06-27T19:00:58.000Z"),
        metadata: {
          clanKind: "CWL",
          clanName: "Eternal Blaze",
          createdByUserId: "321",
          createdAtIso: "2026-06-27T16:00:58.000Z",
          swapReminder: false,
          entries: [
            {
              position: 11,
              playerTag: "#8QURGQ8UV",
              playerName: "Bluey!",
              discordUserId: "143827744717799425",
              townhallLevel: null,
              section: "war_bases",
              acknowledged: true,
            },
          ],
        },
      },
    ];
    const { client, resolveLeaderChannel } = makeClient();
    const scheduler = await createScheduler(client, resolveLeaderChannel, 60_000, {
      useActualStillPending: true,
    });

    const counts = await scheduler.runCycle(new Date("2026-06-27T17:00:58.000Z").getTime());

    expect(counts).toEqual({
      evaluated: 1,
      sent: 0,
      deduped: 1,
      failed: 0,
      logFailed: 0,
    });
    expect(client.users.fetch).not.toHaveBeenCalled();
    expect(client.channels.fetch).not.toHaveBeenCalled();
    expect(plannerMocks.claim).not.toHaveBeenCalled();
    expect(plannerMocks.release).not.toHaveBeenCalled();
    expect(prismaMock.trackedMessageFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ metadata: true }),
      }),
    );
  });

  it("does not claim or deliver when stillPending is false", async () => {
    const candidate = makeCandidate({ discordUserId: "111" });
    plannerMocks.findPending.mockResolvedValue([candidate]);
    const { client, resolveLeaderChannel } = makeClient();
    setPendingUserIds([]);
    const scheduler = await createScheduler(client, resolveLeaderChannel);

    const counts = await scheduler.runCycle(new Date("2026-06-27T17:00:58.000Z").getTime());

    expect(counts).toEqual({
      evaluated: 1,
      sent: 0,
      deduped: 1,
      failed: 0,
      logFailed: 0,
    });
    expect(plannerMocks.claim).not.toHaveBeenCalled();
    expect(plannerMocks.release).not.toHaveBeenCalled();
    expect(client.users.fetch).not.toHaveBeenCalled();
    expect(dozzleLogMock.debug.mock.calls.some(([message]) => String(message).includes("reason=no_longer_pending"))).toBe(true);
  });

  it("sends a CWL reminder when the real pending check sees swapReminder true", async () => {
    const candidate = makeCandidate({
      discordUserId: "143827744717799425",
      clanTag: "#2QVGPQP0U",
      clanName: "Eternal Blaze",
      matchType: "CWL",
      trackedMessageId: "tracked-cwl-true",
      referenceId: null,
      channelId: "1496618317048184833",
      messageId: "1520278283806052393",
      postUrl:
        "https://discord.com/channels/1324040917602013261/1496618317048184833/1520278283806052393",
      battleDayStart: new Date("2026-06-27T20:00:58.000Z"),
      dueOffsetHours: 3,
      remainingOffsetHours: [1],
      entries: [
        {
          position: 11,
          playerTag: "#8QURGQ8UV",
          playerName: "Bluey!",
          section: "war_bases",
        },
      ],
    });
    plannerMocks.findPending.mockResolvedValue([candidate]);
    prismaMock.state.pendingTrackedRows = [
      {
        id: "tracked-cwl-true",
        guildId: candidate.guildId,
        channelId: candidate.channelId,
        messageId: candidate.messageId,
        referenceId: candidate.referenceId,
        clanTag: candidate.clanTag,
        createdAt: new Date("2026-06-27T16:00:58.000Z"),
        expiresAt: new Date("2026-06-27T19:00:58.000Z"),
        metadata: {
          clanKind: "CWL",
          clanName: "Eternal Blaze",
          createdByUserId: "321",
          createdAtIso: "2026-06-27T16:00:58.000Z",
          swapReminder: true,
          entries: [
            {
              position: 11,
              playerTag: "#8QURGQ8UV",
              playerName: "Bluey!",
              discordUserId: "143827744717799425",
              townhallLevel: null,
              section: "war_bases",
              acknowledged: false,
            },
          ],
        },
      },
    ];
    const { client, userSendSpies, resolveLeaderChannel } = makeClient();
    const scheduler = await createScheduler(client, resolveLeaderChannel, 60_000, {
      useActualStillPending: true,
    });

    const counts = await scheduler.runCycle(new Date("2026-06-27T17:00:58.000Z").getTime());

    expect(counts).toEqual({
      evaluated: 1,
      sent: 1,
      deduped: 0,
      failed: 0,
      logFailed: 0,
    });
    expect(plannerMocks.claim).toHaveBeenCalledTimes(1);
    expect(client.users.fetch).toHaveBeenCalledWith("143827744717799425");
    expect(userSendSpies.get("143827744717799425")).toHaveBeenCalledTimes(1);
    expect(plannerMocks.buildContent).toHaveBeenCalledTimes(1);
    expect(prismaMock.trackedMessageFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ metadata: true }),
      }),
    );
  });

  it("retains the claim after successful delivery so a later cycle dedupes it", async () => {
    const candidate = makeCandidate({ discordUserId: "111" });
    plannerMocks.findPending.mockResolvedValue([candidate]);
    setPendingUserIds(["111"]);
    const { client, userSendSpies, leaderChannelSend, resolveLeaderChannel } = makeClient();
    const scheduler = await createScheduler(client, resolveLeaderChannel);

    const firstCounts = await scheduler.runCycle(new Date("2026-06-27T17:00:58.000Z").getTime());
    const secondCounts = await scheduler.runCycle(new Date("2026-06-27T17:00:58.000Z").getTime());

    expect(firstCounts).toEqual({
      evaluated: 1,
      sent: 1,
      deduped: 0,
      failed: 0,
      logFailed: 0,
    });
    expect(secondCounts).toEqual({
      evaluated: 1,
      sent: 0,
      deduped: 1,
      failed: 0,
      logFailed: 0,
    });
    expect(plannerMocks.release).not.toHaveBeenCalled();
    expect(plannerMocks.claim).toHaveBeenCalledTimes(2);
    expect(client.users.fetch).toHaveBeenCalledTimes(1);
    expect(userSendSpies.get("111")).toHaveBeenCalledTimes(1);
    expect(leaderChannelSend).toHaveBeenCalledTimes(1);
  });

  it("releases a claim after a retryable user-fetch failure and succeeds on the next cycle", async () => {
    const candidate = makeCandidate({ discordUserId: "111" });
    plannerMocks.findPending.mockResolvedValue([candidate]);
    setPendingUserIds(["111"]);
    const fetchFailures: Record<string, Error> = {
      "111": Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
    };
    const { client, leaderChannelSend, resolveLeaderChannel } = makeClient({
      userFetchFailures: fetchFailures,
    });
    const scheduler = await createScheduler(client, resolveLeaderChannel);

    const firstCounts = await scheduler.runCycle(new Date("2026-06-27T17:00:58.000Z").getTime());
    delete fetchFailures["111"];
    const secondCounts = await scheduler.runCycle(new Date("2026-06-27T17:00:58.000Z").getTime());

    expect(firstCounts).toEqual({
      evaluated: 1,
      sent: 0,
      deduped: 0,
      failed: 1,
      logFailed: 0,
    });
    expect(secondCounts).toEqual({
      evaluated: 1,
      sent: 1,
      deduped: 0,
      failed: 0,
      logFailed: 0,
    });
    expect(plannerMocks.release).toHaveBeenCalledTimes(1);
    expect(leaderChannelSend).toHaveBeenCalledTimes(2);
  });

  it("releases a claim after a retryable DM-send failure and succeeds on the next cycle", async () => {
    const candidate = makeCandidate({ discordUserId: "111" });
    plannerMocks.findPending.mockResolvedValue([candidate]);
    setPendingUserIds(["111"]);
    const sendFailures: Record<string, Error> = {
      "111": Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
    };
    const { client, leaderChannelSend, resolveLeaderChannel } = makeClient({
      userSendFailures: sendFailures,
    });
    const scheduler = await createScheduler(client, resolveLeaderChannel);

    const firstCounts = await scheduler.runCycle(new Date("2026-06-27T17:00:58.000Z").getTime());
    delete sendFailures["111"];
    const secondCounts = await scheduler.runCycle(new Date("2026-06-27T17:00:58.000Z").getTime());

    expect(firstCounts).toEqual({
      evaluated: 1,
      sent: 0,
      deduped: 0,
      failed: 1,
      logFailed: 0,
    });
    expect(secondCounts).toEqual({
      evaluated: 1,
      sent: 1,
      deduped: 0,
      failed: 0,
      logFailed: 0,
    });
    expect(plannerMocks.release).toHaveBeenCalledTimes(1);
    expect(leaderChannelSend).toHaveBeenCalledTimes(2);
  });

  it("retains a closed-DM claim and dedupes the same offset on the next cycle", async () => {
    const candidate = makeCandidate({ discordUserId: "111" });
    plannerMocks.findPending.mockResolvedValue([candidate]);
    setPendingUserIds(["111"]);
    const sendFailures: Record<string, Error> = {
      "111": Object.assign(new Error("Cannot send messages to this user"), { code: 50007 }),
    };
    const { client, resolveLeaderChannel } = makeClient({
      userSendFailures: sendFailures,
    });
    const scheduler = await createScheduler(client, resolveLeaderChannel);

    const firstCounts = await scheduler.runCycle(new Date("2026-06-27T17:00:58.000Z").getTime());
    const secondCounts = await scheduler.runCycle(new Date("2026-06-27T17:00:58.000Z").getTime());

    expect(firstCounts).toEqual({
      evaluated: 1,
      sent: 0,
      deduped: 0,
      failed: 1,
      logFailed: 0,
    });
    expect(secondCounts).toEqual({
      evaluated: 1,
      sent: 0,
      deduped: 1,
      failed: 0,
      logFailed: 0,
    });
    expect(plannerMocks.release).not.toHaveBeenCalled();
    expect(client.users.fetch).toHaveBeenCalledTimes(1);
  });

  it("completes the cycle when claim release fails after a retryable delivery error", async () => {
    const candidate = makeCandidate({ discordUserId: "111" });
    plannerMocks.findPending.mockResolvedValue([candidate]);
    setPendingUserIds(["111"]);
    plannerMocks.release.mockRejectedValueOnce(new Error("release boom"));
    const sendFailures: Record<string, Error> = {
      "111": Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
    };
    const { client, resolveLeaderChannel } = makeClient({
      userSendFailures: sendFailures,
    });
    const scheduler = await createScheduler(client, resolveLeaderChannel);

    const counts = await scheduler.runCycle(new Date("2026-06-27T17:00:58.000Z").getTime());

    expect(counts).toEqual({
      evaluated: 1,
      sent: 0,
      deduped: 0,
      failed: 1,
      logFailed: 0,
    });
    expect(plannerMocks.release).toHaveBeenCalledTimes(1);
    expect(
      dozzleLogMock.error.mock.calls.some(
        ([message]) =>
          String(message).includes("claim_release_failed") &&
          String(message).includes("claim_action=release_failed") &&
          String(message).includes("stage=dm_send"),
      ),
    ).toBe(true);
  });

  it("keeps evaluating later candidates after an earlier retryable failure", async () => {
    const candidateOne = makeCandidate({ discordUserId: "111" });
    const candidateTwo = makeCandidate({
      discordUserId: "222",
      entries: [
        {
          position: 19,
          playerTag: "#P2",
          playerName: "Player Two",
          section: "fwa_bases",
        },
      ],
    });
    plannerMocks.findPending.mockResolvedValue([candidateOne, candidateTwo]);
    setPendingUserIds(["111", "222"]);
    const fetchFailures: Record<string, Error> = {
      "111": Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
    };
    const { client, leaderChannelSend, resolveLeaderChannel } = makeClient({
      userFetchFailures: fetchFailures,
    });
    const scheduler = await createScheduler(client, resolveLeaderChannel);

    const counts = await scheduler.runCycle(new Date("2026-06-27T17:00:58.000Z").getTime());

    expect(counts).toEqual({
      evaluated: 2,
      sent: 1,
      deduped: 0,
      failed: 1,
      logFailed: 0,
    });
    expect(plannerMocks.release).toHaveBeenCalledTimes(1);
    expect(leaderChannelSend).toHaveBeenCalledTimes(1);
    expect(client.users.fetch).toHaveBeenCalledTimes(2);
  });

  it("sends a DM and posts a grouped leader log for a due candidate", async () => {
    const candidate = makeCandidate({ discordUserId: "111" });
    plannerMocks.findPending.mockResolvedValue([candidate]);
    setPendingUserIds(["111"]);
    const { client, userSendSpies, leaderChannelSend, resolveLeaderChannel } = makeClient();
    const scheduler = await createScheduler(client, resolveLeaderChannel);

    const counts = await scheduler.runCycle(new Date("2026-05-26T12:00:00.000Z").getTime());

    expect(counts).toEqual({
      evaluated: 1,
      sent: 1,
      deduped: 0,
      failed: 0,
      logFailed: 0,
    });
    expect(plannerMocks.buildContent).toHaveBeenCalledTimes(1);
    expect(userSendSpies.get("111")).toHaveBeenCalledWith({ content: "DM CONTENT" });
    expect(leaderChannelSend).toHaveBeenCalledTimes(1);
    expect(leaderChannelSend.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        allowedMentions: { parse: [] },
        content: expect.stringContaining("Base-swap DM reminders"),
      }),
    );
    expect(leaderChannelSend.mock.calls[0]?.[0].content).toContain("Clan: Alpha Clan");
    expect(leaderChannelSend.mock.calls[0]?.[0].content).toContain("Sent:");
    expect(leaderChannelSend.mock.calls[0]?.[0].content).toContain("<@111>");
    expect(leaderChannelSend.mock.calls[0]?.[0].content).toContain("#12 Player One");
  });

  it("resolves the real tracked clan leader channel without double-prefixing the tag", async () => {
    const clanTag = "#PQL0289";
    const candidate = makeCandidate({ discordUserId: "111", clanTag });
    plannerMocks.findPending.mockResolvedValue([candidate]);
    setPendingUserIds(["111"]);
    const { client, userSendSpies, leaderChannelSend } = makeClient();
    prismaMock.trackedClanFindFirst.mockImplementation(async (args: any) => {
      const tags = Array.isArray(args?.where?.OR)
        ? args.where.OR.flatMap((clause: any) => String(clause?.tag?.equals ?? "").trim())
        : [String(args?.where?.tag?.equals ?? "").trim()];
      if (tags.includes(clanTag) || tags.includes(clanTag.replace(/^#/, ""))) {
        return {
          tag: clanTag,
          name: "Alpha Clan",
          leaderChannelId: "leader-channel-1",
        };
      }
      return null;
    });
    const scheduler = await createScheduler(client);

    const counts = await scheduler.runCycle(new Date("2026-05-26T12:00:00.000Z").getTime());

    expect(counts).toEqual({
      evaluated: 1,
      sent: 1,
      deduped: 0,
      failed: 0,
      logFailed: 0,
    });
    expect(client.channels.fetch).toHaveBeenCalledWith("leader-channel-1");
    expect(leaderChannelSend).toHaveBeenCalledTimes(1);
    expect(userSendSpies.get("111")).toHaveBeenCalledWith({ content: "DM CONTENT" });
    expect(prismaMock.trackedClanFindFirst).toHaveBeenCalledTimes(1);
    const firstCallWhere = prismaMock.trackedClanFindFirst.mock.calls[0]?.[0]?.where ?? {};
    const queriedTags = Array.isArray(firstCallWhere.OR)
      ? firstCallWhere.OR.map((clause: any) => String(clause?.tag?.equals ?? "").trim())
      : [String(firstCallWhere.tag?.equals ?? "").trim()];
    expect(queriedTags).toContain(clanTag);
    expect(queriedTags).toContain(clanTag.replace(/^#/, ""));
    expect(queriedTags).not.toContain(`##${clanTag.replace(/^#/, "")}`);
  });

  it("skips a candidate that is already claimed", async () => {
    const candidate = makeCandidate({ discordUserId: "111" });
    plannerMocks.findPending.mockResolvedValue([candidate]);
    plannerMocks.claim.mockResolvedValue(false);
    setPendingUserIds(["111"]);
    const { client, userSendSpies, leaderChannelSend, resolveLeaderChannel } = makeClient();
    const scheduler = await createScheduler(client, resolveLeaderChannel);

    const counts = await scheduler.runCycle();

    expect(counts).toEqual({
      evaluated: 1,
      sent: 0,
      deduped: 1,
      failed: 0,
      logFailed: 0,
    });
    expect(userSendSpies.size).toBe(0);
    expect(client.users.fetch).not.toHaveBeenCalled();
    expect(leaderChannelSend).not.toHaveBeenCalled();
  });

  it("counts a DM failure and still posts a leader-channel log", async () => {
    const candidate = makeCandidate({ discordUserId: "111" });
    plannerMocks.findPending.mockResolvedValue([candidate]);
    setPendingUserIds(["111"]);
    const { client, leaderChannelSend, resolveLeaderChannel } = makeClient({
      userSendFailures: {
        "111": new Error("DMs disabled"),
      },
    });
    const scheduler = await createScheduler(client, resolveLeaderChannel);

    const counts = await scheduler.runCycle();

    expect(counts).toEqual({
      evaluated: 1,
      sent: 0,
      deduped: 0,
      failed: 1,
      logFailed: 0,
    });
    expect(leaderChannelSend).toHaveBeenCalledTimes(1);
    expect(leaderChannelSend.mock.calls[0]?.[0].content).toContain("Failed:");
    expect(leaderChannelSend.mock.calls[0]?.[0].content).toContain("DMs disabled");
  });

  it("keeps sending DMs when no leader channel is configured", async () => {
    const candidate = makeCandidate({ discordUserId: "111" });
    plannerMocks.findPending.mockResolvedValue([candidate]);
    setPendingUserIds(["111"]);
    prismaMock.state.trackedClanRow = {
      tag: "#ABC",
      name: "Alpha Clan",
      leaderChannelId: null,
    };
    const { client, userSendSpies, leaderChannelSend, resolveLeaderChannel } = makeClient({
      leaderChannelId: null,
    });
    const scheduler = await createScheduler(client, resolveLeaderChannel);

    const counts = await scheduler.runCycle();

    expect(counts).toEqual({
      evaluated: 1,
      sent: 1,
      deduped: 0,
      failed: 0,
      logFailed: 1,
    });
    expect(userSendSpies.get("111")).toHaveBeenCalledTimes(1);
    expect(leaderChannelSend).not.toHaveBeenCalled();
    expect(client.channels.fetch).not.toHaveBeenCalled();
  });

  it("groups multiple users for the same clan/reference/offset into one leader log", async () => {
    const candidateOne = makeCandidate({ discordUserId: "111" });
    const candidateTwo = makeCandidate({
      discordUserId: "222",
      trackedMessageId: "tracked-2",
      messageId: "message-2",
      entries: [
        {
          position: 19,
          playerTag: "#P2",
          playerName: "Player Two",
          section: "fwa_bases",
        },
      ],
    });
    plannerMocks.findPending.mockResolvedValue([candidateOne, candidateTwo]);
    setPendingUserIds(["111", "222"]);
    const { client, leaderChannelSend, userSendSpies, resolveLeaderChannel } = makeClient();
    const scheduler = await createScheduler(client, resolveLeaderChannel);

    const counts = await scheduler.runCycle();

    expect(counts).toEqual({
      evaluated: 2,
      sent: 2,
      deduped: 0,
      failed: 0,
      logFailed: 0,
    });
    expect(userSendSpies.get("111")).toHaveBeenCalledTimes(1);
    expect(userSendSpies.get("222")).toHaveBeenCalledTimes(1);
    expect(leaderChannelSend).toHaveBeenCalledTimes(1);
    const content = String(leaderChannelSend.mock.calls[0]?.[0].content ?? "");
    expect(content).toContain("<@111>");
    expect(content).toContain("<@222>");
    expect(content).toContain("#12 Player One");
    expect(content).toContain("#19 Player Two");
  });

  it("prevents overlapping cycles with an in-flight guard", async () => {
    let resolvePending: ((value: FwaBaseSwapDmReminderCandidate[]) => void) | null = null;
    plannerMocks.findPending.mockImplementation(
      () =>
        new Promise<FwaBaseSwapDmReminderCandidate[]>((resolve) => {
          resolvePending = resolve;
        }),
    );
    const { client, resolveLeaderChannel } = makeClient();
    const scheduler = await createScheduler(client, resolveLeaderChannel);

    const firstRun = scheduler.runCycle();
    const secondRun = scheduler.runCycle();

    await expect(secondRun).resolves.toEqual({
      evaluated: 0,
      sent: 0,
      deduped: 0,
      failed: 0,
      logFailed: 0,
    });

    resolvePending?.([]);
    await expect(firstRun).resolves.toEqual({
      evaluated: 0,
      sent: 0,
      deduped: 0,
      failed: 0,
      logFailed: 0,
    });
  });
});
