import { describe, expect, it, vi } from "vitest";
import {
  buildHomeAwaySyncAlertMessage,
  HomeAwaySyncAlertService,
} from "../src/services/HomeAwaySyncAlertService";
import { dozzleLog } from "../src/helper/dozzleLogger";

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
  clock?: () => Date;
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
      findUnique: vi.fn(async ({ where }: any) => state.sources.find((row) => matches(row, where)) ?? null),
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
    clock: input.clock ?? (() => now),
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
    const infoSpy = vi.spyOn(dozzleLog, "info").mockImplementation(() => undefined);
    const debugSpy = vi.spyOn(dozzleLog, "debug").mockImplementation(() => undefined);
    await harness.service.runCycle(now);
    expect(harness.rosterReader.getClanHomeRoster).not.toHaveBeenCalled();
    expect(harness.db.clanHomeMembershipPeriod.findMany).not.toHaveBeenCalled();
    expect(harness.db.trackedClan.findMany).not.toHaveBeenCalled();
    expect(harness.db.playerLink.findMany).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalledWith(expect.stringContaining("[home-away-sync-alert] cycle_complete"));
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining("[home-away-sync-alert] cycle_complete"));
    infoSpy.mockRestore();
    debugSpy.mockRestore();
  });

  it.each(["REPLACED", "CANCELLED"] as const)(
    "cancels without materializing when the source changes to %s during evaluation",
    async (status) => {
      const send = vi.fn().mockResolvedValue(undefined);
      const harness = buildHarness({
        sources: [source("post-race", "PENDING", 4)],
        homes: [{ clanTag: "#HOME" }],
        trackedClans: [{ tag: "#HOME" }],
        links: [{ playerTag: "#AWAY1", discordUserId: "user-1" }],
        rosters: { "#HOME": roster("#HOME", [member("#AWAY1", "Away One", "AWAY")]) },
        users: { "user-1": { send } },
      });
      harness.db.playerLink.findMany.mockImplementationOnce(async () => {
        harness.state.sources[0].status = status;
        return [{ playerTag: "#AWAY1", discordUserId: "user-1" }];
      });

      await harness.service.runCycle(now);
      expect(harness.state.deliveries).toHaveLength(0);
      expect(harness.state.schedules[0].status).toBe("CANCELLED");
      expect(send).not.toHaveBeenCalled();
    },
  );

  it("revalidates the source after materialization and before sending", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const harness = buildHarness({
      sources: [source("post-send-race", "PENDING", 4)],
      homes: [{ clanTag: "#HOME" }],
      trackedClans: [{ tag: "#HOME" }],
      links: [{ playerTag: "#AWAY1", discordUserId: "user-1" }],
      rosters: { "#HOME": roster("#HOME", [member("#AWAY1", "Away One", "AWAY")]) },
      users: { "user-1": { send } },
    });
    harness.client.users.fetch.mockImplementationOnce(async () => {
      harness.state.sources[0].status = "REPLACED";
      return { send };
    });

    await harness.service.runCycle(now);
    expect(send).not.toHaveBeenCalled();
    expect(harness.state.deliveries[0].status).toBe("EXPIRED");
    expect(harness.state.deliveries[0].failureCode).toBe("source_cancelled");
    expect(harness.state.schedules[0].status).toBe("CANCELLED");
  });

  it("cancels remaining alert work when the source disappears before send", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const harness = buildHarness({
      sources: [source("post-missing", "PENDING", 4)],
      homes: [{ clanTag: "#HOME" }],
      trackedClans: [{ tag: "#HOME" }],
      links: [{ playerTag: "#AWAY1", discordUserId: "user-1" }],
      rosters: { "#HOME": roster("#HOME", [member("#AWAY1", "Away One", "AWAY")]) },
      users: { "user-1": { send } },
    });
    harness.client.users.fetch.mockImplementationOnce(async () => {
      harness.state.sources.splice(0, 1);
      return { send };
    });

    await harness.service.runCycle(now);
    expect(send).not.toHaveBeenCalled();
    expect(harness.state.schedules[0].status).toBe("CANCELLED");
    expect(harness.state.deliveries[0].status).toBe("EXPIRED");
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

    harness.state.sources[0].status = "CANCELLED";
    await harness.service.runCycle(now);
    harness.state.sources[0].status = "PENDING";
    await harness.service.runCycle(now);
    expect(send).toHaveBeenCalledTimes(1);
    expect(harness.state.schedules[0].status).toBe("COMPLETED");
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

  it("treats one future FAILED source as the sole valid source and can alert", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const harness = buildHarness({
      sources: [source("post-failed-alone", "FAILED", 4)],
      homes: [{ clanTag: "#HOME" }],
      trackedClans: [{ tag: "#HOME" }],
      links: [{ playerTag: "#AWAY1", discordUserId: "user-1" }],
      rosters: { "#HOME": roster("#HOME", [member("#AWAY1", "Away One", "AWAY")]) },
      users: { "user-1": { send } },
    });

    await harness.service.runCycle(now);

    expect(send).toHaveBeenCalledTimes(1);
    expect(harness.state.schedules[0].status).toBe("COMPLETED");
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

  it("fails closed without creating alerts when a guild has multiple eligible future sources", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const harness = buildHarness({
      sources: [source("post-ambiguous-old", "FAILED", 8), source("post-ambiguous-new", "PENDING", 10)],
      homes: [{ clanTag: "#HOME" }],
      trackedClans: [{ tag: "#HOME" }],
      links: [{ playerTag: "#AWAY1", discordUserId: "user-1" }],
      rosters: { "#HOME": roster("#HOME", [member("#AWAY1", "Away One", "AWAY")]) },
      users: { "user-1": { send } },
    });

    await harness.service.runCycle(now);

    expect(harness.state.schedules).toHaveLength(0);
    expect(harness.rosterReader.getClanHomeRoster).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("cancels preexisting ambiguous alert work and never sends two DMs", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const older = source("post-legacy-old", "FAILED", 8);
    const newer = source("post-legacy-new", "PENDING", 10);
    const harness = buildHarness({
      sources: [older],
      users: { "user-1": { send } },
    });
    await harness.service.runCycle(now);
    const oldSchedule = harness.state.schedules[0];
    const oldFireAt = oldSchedule.fireAt;
    oldSchedule.status = "EVALUATED";
    harness.state.deliveries.push({
      id: "delivery-old",
      alertScheduleId: oldSchedule.id,
      guildId: "guild-1",
      discordUserId: "user-1",
      messageContent: "old",
      status: "PENDING",
      claimToken: null,
      claimedAt: null,
      attemptCount: 0,
      nextAttemptAt: null,
      sentAt: null,
      failureCode: null,
      failureReason: null,
    });
    const newSchedule = {
      ...oldSchedule,
      id: "alert-new",
      scheduledSyncPostId: newer.id,
      syncTime: newer.syncTime,
      fireAt: new Date(now.getTime() - 1),
      status: "EVALUATED",
    };
    harness.state.schedules.push(newSchedule);
    harness.state.deliveries.push({
      id: "delivery-new",
      alertScheduleId: newSchedule.id,
      guildId: "guild-1",
      discordUserId: "user-1",
      messageContent: "new",
      status: "PENDING",
      claimToken: null,
      claimedAt: null,
      attemptCount: 0,
      nextAttemptAt: null,
      sentAt: null,
      failureCode: null,
      failureReason: null,
    });
    harness.state.sources.push(newer);

    await harness.service.runCycle(now);

    expect(send).not.toHaveBeenCalled();
    expect(harness.state.schedules.map((row) => row.status)).toEqual(["CANCELLED", "CANCELLED"]);
    expect(harness.state.deliveries.map((row) => row.failureCode)).toEqual(["source_cancelled", "source_cancelled"]);
    expect(oldSchedule.fireAt).toEqual(oldFireAt);
  });

  it("reactivates the sole source after ambiguity resolves without rerandomizing fireAt", async () => {
    const random = vi.fn(() => 0.25);
    const older = source("post-resolve-old", "FAILED", 8);
    const newer = source("post-resolve-new", "PENDING", 10);
    const harness = buildHarness({ sources: [older], random });
    await harness.service.runCycle(now);
    const original = { ...harness.state.schedules[0] };
    harness.state.sources.push(newer);
    await harness.service.runCycle(now);
    expect(harness.state.schedules[0].status).toBe("CANCELLED");

    harness.state.sources = harness.state.sources.filter((row) => row.id !== newer.id);
    await harness.service.runCycle(now);

    expect(harness.state.schedules[0].status).toBe("PENDING");
    expect(harness.state.schedules[0].id).toBe(original.id);
    expect(harness.state.schedules[0].fireAt).toEqual(original.fireAt);
    expect(random).toHaveBeenCalledTimes(1);
  });

  it("uses effective current time at the final send boundary and schedules no retry after sync", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    let effectiveNow = now;
    const scheduleSource = source("post-clock-deadline", "PENDING", 4);
    const harness = buildHarness({
      sources: [scheduleSource],
      homes: [{ clanTag: "#HOME" }],
      trackedClans: [{ tag: "#HOME" }],
      links: [{ playerTag: "#AWAY1", discordUserId: "user-1" }],
      rosters: { "#HOME": roster("#HOME", [member("#AWAY1", "Away One", "AWAY")]) },
      users: { "user-1": { send } },
      clock: () => effectiveNow,
    });
    harness.client.users.fetch.mockImplementationOnce(async () => {
      effectiveNow = new Date(scheduleSource.syncTime.getTime() + 1);
      return { send };
    });

    await harness.service.runCycle(now);

    expect(send).not.toHaveBeenCalled();
    expect(harness.state.deliveries[0].status).toBe("EXPIRED");
    expect(harness.state.deliveries[0].nextAttemptAt).toBeNull();
    expect(harness.state.schedules[0].status).toBe("EXPIRED");
  });

  it("expires the whole alert before user fetch when effective time reaches sync", async () => {
    let clockCalls = 0;
    const afterSync = new Date(source("post-before-fetch", "PENDING", 4).syncTime.getTime() + 1);
    const fetch = vi.fn();
    const harness = buildHarness({
      sources: [source("post-before-fetch", "PENDING", 4)],
      homes: [{ clanTag: "#HOME" }],
      trackedClans: [{ tag: "#HOME" }],
      links: [{ playerTag: "#AWAY1", discordUserId: "user-1" }],
      rosters: { "#HOME": roster("#HOME", [member("#AWAY1", "Away One", "AWAY")]) },
      users: { "user-1": { send: vi.fn() } },
      clock: () => (clockCalls++ === 0 ? now : afterSync),
    });
    harness.client.users.fetch.mockImplementation(fetch);

    await harness.service.runCycle(now);

    expect(fetch).not.toHaveBeenCalled();
    expect(harness.state.schedules[0].status).toBe("EXPIRED");
    expect(harness.state.deliveries[0].status).toBe("EXPIRED");
    expect(harness.state.deliveries[0].nextAttemptAt).toBeNull();
  });

  it("expires every remaining recipient when the first delivery crosses the deadline", async () => {
    let clockCalls = 0;
    const scheduleSource = source("post-multi-deadline", "PENDING", 4);
    const afterSync = new Date(scheduleSource.syncTime.getTime() + 1);
    const firstFetch = vi.fn();
    const secondFetch = vi.fn();
    const harness = buildHarness({
      sources: [scheduleSource],
      homes: [{ clanTag: "#HOME" }],
      trackedClans: [{ tag: "#HOME" }],
      links: [
        { playerTag: "#AWAY1", discordUserId: "user-1" },
        { playerTag: "#AWAY2", discordUserId: "user-2" },
      ],
      rosters: {
        "#HOME": roster("#HOME", [
          member("#AWAY1", "Away One", "AWAY"),
          member("#AWAY2", "Away Two", "AWAY"),
        ]),
      },
      users: { "user-1": { send: firstFetch }, "user-2": { send: secondFetch } },
      clock: () => (clockCalls++ === 0 ? now : afterSync),
    });

    await harness.service.runCycle(now);

    expect(harness.client.users.fetch).not.toHaveBeenCalled();
    expect(firstFetch).not.toHaveBeenCalled();
    expect(secondFetch).not.toHaveBeenCalled();
    expect(harness.state.deliveries).toHaveLength(2);
    expect(harness.state.deliveries.every((delivery) => delivery.status === "EXPIRED")).toBe(true);
    expect(harness.state.schedules[0].status).toBe("EXPIRED");
  });

  it("sends normally when effective current time remains before sync", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const harness = buildHarness({
      sources: [source("post-clock-before-sync", "PENDING", 4)],
      homes: [{ clanTag: "#HOME" }],
      trackedClans: [{ tag: "#HOME" }],
      links: [{ playerTag: "#AWAY1", discordUserId: "user-1" }],
      rosters: { "#HOME": roster("#HOME", [member("#AWAY1", "Away One", "AWAY")]) },
      users: { "user-1": { send } },
      clock: () => now,
    });

    await harness.service.runCycle(now);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("uses effective current time in source validation before sending", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const effectiveNow = new Date(now.getTime() + HOUR);
    const harness = buildHarness({
      sources: [source("post-clock-validation", "PENDING", 4)],
      homes: [{ clanTag: "#HOME" }],
      trackedClans: [{ tag: "#HOME" }],
      links: [{ playerTag: "#AWAY1", discordUserId: "user-1" }],
      rosters: { "#HOME": roster("#HOME", [member("#AWAY1", "Away One", "AWAY")]) },
      users: { "user-1": { send } },
      clock: () => effectiveNow,
    });

    await harness.service.runCycle(now);

    expect(send).toHaveBeenCalledTimes(1);
    expect(
      harness.db.scheduledSyncPost.findMany.mock.calls.some(
        ([args]: any[]) => args?.where?.syncTime?.gt?.getTime?.() === effectiveNow.getTime(),
      ),
    ).toBe(true);
  });

  it("reactivates a pre-fire cancellation with the same alert ID and fireAt", async () => {
    const random = vi.fn(() => 0.25);
    const harness = buildHarness({ sources: [source("post-reactivate")], random });
    await harness.service.runCycle(now);
    const original = { ...harness.state.schedules[0] };
    harness.state.sources[0].status = "CANCELLED";
    await harness.service.runCycle(now);
    harness.state.sources[0].status = "PENDING";
    await harness.service.runCycle(now);
    expect(harness.state.schedules[0].id).toBe(original.id);
    expect(harness.state.schedules[0].fireAt).toEqual(original.fireAt);
    expect(harness.state.schedules[0].status).toBe("PENDING");
    expect(random).toHaveBeenCalledTimes(1);
  });

  it("reactivates after the original fireAt and evaluates immediately", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const harness = buildHarness({
      sources: [source("post-reactivate-due", "PENDING", 8)],
      homes: [{ clanTag: "#HOME" }],
      trackedClans: [{ tag: "#HOME" }],
      links: [{ playerTag: "#AWAY1", discordUserId: "user-1" }],
      rosters: { "#HOME": roster("#HOME", [member("#AWAY1", "Away One", "AWAY")]) },
      users: { "user-1": { send } },
    });
    const beforeFire = new Date(now.getTime() - 3 * HOUR);
    await harness.service.runCycle(beforeFire);
    const original = { ...harness.state.schedules[0] };
    harness.state.sources[0].status = "REPLACED";
    await harness.service.runCycle(now);
    harness.state.sources[0].status = "PUBLISHED";
    await harness.service.runCycle(new Date(now.getTime() + 3 * HOUR));
    expect(harness.state.schedules[0].id).toBe(original.id);
    expect(harness.state.schedules[0].fireAt).toEqual(original.fireAt);
    expect(send).toHaveBeenCalledTimes(1);
    expect(harness.state.schedules[0].status).toBe("COMPLETED");
  });

  it("reactivates evaluated cancellation from the immutable recipient snapshot", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("temporary"), { status: 500 }))
      .mockResolvedValueOnce(undefined);
    const harness = buildHarness({
      sources: [source("post-reactivate-evaluated", "PENDING", 4)],
      homes: [{ clanTag: "#HOME" }],
      trackedClans: [{ tag: "#HOME" }],
      links: [{ playerTag: "#AWAY1", discordUserId: "user-1" }],
      rosters: { "#HOME": roster("#HOME", [member("#AWAY1", "Away One", "AWAY")]) },
      users: { "user-1": { send } },
    });
    await harness.service.runCycle(now);
    const originalMessage = harness.state.deliveries[0].messageContent;
    expect(harness.state.schedules[0].status).toBe("EVALUATED");
    harness.state.sources[0].status = "CANCELLED";
    await harness.service.runCycle(now);
    expect(harness.state.deliveries[0].status).toBe("EXPIRED");
    expect(harness.state.deliveries[0].failureCode).toBe("source_cancelled");
    harness.state.sources[0].status = "PENDING";
    await harness.service.runCycle(now);
    expect(harness.rosterReader.getClanHomeRoster).toHaveBeenCalledTimes(1);
    expect(harness.state.deliveries[0].messageContent).toBe(originalMessage);
    expect(send).toHaveBeenCalledTimes(2);
    expect(harness.state.deliveries[0].status).toBe("SENT");
    expect(harness.state.schedules[0].status).toBe("COMPLETED");
  });

  it("does not resend SENT recipients when an evaluated alert is reactivated", async () => {
    const firstSend = vi.fn().mockResolvedValue(undefined);
    const secondSend = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("temporary"), { status: 500 }))
      .mockResolvedValueOnce(undefined);
    const harness = buildHarness({
      sources: [source("post-reactivate-partial", "PENDING", 4)],
      homes: [{ clanTag: "#HOME" }],
      trackedClans: [{ tag: "#HOME" }],
      links: [
        { playerTag: "#AWAY1", discordUserId: "user-1" },
        { playerTag: "#AWAY2", discordUserId: "user-2" },
      ],
      rosters: {
        "#HOME": roster("#HOME", [
          member("#AWAY1", "Away One", "AWAY"),
          member("#AWAY2", "Away Two", "AWAY"),
        ]),
      },
      users: { "user-1": { send: firstSend }, "user-2": { send: secondSend } },
    });
    await harness.service.runCycle(now);
    expect(firstSend).toHaveBeenCalledTimes(1);
    expect(secondSend).toHaveBeenCalledTimes(1);
    harness.state.sources[0].status = "CANCELLED";
    await harness.service.runCycle(now);
    harness.state.sources[0].status = "PENDING";
    await harness.service.runCycle(now);
    expect(firstSend).toHaveBeenCalledTimes(1);
    expect(secondSend).toHaveBeenCalledTimes(2);
    expect(harness.state.deliveries.filter((row) => row.status === "SENT")).toHaveLength(2);
  });

  it("keeps a completed alert terminal when its source is reactivated", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const harness = buildHarness({
      sources: [source("post-completed", "PENDING", 4)],
      homes: [{ clanTag: "#HOME" }],
      trackedClans: [{ tag: "#HOME" }],
      links: [{ playerTag: "#AWAY1", discordUserId: "user-1" }],
      rosters: { "#HOME": roster("#HOME", [member("#AWAY1", "Away One", "AWAY")]) },
      users: { "user-1": { send } },
    });
    await harness.service.runCycle(now);
    harness.state.sources[0].status = "CANCELLED";
    await harness.service.runCycle(now);
    harness.state.sources[0].status = "PENDING";
    await harness.service.runCycle(now);
    expect(harness.state.schedules[0].status).toBe("COMPLETED");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("bounds pathological message content and reports omitted accounts deterministically", () => {
    const accounts = Array.from({ length: 20 }, (_, index) => ({
      playerName: `${String(index).padStart(2, "0")}-${"Name".repeat(200)}`,
      playerTag: `#${"TAG".repeat(200)}`,
      homeClanName: `Clan-${"Home".repeat(200)}`,
      homeClanTag: `#${"CLAN".repeat(200)}`,
    }));
    const message = buildHomeAwaySyncAlertMessage(accounts);
    expect(message.length).toBeLessThanOrEqual(2_000);
    expect(message).toContain("…and 19 more away Home Clan accounts.");
    expect(message).not.toMatch(/2026|\b[567] hours?\b|fireAt/i);
    expect(message).toBe(buildHomeAwaySyncAlertMessage([...accounts].reverse()));
  });

  it("preserves ordinary single and multi-account message text", () => {
    const one = {
      playerName: "Away One",
      playerTag: "#AWAY1",
      homeClanName: "Rocky Road",
      homeClanTag: "#HOME",
    };
    expect(buildHomeAwaySyncAlertMessage([one])).toBe(
      "⚠️ Please return **Away One** to **Rocky Road** before the upcoming FWA sync.\n\nThis account is currently away from its Home Clan.",
    );
    expect(buildHomeAwaySyncAlertMessage([one, { ...one, playerName: "Away Two", playerTag: "#AWAY2" }])).toBe(
      "⚠️ Please return your away Home Clan accounts before the upcoming FWA sync.\n\n• Away One (`#AWAY1`) → **Rocky Road**\n• Away Two (`#AWAY2`) → **Rocky Road**",
    );
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
