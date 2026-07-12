import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  $executeRaw: vi.fn(),
  $transaction: vi.fn(),
  currentWar: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/services/PointsSyncService", () => ({
  PointsSyncService: vi.fn().mockImplementation(() => ({
    getCurrentSyncForClan: vi.fn(),
    markNeedsValidation: vi.fn().mockResolvedValue(undefined),
    clearNeedsValidation: vi.fn().mockResolvedValue(undefined),
    markConfirmedByClanMail: vi.fn().mockResolvedValue(undefined),
  })),
}));

import {
  resolveCurrentWarScopedSyncRowForTest,
  resolveCurrentWarSyncIdentityForTest,
} from "../src/commands/Fwa";
import { ActiveWarIdentityService } from "../src/services/ActiveWarIdentityService";

function normalizeTag(input: string | null | undefined): string | null {
  const normalized = String(input ?? "")
    .trim()
    .toUpperCase()
    .replace(/^#/, "");
  return normalized ? normalized : null;
}

function makeWarIdentity(params: {
  currentWarId: number | null;
  currentWarStartTime: Date | null;
  currentWarOpponentTag: string | null;
  liveWarStartTime: string | null;
  liveOpponentTag: string | null;
}) {
  return resolveCurrentWarSyncIdentityForTest({
    clanTag: "#2RYGLU2UY",
    warState: "preparation",
    currentWarId: params.currentWarId,
    currentWarStartTime: params.currentWarStartTime,
    currentWarOpponentTag: params.currentWarOpponentTag,
    liveWarStartTime: params.liveWarStartTime,
    liveOpponentTag: params.liveOpponentTag,
  });
}

describe("Rocky Road war identity resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (callback: any) =>
      callback(prismaMock),
    );
    prismaMock.$queryRaw.mockResolvedValue([]);
    prismaMock.$executeRaw.mockResolvedValue(0);
    prismaMock.currentWar.findFirst.mockResolvedValue(null);
    prismaMock.currentWar.findUnique.mockResolvedValue(null);
    prismaMock.currentWar.update.mockResolvedValue({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("blocks the send path when the poller has not materialized a current-war id yet", () => {
    const identity = makeWarIdentity({
      currentWarId: null,
      currentWarStartTime: null,
      currentWarOpponentTag: null,
      liveWarStartTime: "20260712T152226.000Z",
      liveOpponentTag: "#LYPLQQUC",
    });

    expect(identity.positivelyResolved).toBe(true);
    expect(identity.warId).toBeNull();
    expect(identity.warStartTime?.toISOString()).toBe("2026-07-12T15:22:26.000Z");
    expect(identity.opponentTag).toBe("LYPLQQUC");
  });

  it("reuses the current-war id safely once the poller has stamped the matching identity", () => {
    const identity = makeWarIdentity({
      currentWarId: 1000610,
      currentWarStartTime: new Date("2026-07-12T15:22:26.000Z"),
      currentWarOpponentTag: "#LYPLQQUC",
      liveWarStartTime: "20260712T152226.000Z",
      liveOpponentTag: "#LYPLQQUC",
    });

    expect(identity.positivelyResolved).toBe(true);
    expect(identity.warId).toBe("1000610");
  });

  it("drops the current-war id when the final rerender only sees a partial live identity", () => {
    const identity = makeWarIdentity({
      currentWarId: 1000610,
      currentWarStartTime: new Date("2026-07-12T15:22:26.000Z"),
      currentWarOpponentTag: "#LYPLQQUC",
      liveWarStartTime: null,
      liveOpponentTag: "#LYPLQQUC",
    });

    expect(identity.warId).toBeNull();
    expect(identity.warStartTime?.toISOString()).toBe("2026-07-12T15:22:26.000Z");
    expect(identity.opponentTag).toBe("LYPLQQUC");
  });

  it("rejects a stale current-war id when the live identity has rolled to a new war", () => {
    const identity = makeWarIdentity({
      currentWarId: 1000609,
      currentWarStartTime: new Date("2026-07-11T15:22:26.000Z"),
      currentWarOpponentTag: "#OLDOPP",
      liveWarStartTime: "20260712T152226.000Z",
      liveOpponentTag: "#LYPLQQUC",
    });

    expect(identity.warId).toBeNull();
    expect(identity.warStartTime?.toISOString()).toBe("2026-07-12T15:22:26.000Z");
  });

  it("keeps scoped sync-row selection aligned to start time and opponent before reuse", () => {
    const selected = resolveCurrentWarScopedSyncRowForTest({
      rows: [
        {
          warId: "1000609",
          warStartTime: new Date("2026-07-11T15:22:26.000Z"),
          opponentTag: "#OLDOPP",
          needsValidation: false,
        } as any,
      ],
      warId: "1000610",
      warStartTime: new Date("2026-07-12T15:22:26.000Z"),
      opponentTag: "LYPLQQUC",
    });

    expect(selected).toBeNull();
  });
});

describe("ActiveWarIdentityService", () => {
  function makeCandidate(overrides?: Partial<Record<string, unknown>>) {
    return {
      state: "preparation",
      warStartTime: "20260712T152226.000Z",
      preparationStartTime: "20260711T152226.000Z",
      warEndTime: "20260713T152226.000Z",
      opponentTag: "#LYPLQQUC",
      opponentName: "War Farmers x44",
      clanName: "Rocky Road",
      ...overrides,
    };
  }

  function makeRow(overrides?: Record<string, unknown>) {
    return {
      warId: null,
      state: "preparation",
      prepStartTime: new Date("2026-07-11T15:22:26.000Z"),
      startTime: new Date("2026-07-12T15:22:26.000Z"),
      endTime: new Date("2026-07-13T15:22:26.000Z"),
      opponentTag: "#LYPLQQUC",
      opponentName: "War Farmers x44",
      clanName: "Rocky Road",
      ...overrides,
    };
  }

  function makeHarness(initialRows: Array<{ guildId: string; clanTag: string; row: Record<string, unknown> }>) {
    const rows = new Map(
      initialRows.map((entry) => [
        `${entry.guildId}|${entry.clanTag}`,
        { ...entry.row, guildId: entry.guildId, clanTag: entry.clanTag },
      ]),
    );
    let sequence = 1000000;
    let lock = Promise.resolve();
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(0),
      $queryRaw: vi.fn().mockImplementation(async () => [{ warId: sequence++ }]),
      currentWar: {
        findUnique: vi.fn().mockImplementation(async ({ where }: any) => {
          const key = `${where.clanTag_guildId.guildId}|${where.clanTag_guildId.clanTag}`;
          const row = rows.get(key) ?? null;
          return row ? { ...row } : null;
        }),
        findMany: vi.fn().mockImplementation(async ({ where }: any) => {
          const clanTag = where.clanTag;
          const startTime = where.startTime;
          const opponentTag = where.opponentTag;
          const warIdNotNull = where.warId?.not === null || where.warId?.not === undefined ? true : false;
          return [...rows.entries()]
            .map(([key, row]) => ({ key, row }))
            .filter(({ row }) => {
              if (clanTag && row.clanTag !== clanTag) return false;
              if (startTime && row.startTime instanceof Date && row.startTime.getTime() !== startTime.getTime()) return false;
              if (opponentTag && normalizeTag(String(row.opponentTag ?? "")) !== normalizeTag(String(opponentTag ?? ""))) return false;
              if (warIdNotNull && (row.warId === null || row.warId === undefined)) return false;
              return true;
            })
            .map(({ row }) => ({ ...row }));
        }),
        update: vi.fn().mockImplementation(async ({ where, data, select }: any) => {
          const key = `${where.clanTag_guildId.guildId}|${where.clanTag_guildId.clanTag}`;
          const current = rows.get(key);
          if (!current) {
            throw new Error("missing row");
          }
          const next = { ...current, ...data };
          rows.set(key, next);
          if (select) {
            const projected: Record<string, unknown> = {};
            for (const field of Object.keys(select)) {
              projected[field] = next[field as keyof typeof next];
            }
            return projected;
          }
          return { ...next };
        }),
      },
    };
    const db = {
      $transaction: vi.fn().mockImplementation(async (callback: any) => {
        const run = lock.then(() => callback(tx));
        lock = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      }),
    };
    return { db, tx, rows, setSequence: (value: number) => { sequence = value; } };
  }

  it("materializes a missing id for an exact interactive row and writes only the war id", async () => {
    const harness = makeHarness([
      {
        guildId: "guild-1",
        clanTag: "#2RYGLU2UY",
        row: makeRow({ warId: null }),
      },
    ]);
    harness.setSequence(1000610);
    const service = new ActiveWarIdentityService(harness.db as any);

    const result = await service.resolveCurrentWarId({
      policy: "interactive_materialize",
      guildId: "guild-1",
      clanTag: "2RYGLU2UY",
      candidateIdentity: makeCandidate(),
    });

    expect(result).toMatchObject({
      status: "resolved",
      warId: 1000610,
      source: "materialized_missing_id",
      liveValidated: true,
      identityPersisted: true,
    });
    expect(harness.tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(harness.rows.get("guild-1|#2RYGLU2UY")).toMatchObject({ warId: 1000610 });
    expect(harness.rows.get("guild-1|#2RYGLU2UY")).toMatchObject({
      startTime: new Date("2026-07-12T15:22:26.000Z"),
      opponentTag: "#LYPLQQUC",
    });
  });

  it("blocks an interactive stale-row rerender instead of rotating the persisted identity", async () => {
    const harness = makeHarness([
      {
        guildId: "guild-1",
        clanTag: "#2RYGLU2UY",
        row: makeRow({
          warId: 1000609,
          startTime: new Date("2026-07-11T15:22:26.000Z"),
          opponentTag: "#OLDOPP",
        }),
      },
    ]);
    const service = new ActiveWarIdentityService(harness.db as any);

    const result = await service.resolveCurrentWarId({
      policy: "interactive_materialize",
      guildId: "guild-1",
      clanTag: "2RYGLU2UY",
      candidateIdentity: makeCandidate(),
    });

    expect(result).toMatchObject({
      status: "blocked",
      reason: "persisted_identity_mismatch",
      warId: null,
    });
    expect(harness.tx.$queryRaw).not.toHaveBeenCalled();
    expect(harness.rows.get("guild-1|#2RYGLU2UY")).toMatchObject({
      warId: 1000609,
      startTime: new Date("2026-07-11T15:22:26.000Z"),
      opponentTag: "#OLDOPP",
    });
  });

  it("poll-reconciles a new war atomically and persists canonical identity", async () => {
    const harness = makeHarness([
      {
        guildId: "guild-1",
        clanTag: "#2RYGLU2UY",
        row: makeRow({
          warId: 1000609,
          startTime: new Date("2026-07-11T15:22:26.000Z"),
          opponentTag: "#OLDOPP",
        }),
      },
    ]);
    harness.setSequence(1000611);
    const service = new ActiveWarIdentityService(harness.db as any);

    const result = await service.resolveCurrentWarId({
      policy: "poll_reconcile",
      guildId: "guild-1",
      clanTag: "2RYGLU2UY",
      candidateIdentity: makeCandidate(),
    });

    expect(result).toMatchObject({
      status: "resolved",
      warId: 1000611,
      source: "allocated_new_identity",
      liveValidated: true,
      identityPersisted: true,
    });
    expect(harness.tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(harness.rows.get("guild-1|#2RYGLU2UY")).toMatchObject({
      warId: 1000611,
      state: "preparation",
      startTime: new Date("2026-07-12T15:22:26.000Z"),
      opponentTag: "#LYPLQQUC",
    });
  });

  it("preserves the persisted identity during outage recovery without allocation", async () => {
    const harness = makeHarness([
      {
        guildId: "guild-1",
        clanTag: "#2RYGLU2UY",
        row: makeRow({ warId: 1000610 }),
      },
    ]);
    const service = new ActiveWarIdentityService(harness.db as any);

    const result = await service.resolveCurrentWarId({
      policy: "preserve_persisted",
      guildId: "guild-1",
      clanTag: "2RYGLU2UY",
      candidateIdentity: makeCandidate({
        state: "inWar",
        opponentTag: "#SOMETHINGELSE",
      }),
    });

    expect(result).toMatchObject({
      status: "resolved",
      warId: 1000610,
      source: "preserved_during_outage_recovery",
      liveValidated: false,
    });
    expect(harness.tx.$queryRaw).not.toHaveBeenCalled();
    expect(harness.tx.currentWar.update).not.toHaveBeenCalled();
  });

  it("blocks outage preservation when the persisted row has no valid id", async () => {
    const harness = makeHarness([
      {
        guildId: "guild-1",
        clanTag: "#2RYGLU2UY",
        row: makeRow({ warId: null }),
      },
    ]);
    const service = new ActiveWarIdentityService(harness.db as any);

    const result = await service.resolveCurrentWarId({
      policy: "preserve_persisted",
      guildId: "guild-1",
      clanTag: "2RYGLU2UY",
      candidateIdentity: null,
    });

    expect(result).toMatchObject({
      status: "blocked",
      reason: "missing_preserved_id",
      warId: null,
    });
    expect(harness.tx.$queryRaw).not.toHaveBeenCalled();
    expect(harness.tx.currentWar.update).not.toHaveBeenCalled();
  });

  it("reuses one global exact identity across guild rows", async () => {
    const harness = makeHarness([
      {
        guildId: "guild-1",
        clanTag: "#2RYGLU2UY",
        row: makeRow({ warId: null }),
      },
      {
        guildId: "guild-2",
        clanTag: "#2RYGLU2UY",
        row: makeRow({ warId: null }),
      },
    ]);
    harness.setSequence(1000610);
    const service = new ActiveWarIdentityService(harness.db as any);
    const candidate = makeCandidate();

    const [first, second] = await Promise.all([
      service.resolveCurrentWarId({
        policy: "poll_reconcile",
        guildId: "guild-1",
        clanTag: "2RYGLU2UY",
        candidateIdentity: candidate,
      }),
      service.resolveCurrentWarId({
        policy: "poll_reconcile",
        guildId: "guild-2",
        clanTag: "2RYGLU2UY",
        candidateIdentity: candidate,
      }),
    ]);

    expect(first.status).toBe("resolved");
    expect(second.status).toBe("resolved");
    expect(first.warId).toBe(1000610);
    expect(second.warId).toBe(1000610);
    expect(harness.tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("allocates distinct ids for different wars resolved concurrently", async () => {
    const harness = makeHarness([
      {
        guildId: "guild-1",
        clanTag: "#2RYGLU2UY",
        row: makeRow({ warId: null }),
      },
      {
        guildId: "guild-2",
        clanTag: "#2RYGLU2UY",
        row: makeRow({
          warId: null,
          startTime: new Date("2026-07-13T15:22:26.000Z"),
          prepStartTime: new Date("2026-07-12T15:22:26.000Z"),
          endTime: new Date("2026-07-14T15:22:26.000Z"),
          opponentTag: "#DIFFOPP",
          opponentName: "Different Opponent",
        }),
      },
    ]);
    harness.setSequence(1000610);
    const service = new ActiveWarIdentityService(harness.db as any);

    const [first, second] = await Promise.all([
      service.resolveCurrentWarId({
        policy: "poll_reconcile",
        guildId: "guild-1",
        clanTag: "2RYGLU2UY",
        candidateIdentity: makeCandidate(),
      }),
      service.resolveCurrentWarId({
        policy: "poll_reconcile",
        guildId: "guild-2",
        clanTag: "2RYGLU2UY",
        candidateIdentity: makeCandidate({
          warStartTime: "20260713T152226.000Z",
          preparationStartTime: "20260712T152226.000Z",
          warEndTime: "20260714T152226.000Z",
          opponentTag: "#DIFFOPP",
          opponentName: "Different Opponent",
        }),
      }),
    ]);

    expect(first.status).toBe("resolved");
    expect(second.status).toBe("resolved");
    expect(first.warId).not.toBe(second.warId);
    expect(harness.tx.$queryRaw).toHaveBeenCalledTimes(2);
  });
});
