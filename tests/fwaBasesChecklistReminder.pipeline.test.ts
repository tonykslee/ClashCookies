import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  trackedClan: { findMany: vi.fn() },
  currentWar: { findMany: vi.fn() },
  clanPointsSync: { findMany: vi.fn() },
  trackedMessage: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({ prisma: prismaMock }));

import { buildFwaMatchChecklistRenderStateForGuild } from "../src/services/FwaMatchChecklistStateService";
import {
  findPendingFwaBasesChecklistReminderCandidates,
} from "../src/services/fwa/basesChecklistReminderService";
import { FwaBasesChecklistReminderSchedulerService } from "../src/services/fwa/basesChecklistReminderSchedulerService";
import {
  TRACKED_MESSAGE_STATUS,
  trackedMessageService,
} from "../src/services/TrackedMessageService";

const guildId = "guild-1";
const clanTag = "#PYPY";
const syncMessageId = "sync-message-1";
const warStartTime = new Date("2026-05-26T18:00:00.000Z");
const opponentTag = "#OPP1";

function completionMetadata(input: {
  checked: boolean;
  actorUserId?: string | null;
  syncMessageId?: string | null;
  warId?: string | number | null;
  opponentTag?: string | null;
  warStartTime?: Date | null;
}) {
  return {
    kind: "bases_completion",
    createdByUserId: input.actorUserId ?? "system",
    createdAtIso: "2026-05-26T15:00:00.000Z",
    checkedByUserId: input.checked ? input.actorUserId ?? "system" : null,
    checkedAtIso: input.checked ? "2026-05-26T15:00:00.000Z" : null,
    syncMessageId: input.syncMessageId ?? null,
    syncReferenceId: null,
    clanTag,
    clanName: "Alpha",
    checked: input.checked,
    warId: input.warId ?? null,
    opponentTag: input.opponentTag ?? null,
    warStartTimeIso: input.warStartTime?.toISOString() ?? null,
  };
}

function completionRow(input: Parameters<typeof completionMetadata>[0] & {
  messageId: string;
  status?: string;
}) {
  return {
    id: input.messageId,
    guildId,
    channelId: "checklist-channel",
    messageId: input.messageId,
    featureType: "FWA_MATCH_CHECKLIST",
    status: input.status ?? TRACKED_MESSAGE_STATUS.ACTIVE,
    referenceId: input.syncMessageId ?? null,
    clanTag,
    createdAt: new Date("2026-05-26T15:00:00.000Z"),
    expiresAt: null,
    metadata: completionMetadata(input),
  };
}

function currentWarRow() {
  return {
    guildId,
    clanTag,
    warId: 1001,
    prepStartTime: new Date("2026-05-26T12:00:00.000Z"),
    startTime: warStartTime,
    endTime: new Date("2026-05-27T18:00:00.000Z"),
    opponentTag,
    opponentName: "Opponent",
    clanName: "Alpha",
    matchType: "FWA",
    inferredMatchType: false,
    outcome: null,
    fwaPoints: null,
    opponentFwaPoints: null,
    state: "preparation",
  };
}

function configurePrismaRows(rows: any[] = []) {
  const syncRoot = {
    id: "sync-root-1",
    guildId,
    channelId: "sync-channel",
    messageId: syncMessageId,
    referenceId: null,
    clanTag: null,
    featureType: "SYNC_TIME_POST",
    status: TRACKED_MESSAGE_STATUS.ACTIVE,
    createdAt: new Date("2026-05-26T12:00:00.000Z"),
    expiresAt: null,
    metadata: {},
  };
  prismaMock.trackedClan.findMany.mockResolvedValue([
    {
      tag: clanTag,
      name: "Alpha Clan",
      shortName: "Alpha",
      clanBadge: null,
      leaderChannelId: "leader-channel",
      notifyChannelId: null,
      logChannelId: null,
      clanRoleId: "role-1",
    },
  ]);
  prismaMock.currentWar.findMany.mockResolvedValue([currentWarRow()]);
  prismaMock.clanPointsSync.findMany.mockResolvedValue([]);
  prismaMock.trackedMessage.findFirst.mockResolvedValue(syncRoot);
  prismaMock.trackedMessage.findUnique.mockImplementation(async ({ where }: any) =>
    rows.find((row) => row.messageId === where?.messageId) ?? null,
  );
  prismaMock.trackedMessage.findMany.mockImplementation(async ({ where }: any) => {
    if (where?.featureType === "FWA_BASE_SWAP") return [];
    if (where?.featureType === "FWA_MATCH_CHECKLIST") {
      return rows.filter((row) => {
        if (row.featureType !== "FWA_MATCH_CHECKLIST") return false;
        if (where.status && row.status !== where.status) return false;
        if (where.messageId?.startsWith && !row.messageId.startsWith(where.messageId.startsWith)) {
          return false;
        }
        return true;
      });
    }
    return [];
  });
  prismaMock.trackedMessage.create.mockImplementation(async ({ data }: any) => {
    const row = {
      id: data.messageId,
      ...data,
      createdAt: new Date(data.metadata?.createdAtIso ?? "2026-05-26T15:00:00.000Z"),
      expiresAt: data.expiresAt ?? null,
    };
    rows.push(row);
    return row;
  });
  prismaMock.trackedMessage.updateMany.mockImplementation(async ({ where, data }: any) => {
    let count = 0;
    for (const row of rows) {
      const matchesId = where?.messageId ? row.messageId === where.messageId : true;
      const matchesRowId = where?.id ? row.id === where.id : true;
      const matchesStatus = where?.status ? row.status === where.status : true;
      if (matchesId && matchesRowId && matchesStatus) {
        Object.assign(row, data);
        count += 1;
      }
    }
    return { count };
  });
}

async function renderBasesState() {
  return buildFwaMatchChecklistRenderStateForGuild({
    cocService: {} as any,
    guildId,
    client: {} as any,
    viewType: "Bases",
    nowMs: new Date("2026-05-26T15:00:00.000Z").getTime(),
  });
}

async function setCompletion(input: {
  checked: boolean;
  actorUserId: string;
  syncMessageId?: string | null;
}) {
  return trackedMessageService.setFwaMatchChecklistBasesCompletion({
    guildId,
    channelId: "checklist-channel",
    createdByUserId: input.actorUserId,
    clanTag,
    clanName: "Alpha",
    warId: 1001,
    warStartTime,
    opponentTag,
    checked: input.checked,
    completionActorUserId: input.actorUserId,
    syncMessageId: input.syncMessageId ?? null,
  });
}

function makeClient(params: { onFetch?: () => Promise<void> | void } = {}) {
  const send = vi.fn().mockResolvedValue({ id: "reminder-message" });
  const channel = {
    isTextBased: () => true,
    send,
  };
  return {
    send,
    client: {
      channels: {
        fetch: vi.fn().mockImplementation(async () => {
          await params.onFetch?.();
          return channel;
        }),
      },
    } as any,
  };
}

describe("FWA Bases reminder persistence pipeline", () => {
  let rows: any[];
  let priorPollingEnv: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    rows = [];
    configurePrismaRows(rows);
    priorPollingEnv = process.env.POLLING_ENV;
    process.env.POLLING_ENV = "dev";
  });

  afterEach(() => {
    if (priorPollingEnv === undefined) delete process.env.POLLING_ENV;
    else process.env.POLLING_ENV = priorPollingEnv;
  });

  it("suppresses command and reaction-shaped acknowledgments through the real owner and lookup", async () => {
    const command = await setCompletion({
      checked: true,
      actorUserId: "command-actor",
      syncMessageId,
    });
    const reaction = await setCompletion({
      checked: true,
      actorUserId: "reaction-actor",
      syncMessageId: null,
    });

    expect(command.transition).toBe("COMMITTED");
    expect(reaction.transition).toBe("ALREADY_COMPLETED");
    expect(reaction.committedByUserId).toBe("command-actor");
    expect(rows.filter((row) => row.status === TRACKED_MESSAGE_STATUS.ACTIVE)).toHaveLength(1);

    const state = await renderBasesState();
    expect(state.rows[0]?.basesStatus).toBe("all_good");
    await expect(
      findPendingFwaBasesChecklistReminderCandidates({
        now: new Date("2026-05-26T15:00:00.000Z"),
      }),
    ).resolves.toEqual([]);
  });

  it("suppresses a legacy sync-only completion after war enrichment and ignores a contradictory row", async () => {
    const legacy = await trackedMessageService.setFwaMatchChecklistBasesCompletion({
      guildId,
      channelId: "checklist-channel",
      createdByUserId: "legacy-actor",
      clanTag,
      checked: true,
      completionActorUserId: "legacy-actor",
      syncReferenceId: syncMessageId,
    });
    expect(legacy.transition).toBe("COMMITTED");

    const state = await renderBasesState();
    expect(state.rows[0]?.basesStatus).toBe("all_good");
    await expect(
      findPendingFwaBasesChecklistReminderCandidates({
        now: new Date("2026-05-26T15:00:00.000Z"),
      }),
    ).resolves.toEqual([]);

    rows.splice(0, rows.length, completionRow({
      messageId: "contradictory-completion",
      checked: true,
      actorUserId: "stale-actor",
      syncMessageId,
      warId: 9999,
      opponentTag: "#OLD",
      warStartTime: new Date("2026-05-25T18:00:00.000Z"),
    }));
    const contradictoryState = await renderBasesState();
    expect(contradictoryState.rows[0]?.basesStatus).toBe("not_checked");
    await expect(
      findPendingFwaBasesChecklistReminderCandidates({
        now: new Date("2026-05-26T15:00:00.000Z"),
      }),
    ).resolves.toHaveLength(1);
  });

  it("restores eligibility on uncheck, suppresses after recheck, and dedupes repeated ticks", async () => {
    await setCompletion({ checked: true, actorUserId: "first-actor", syncMessageId });
    expect(
      await findPendingFwaBasesChecklistReminderCandidates({
        now: new Date("2026-05-26T15:00:00.000Z"),
      }),
    ).toEqual([]);

    expect((await setCompletion({ checked: false, actorUserId: "uncheck-actor" })).transition).toBe("CLEARED");
    expect(
      await findPendingFwaBasesChecklistReminderCandidates({
        now: new Date("2026-05-26T15:00:00.000Z"),
      }),
    ).toHaveLength(1);

    expect((await setCompletion({ checked: true, actorUserId: "recheck-actor" })).transition).toBe("COMMITTED");
    expect(
      await findPendingFwaBasesChecklistReminderCandidates({
        now: new Date("2026-05-26T15:00:00.000Z"),
      }),
    ).toEqual([]);

    await setCompletion({ checked: false, actorUserId: "second-uncheck" });
    const { client, send } = makeClient();
    const scheduler = new FwaBasesChecklistReminderSchedulerService(client);
    await expect(
      scheduler.runCycle(new Date("2026-05-26T15:00:00.000Z").getTime()),
    ).resolves.toMatchObject({ sent: 1 });
    await expect(
      scheduler.runCycle(new Date("2026-05-26T15:00:01.000Z").getTime()),
    ).resolves.toMatchObject({ sent: 0, deduped: 0 });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("rechecks completion after channel resolution and releases the claimed marker", async () => {
    const { client, send } = makeClient({
      onFetch: () => setCompletion({ checked: true, actorUserId: "late-actor" }),
    });
    const scheduler = new FwaBasesChecklistReminderSchedulerService(client);

    const counts = await scheduler.runCycle(new Date("2026-05-26T15:00:00.000Z").getTime());

    expect(counts).toMatchObject({ evaluated: 1, sent: 0, skipped: 1, failed: 0 });
    expect(send).not.toHaveBeenCalled();
    const marker = rows.find((row) => row.messageId.includes("bases_reminder"));
    expect(marker?.status).toBe(TRACKED_MESSAGE_STATUS.REPLACED);
    expect(rows.find((row) => row.messageId.includes("bases_completion"))?.status).toBe(
      TRACKED_MESSAGE_STATUS.ACTIVE,
    );
  });
});
