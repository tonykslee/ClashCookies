import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AllianceClanMembershipIntervalService,
  type AllianceClanMembershipReconcileInput,
} from "../src/services/AllianceClanMembershipIntervalService";
import { observeCwlOnlyClanRosters } from "../src/services/AllianceClanMembershipObservationService";

type Row = {
  id: string;
  guildId: string;
  playerTag: string;
  clanTag: string;
  firstObservedAt: Date;
  lastObservedAt: Date;
  endedAt: Date | null;
  endReason: "TRANSFERRED" | "DEPARTED" | "TRACKING_STOPPED" | null;
};

function makeDb(initialRows: Row[] = []) {
  const rows = [...initialRows];
  let nextId = rows.length + 1;
  const matches = (row: Row, where: Record<string, any>): boolean =>
    Object.entries(where).every(([key, value]) => {
      if (value && typeof value === "object" && "in" in value) {
        return value.in.includes((row as any)[key]);
      }
      const actual = (row as any)[key];
      if (actual instanceof Date && value instanceof Date) return actual.getTime() === value.getTime();
      return actual === value;
    });
  const model = {
    findMany: vi.fn(async (args: any = {}) => {
      const where = args.where ?? {};
      return rows.filter((row) => matches(row, where)).map((row) => ({ ...row }));
    }),
    findFirst: vi.fn(async (args: any = {}) => {
      const where = args.where ?? {};
      const row = rows.find((candidate) => matches(candidate, where));
      return row ? { ...row } : null;
    }),
    create: vi.fn(async ({ data }: any) => {
      const row: Row = {
        id: `interval-${nextId++}`,
        ...data,
      };
      rows.push(row);
      return { ...row };
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const row = rows.find((candidate) => candidate.id === where.id);
      if (!row) throw new Error("missing row");
      Object.assign(row, data);
      return { ...row };
    }),
  };
  const db = {
    allianceClanMembershipInterval: model,
    $transaction: vi.fn(async (callback: any) => {
      const snapshot = rows.map((row) => ({ ...row }));
      try {
        return await callback(db);
      } catch (error) {
        rows.splice(0, rows.length, ...snapshot);
        throw error;
      }
    }),
  };
  return { db, rows, model };
}

const at = (value: string) => new Date(value);
const roster = (clanTag: string, ...playerTags: string[]) => ({ clanTag, playerTags });

function input(overrides: Partial<AllianceClanMembershipReconcileInput> = {}) {
  return {
    guildId: "guild-1",
    observedAt: at("2026-08-14T12:00:00.000Z"),
    monitoredClanTags: ["#QGRJ2222", "#QGRJ8888"],
    successfullyObservedClanRosters: [roster("#QGRJ2222", "#PYLQ2222")],
    ...overrides,
  } satisfies AllianceClanMembershipReconcileInput;
}

describe("AllianceClanMembershipIntervalService", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("opens an interval on first positive observation", async () => {
    const { db, rows } = makeDb();
    const result = await new AllianceClanMembershipIntervalService(db as any).reconcileCycle(input());

    expect(result.opened).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      guildId: "guild-1",
      playerTag: "#PYLQ2222",
      clanTag: "#QGRJ2222",
      endedAt: null,
      endReason: null,
    });
  });

  it("refreshes one interval without creating another", async () => {
    const { db, rows } = makeDb();
    const service = new AllianceClanMembershipIntervalService(db as any);
    await service.reconcileCycle(input());
    const result = await service.reconcileCycle(
      input({ observedAt: at("2026-08-14T12:30:00.000Z") }),
    );

    expect(result.refreshed).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].lastObservedAt).toEqual(at("2026-08-14T12:30:00.000Z"));
  });

  it("closes A and opens B atomically on transfer", async () => {
    const { db, rows } = makeDb();
    const service = new AllianceClanMembershipIntervalService(db as any);
    await service.reconcileCycle(input());
    const result = await service.reconcileCycle(
      input({
        observedAt: at("2026-08-14T12:30:00.000Z"),
        successfullyObservedClanRosters: [roster("#QGRJ8888", "#PYLQ2222")],
      }),
    );

    expect(result.transferred).toBe(1);
    expect(rows.filter((row) => !row.endedAt)).toHaveLength(1);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ clanTag: "#QGRJ2222", endReason: "TRANSFERRED" }),
        expect.objectContaining({ clanTag: "#QGRJ8888", endedAt: null }),
      ]),
    );
  });

  it("closes a missing player as DEPARTED after a successful clan observation", async () => {
    const { db, rows } = makeDb();
    const service = new AllianceClanMembershipIntervalService(db as any);
    await service.reconcileCycle(input());
    const result = await service.reconcileCycle(
      input({
        observedAt: at("2026-08-14T12:30:00.000Z"),
        successfullyObservedClanRosters: [roster("#QGRJ2222")],
      }),
    );

    expect(result.departed).toBe(1);
    expect(rows[0]).toMatchObject({ endReason: "DEPARTED", endedAt: at("2026-08-14T12:30:00.000Z") });
  });

  it("does not close an interval when its clan failed observation", async () => {
    const { db, rows } = makeDb();
    const service = new AllianceClanMembershipIntervalService(db as any);
    await service.reconcileCycle(input());
    await service.reconcileCycle(
      input({
        observedAt: at("2026-08-14T12:30:00.000Z"),
        successfullyObservedClanRosters: [roster("#QGRJ8888", "#PYLQ8888")],
      }),
    );

    expect(rows.find((row) => row.playerTag === "#PYLQ2222")).toMatchObject({
      endedAt: null,
      clanTag: "#QGRJ2222",
    });
  });

  it("closes an interval as TRACKING_STOPPED when its clan is removed", async () => {
    const { db, rows } = makeDb();
    const service = new AllianceClanMembershipIntervalService(db as any);
    await service.reconcileCycle(input());
    const result = await service.reconcileCycle(
      input({ monitoredClanTags: ["#QGRJ8888"], successfullyObservedClanRosters: [] }),
    );

    expect(result.trackingStopped).toBe(1);
    expect(rows[0].endReason).toBe("TRACKING_STOPPED");
  });

  it("does not create churn for ambiguous multi-clan observations", async () => {
    const { db, rows } = makeDb();
    const service = new AllianceClanMembershipIntervalService(db as any);
    const result = await service.reconcileCycle(
      input({
        successfullyObservedClanRosters: [
          roster("#QGRJ2222", "#PYLQ2222"),
          roster("#QGRJ8888", "#PYLQ2222"),
        ],
      }),
    );

    expect(result.ambiguous).toBe(1);
    expect(result.opened).toBe(0);
    expect(rows).toHaveLength(0);
  });

  it("is idempotent when the same facts are reprocessed", async () => {
    const { db, rows } = makeDb();
    const service = new AllianceClanMembershipIntervalService(db as any);
    await service.reconcileCycle(input());
    await service.reconcileCycle(input());

    expect(rows).toHaveLength(1);
    expect(rows.filter((row) => !row.endedAt)).toHaveLength(1);
  });

  it("does not touch intervals belonging to another guild", async () => {
    const otherGuild = {
      id: "other",
      guildId: "guild-2",
      playerTag: "#PYLQ2222",
      clanTag: "#QGRJ2222",
      firstObservedAt: at("2026-08-14T11:00:00.000Z"),
      lastObservedAt: at("2026-08-14T11:00:00.000Z"),
      endedAt: null,
      endReason: null,
    } as Row;
    const { db, rows } = makeDb([otherGuild]);
    await new AllianceClanMembershipIntervalService(db as any).reconcileCycle(input({
      successfullyObservedClanRosters: [],
    }));

    expect(rows).toContainEqual(otherGuild);
  });

  it("isolates a persistence failure and reports it without partial success", async () => {
    const { db, rows, model } = makeDb();
    model.create.mockRejectedValueOnce(new Error("database unavailable"));
    const result = await new AllianceClanMembershipIntervalService(db as any).reconcileCycle(input());

    expect(result.failed).toBe(true);
    expect(rows).toHaveLength(0);
  });
});

describe("observeCwlOnlyClanRosters", () => {
  it("fetches one roster for each unique CWL-only clan and never fetches players", async () => {
    const getClan = vi.fn(async (tag: string) => ({
      tag,
      members: [{ tag: "#PYLQ8888" }],
    }));
    const getPlayerRaw = vi.fn();
    const result = await observeCwlOnlyClanRosters({
      cwlClanTags: ["#QGRJ2222", "#QGRJ8888", "#QGRJ8888"],
      alreadyObservedClanTags: ["#QGRJ2222"],
      cocService: { getClan, getPlayerRaw } as any,
    });

    expect(result.attemptedFetches).toBe(1);
    expect(result.failedClanTags).toEqual([]);
    expect(result.rosters).toEqual([{ clanTag: "#QGRJ8888", playerTags: ["#PYLQ8888"] }]);
    expect(getClan).toHaveBeenCalledTimes(1);
    expect(getPlayerRaw).not.toHaveBeenCalled();
  });
});
