import { describe, expect, it, vi } from "vitest";
import { HomeAwaySyncAlertService } from "../src/services/HomeAwaySyncAlertService";

const HOUR = 60 * 60 * 1000;
const now = new Date("2026-08-22T12:00:00.000Z");

function matches(row: any, where: any): boolean {
  if (!where) return true;
  if (where.OR && !where.OR.some((part: any) => matches(row, part))) return false;
  for (const [key, condition] of Object.entries(where)) {
    if (key === "OR") continue;
    const value = row[key];
    if (condition && typeof condition === "object" && !(condition instanceof Date)) {
      if ("in" in condition && !(condition.in as any[]).includes(value)) return false;
      if ("notIn" in condition && (condition.notIn as any[]).includes(value)) return false;
      if ("not" in condition && value === condition.not) return false;
      if ("gt" in condition && !(value > condition.gt)) return false;
      if ("lte" in condition && !(value <= condition.lte)) return false;
    } else if (value !== condition) {
      return false;
    }
  }
  return true;
}

function buildHarness(input: {
  sources?: any[];
  homes?: any[];
  trackedClans?: any[];
  links?: any[];
  rosters?: Record<string, any>;
  users?: Record<string, any>;
  random?: () => number;
}) {
  const state = {
    sources: input.sources ?? [],
    schedules: [] as any[],
    deliveries: [] as any[],
  };
  let nextId = 1;
  const update = (row: any, data: any) => {
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === "object" && "increment" in value) {
        row[key] = Number(row[key] ?? 0) + Number((value as any).increment);
      } else {
        row[key] = value;
      }
    }
  };
  const db: any = {
    scheduledSyncPost: {
      findMany: vi.fn(async ({ where }: any = {}) => state.sources.filter((row) => matches(row, where))),
    },
    homeAwaySyncAlertSchedule: {
      findMany: vi.fn(async ({ where }: any = {}) => state.schedules.filter((row) => matches(row, where))),
      findUnique: vi.fn(async ({ where }: any) => state.schedules.find((row) => matches(row, where)) ?? null),
      create: vi.fn(async ({ data }: any) => {
        if (state.schedules.some((row) => row.scheduledSyncPostId === data.scheduledSyncPostId)) {
          throw Object.assign(new Error("duplicate"), { code: "P2002" });
        }
        const row = {
          id: `alert-${nextId++}`,
          ...data,
          claimToken: null,
          claimedAt: null,
          evaluatedAt: null,
          completedAt: null,
        };
        state.schedules.push(row);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const rows = state.schedules.filter((row) => matches(row, where));
        rows.forEach((row) => update(row, data));
        return { count: rows.length };
      }),
    },
    homeAwaySyncAlertDelivery: {
      findMany: vi.fn(async ({ where }: any = {}) => state.deliveries.filter((row) => matches(row, where))),
      createMany: vi.fn(async ({ data, skipDuplicates }: any) => {
        let count = 0;
        for (const item of data) {
          const duplicate = state.deliveries.some(
            (row) => row.alertScheduleId === item.alertScheduleId && row.discordUserId === item.discordUserId,
          );
          if (duplicate && skipDuplicates) continue;
          state.deliveries.push({
            id: `delivery-${nextId++}`,
            ...item,
            claimToken: null,
            claimedAt: null,
            attemptCount: 0,
            nextAttemptAt: null,
            sentAt: null,
          });
          count += 1;
        }
        return { count };
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const rows = state.deliveries.filter((row) => matches(row, where));
        rows.forEach((row) => update(row, data));
        return { count: rows.length };
      }),
    },
    clanHomeMembershipPeriod: {
      findMany: vi.fn(async () => input.homes ?? []),
    },
    trackedClan: {
      findMany: vi.fn(async () => input.trackedClans ?? []),
    },
    playerLink: {
      findMany: vi.fn(async () => input.links ?? []),
    },
  };
  db.$transaction = vi.fn(async (callback: (tx: any) => Promise<unknown>) => callback(db));
  const users = input.users ?? {};
  const client: any = {
    users: {
      fetch: vi.fn(async (id: string) => {
        const user = users[id];
        if (!user) throw new Error("user missing");
        return user;
      }),
    },
  };
  const rosterReader = {
    getClanHomeRoster: vi.fn(async ({ clanTag }: { clanTag: string }) => input.rosters?.[clanTag] ?? {
      clanTag,
      clanName: clanTag,
      unknownCount: 0,
      members: [],
    }),
  };
  const service = new HomeAwaySyncAlertService(client, {
    db,
    homeRosterService: rosterReader,
    random: input.random ?? (() => 0.5),
  });
  return { service, db, state, client, rosterReader };
}

function source(id = "post-1", status = "PENDING", syncHours = 8) {
  return {
    id,
    guildId: "guild-1",
    syncTime: new Date(now.getTime() + syncHours * HOUR),
    status,
    createdAt: now,
  };
}

function roster(clanTag: string, members: any[], unknownCount = 0) {
  return {
    clanTag,
    clanName: clanTag === "#HOME" ? "Rocky Road" : "RISING DAWN",
    unknownCount,
    members,
  };
}

function member(playerTag: string, playerName: string, presence: "PRESENT" | "AWAY" | "UNKNOWN") {
  return { playerTag, playerName, presence };
}

describe("HomeAwaySyncAlertService", () => {
  it("creates one persisted fire time in the five-to-seven-hour window and reuses it", async () => {
    const harness = buildHarness({ sources: [source()] });
    await harness.service.runCycle(now);
    const fireAt = harness.state.schedules[0].fireAt;
    const syncTime = source().syncTime;
    expect(fireAt.getTime()).toBeGreaterThanOrEqual(syncTime.getTime() - 7 * HOUR);
    expect(fireAt.getTime()).toBeLessThanOrEqual(syncTime.getTime() - 5 * HOUR);
    await harness.service.runCycle(now);
    expect(harness.state.schedules).toHaveLength(1);
    expect(harness.state.schedules[0].fireAt).toEqual(fireAt);
    expect(harness.db.homeAwaySyncAlertSchedule.create).toHaveBeenCalledTimes(1);
  });

  it("reuses the persisted fire time after service recreation", async () => {
    const harness = buildHarness({ sources: [source("post-restart")] });
    await harness.service.runCycle(now);
    const fireAt = harness.state.schedules[0].fireAt;
    const restarted = buildHarness({ sources: harness.state.sources });
    restarted.state.schedules.push(...harness.state.schedules);
    await restarted.service.runCycle(now);
    expect(restarted.state.schedules).toHaveLength(1);
    expect(restarted.state.schedules[0].fireAt).toEqual(fireAt);
    expect(restarted.db.homeAwaySyncAlertSchedule.create).not.toHaveBeenCalled();
  });

  it("keeps the ordinary empty cycle on persisted schedule reads only", async () => {
    const harness = buildHarness({});
    await harness.service.runCycle(now);
    expect(harness.rosterReader.getClanHomeRoster).not.toHaveBeenCalled();
    expect(harness.db.clanHomeMembershipPeriod.findMany).not.toHaveBeenCalled();
    expect(harness.db.trackedClan.findMany).not.toHaveBeenCalled();
    expect(harness.db.playerLink.findMany).not.toHaveBeenCalled();
  });

  it("evaluates a late-created alert immediately and does not send after sync time", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const harness = buildHarness({
      sources: [source("post-late", "PUBLISHED", 4)],
      homes: [{ clanTag: "#HOME" }],
      trackedClans: [{ tag: "#HOME" }],
      links: [{ playerTag: "#AWAY1", discordUserId: "user-1" }],
      rosters: { "#HOME": roster("#HOME", [member("#AWAY1", "Away One", "AWAY")]) },
      users: { "user-1": { send } },
    });

    await harness.service.runCycle(now);
    expect(send).toHaveBeenCalledTimes(1);

    const afterSync = new Date(source("post-late", "PUBLISHED", 4).syncTime.getTime() + 1);
    await harness.service.runCycle(afterSync);
    expect(send).toHaveBeenCalledTimes(1);
    expect(harness.state.schedules[0].status).toBe("COMPLETED");
  });

  it("evaluates HomeRoster Away state once, ignores Present and Unknown, and aggregates one DM per user", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const harness = buildHarness({
      sources: [source("post-1", "PENDING", 4)],
      homes: [{ clanTag: "#HOME" }],
      trackedClans: [{ tag: "#HOME", name: "Rocky Road" }],
      links: [
        { playerTag: "#AWAY1", discordUserId: "user-1" },
        { playerTag: "#AWAY2", discordUserId: "user-1" },
      ],
      rosters: {
        "#HOME": roster("#HOME", [
          member("#AWAY1", "Away One", "AWAY"),
          member("#AWAY2", "Away Two", "AWAY"),
          member("#PRESENT", "Present", "PRESENT"),
          member("#UNKNOWN", "Unknown", "UNKNOWN"),
        ], 1),
      },
      users: { "user-1": { send } },
    });
    await harness.service.runCycle(now);
    expect(harness.rosterReader.getClanHomeRoster).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    const content = send.mock.calls[0][0].content as string;
    expect(content).toContain("Away One");
    expect(content).toContain("Away Two");
    expect(content).toContain("Rocky Road");
    expect(content).not.toContain("2026");
    expect(content).not.toMatch(/\b[567] hours?\b/i);
    expect(content).not.toContain("fire");
    expect(harness.state.deliveries).toHaveLength(1);
    expect(harness.state.schedules[0].status).toBe("COMPLETED");
  });

  it("does not deliver unlinked Away accounts and completes zero-recipient alerts", async () => {
    const harness = buildHarness({
      sources: [source("post-1", "PENDING", 4)],
      homes: [{ clanTag: "#HOME" }],
      trackedClans: [{ tag: "#HOME" }],
      rosters: { "#HOME": roster("#HOME", [member("#AWAY1", "Away One", "AWAY")]) },
    });
    const result = await harness.service.runCycle(now);
    expect(result.unlinked).toBe(1);
    expect(harness.state.deliveries).toHaveLength(0);
    expect(harness.state.schedules[0].status).toBe("COMPLETED");
  });

  it("replay after SENT does not reevaluate HomeRoster or resend", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const harness = buildHarness({
      sources: [source("post-1", "PENDING", 4)],
      homes: [{ clanTag: "#HOME" }],
      trackedClans: [{ tag: "#HOME" }],
      links: [{ playerTag: "#AWAY1", discordUserId: "user-1" }],
      rosters: { "#HOME": roster("#HOME", [member("#AWAY1", "Away One", "AWAY")]) },
      users: { "user-1": { send } },
    });
    await harness.service.runCycle(now);
    await harness.service.runCycle(now);
    expect(send).toHaveBeenCalledTimes(1);
    expect(harness.rosterReader.getClanHomeRoster).toHaveBeenCalledTimes(1);
  });

  it("retries transient delivery failures before the sync and terminalizes permanent failures", async () => {
    const transientSend = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("temporarily unavailable"), { status: 500 }))
      .mockResolvedValueOnce(undefined);
    const transient = buildHarness({
      sources: [source("post-retry", "FAILED", 4)],
      homes: [{ clanTag: "#HOME" }],
      trackedClans: [{ tag: "#HOME" }],
      links: [{ playerTag: "#AWAY1", discordUserId: "user-1" }],
      rosters: { "#HOME": roster("#HOME", [member("#AWAY1", "Away One", "AWAY")]) },
      users: { "user-1": { send: transientSend } },
    });
    await transient.service.runCycle(now);
    expect(transient.state.deliveries[0].status).toBe("PENDING");
    await transient.service.runCycle(new Date(now.getTime() + 2 * HOUR));
    expect(transientSend).toHaveBeenCalledTimes(2);
    expect(transient.state.deliveries[0].status).toBe("SENT");

    const terminalSend = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("cannot message"), { code: 50007 }));
    const terminal = buildHarness({
      sources: [source("post-terminal", "PENDING", 4)],
      homes: [{ clanTag: "#HOME" }],
      trackedClans: [{ tag: "#HOME" }],
      links: [{ playerTag: "#AWAY1", discordUserId: "user-1" }],
      rosters: { "#HOME": roster("#HOME", [member("#AWAY1", "Away One", "AWAY")]) },
      users: { "user-1": { send: terminalSend } },
    });
    await terminal.service.runCycle(now);
    expect(terminal.state.deliveries[0].status).toBe("FAILED");
    expect(terminal.state.schedules[0].status).toBe("COMPLETED");
  });

  it("skips cancelled sources without reading HomeRoster", async () => {
    const harness = buildHarness({ sources: [source("post-cancelled", "CANCELLED", 4)] });
    await harness.service.runCycle(now);
    expect(harness.state.schedules).toHaveLength(0);
    expect(harness.rosterReader.getClanHomeRoster).not.toHaveBeenCalled();
  });

  it("cancels a superseded source and creates an independent alert for its replacement", async () => {
    let randomIndex = 0;
    const harness = buildHarness({
      sources: [source("post-old")],
      random: () => [0.25, 0.75][randomIndex++] ?? 0.75,
    });
    await harness.service.runCycle(now);
    const oldFireAt = harness.state.schedules[0].fireAt;
    harness.state.sources[0].status = "REPLACED";
    harness.state.sources.push(source("post-new"));
    await harness.service.runCycle(now);
    expect(harness.state.schedules.find((row) => row.scheduledSyncPostId === "post-old")?.status).toBe("CANCELLED");
    expect(harness.state.schedules.find((row) => row.scheduledSyncPostId === "post-new")?.fireAt).not.toEqual(oldFireAt);
  });

  it("does not write or evaluate in mirror mode", async () => {
    const previous = process.env.POLLING_MODE;
    process.env.POLLING_MODE = "mirror";
    try {
      const harness = buildHarness({ sources: [source()] });
      await harness.service.runCycle(now);
      expect(harness.state.schedules).toHaveLength(0);
      expect(harness.db.scheduledSyncPost.findMany).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.POLLING_MODE;
      else process.env.POLLING_MODE = previous;
    }
  });
});
