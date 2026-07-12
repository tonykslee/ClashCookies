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

function querySqlText(query: any): string {
  if (query && Array.isArray(query.strings)) {
    return query.strings.join("?");
  }
  return String(query ?? "");
}

function createKeyLockManager() {
  const tails = new Map<string, Promise<void>>();
  return {
    async acquire(key: string): Promise<() => void> {
      const previous = tails.get(key) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      tails.set(key, previous.then(() => current));
      await previous;
      return () => release();
    },
  };
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
    const rowLocks = createKeyLockManager();
    const physicalLocks = createKeyLockManager();
    const lockEvents: string[] = [];
    const transactions: Array<any> = [];
    const makeTx = () => {
      const heldReleases: Array<() => void> = [];
      const acquireLock = async (kind: "row" | "physical", key: string) => {
        lockEvents.push(`acquire:${kind}:${key}`);
        const release = await (kind === "row"
          ? rowLocks.acquire(key)
          : physicalLocks.acquire(key));
        heldReleases.push(() => {
          lockEvents.push(`release:${kind}:${key}`);
          release();
        });
      };
      return {
        $executeRaw: vi.fn().mockImplementation(async (query: any) => {
          const sql = querySqlText(query);
          if (sql.includes("pg_advisory_xact_lock(hashtextextended(")) {
            await acquireLock("physical", String(query?.values?.[0] ?? ""));
          }
          return 0;
        }),
        $queryRaw: vi.fn().mockImplementation(async (query: any) => {
          const sql = querySqlText(query);
          if (sql.includes("FOR UPDATE") && sql.includes('"CurrentWar"')) {
            const guildId = String(query?.values?.[0] ?? "");
            const clanTag = String(query?.values?.[1] ?? "");
            await acquireLock("row", `${guildId}|${clanTag}`);
            const row = rows.get(`${guildId}|${clanTag}`) ?? null;
            return row ? [{ ...row }] : [];
          }
          if (
            sql.includes('SELECT cw."warId"') &&
            sql.includes('FROM "CurrentWar" cw') &&
            sql.includes('cw."startTime"') &&
            sql.includes('cw."opponentTag"') &&
            sql.includes('cw."warId" IS NOT NULL')
          ) {
            const clanTag = String(query?.values?.[0] ?? "");
            const startTime = query?.values?.[1];
            const opponentTag = String(query?.values?.[2] ?? "");
            return [...rows.values()]
              .filter((row) => {
                if (row.clanTag !== `#${clanTag.replace(/^#/, "")}`) return false;
                if (
                  startTime instanceof Date &&
                  row.startTime instanceof Date &&
                  row.startTime.getTime() !== startTime.getTime()
                )
                  return false;
                if (
                  normalizeTag(String(row.opponentTag ?? "")) !==
                  normalizeTag(opponentTag)
                )
                  return false;
                return row.warId !== null && row.warId !== undefined;
              })
              .map((row) => ({ warId: row.warId }));
          }
          if (sql.includes('nextval(\'"CurrentWar_warId_seq"\'::regclass)')) {
            return [{ warId: sequence++ }];
          }
          return [];
        }),
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
            const warIdNotNull =
              where.warId?.not === null || where.warId?.not === undefined
                ? true
                : false;
            return [...rows.entries()]
              .map(([key, row]) => ({ key, row }))
              .filter(({ row }) => {
                if (clanTag && row.clanTag !== clanTag) return false;
                if (
                  startTime &&
                  row.startTime instanceof Date &&
                  row.startTime.getTime() !== startTime.getTime()
                )
                  return false;
                if (
                  opponentTag &&
                  normalizeTag(String(row.opponentTag ?? "")) !==
                    normalizeTag(String(opponentTag ?? ""))
                )
                  return false;
                if (
                  warIdNotNull &&
                  (row.warId === null || row.warId === undefined)
                )
                  return false;
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
        releaseLocks: () => {
          while (heldReleases.length > 0) {
            const release = heldReleases.pop();
            release?.();
          }
        },
      };
    };
    const db = {
      $transaction: vi.fn().mockImplementation(async (callback: any) => {
        const tx = makeTx();
        transactions.push(tx);
        try {
          return await callback(tx);
        } finally {
          tx.releaseLocks();
        }
      }),
    };
    return {
      db,
      rows,
      transactions,
      lockEvents,
      setSequence: (value: number) => {
        sequence = value;
      },
    };
  }

  function hasSql(tx: any, pattern: string): boolean {
    return tx.$queryRaw.mock.calls.some(([query]: [any]) =>
      querySqlText(query).includes(pattern),
    );
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
    expect(hasSql(harness.transactions[0], "FOR UPDATE")).toBe(true);
    expect(hasSql(harness.transactions[0], "nextval")).toBe(true);
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
    expect(hasSql(harness.transactions[0], "nextval")).toBe(false);
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
    expect(hasSql(harness.transactions[0], "FOR UPDATE")).toBe(true);
    expect(hasSql(harness.transactions[0], "nextval")).toBe(true);
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
    expect(hasSql(harness.transactions[0], "nextval")).toBe(false);
    expect(harness.transactions[0].currentWar.update).not.toHaveBeenCalled();
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
    expect(hasSql(harness.transactions[0], "nextval")).toBe(false);
    expect(harness.transactions[0].currentWar.update).not.toHaveBeenCalled();
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
    expect(hasSql(harness.transactions[0], "nextval")).toBe(true);
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
    expect(harness.transactions).toHaveLength(2);
    expect(hasSql(harness.transactions[0], "nextval")).toBe(true);
    expect(hasSql(harness.transactions[1], "nextval")).toBe(true);
  });

  it("serializes concurrent reconciles on the same row without mixing identities", async () => {
    const harness = makeHarness([
      {
        guildId: "guild-1",
        clanTag: "#2RYGLU2UY",
        row: makeRow({ warId: null }),
      },
    ]);
    harness.setSequence(1000610);
    const service = new ActiveWarIdentityService(harness.db as any);
    const firstCandidate = makeCandidate({
      warStartTime: "20260712T152226.000Z",
      preparationStartTime: "20260711T152226.000Z",
      warEndTime: "20260713T152226.000Z",
      opponentTag: "#LYPLQQUC",
      opponentName: "First Opponent",
    });
    const secondCandidate = makeCandidate({
      warStartTime: "20260713T152226.000Z",
      preparationStartTime: "20260712T152226.000Z",
      warEndTime: "20260714T152226.000Z",
      opponentTag: "#DIFFOPP",
      opponentName: "Second Opponent",
    });

    const firstPromise = service.resolveCurrentWarId({
      policy: "poll_reconcile",
      guildId: "guild-1",
      clanTag: "2RYGLU2UY",
      candidateIdentity: firstCandidate,
    });
    await Promise.resolve();
    const secondPromise = service.resolveCurrentWarId({
      policy: "poll_reconcile",
      guildId: "guild-1",
      clanTag: "2RYGLU2UY",
      candidateIdentity: secondCandidate,
    });

    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    const finalRow = harness.rows.get("guild-1|#2RYGLU2UY") as Record<string, unknown>;

    expect(first.status).toBe("resolved");
    expect(second.status).toBe("resolved");
    expect(harness.lockEvents.filter((event) => event.startsWith("acquire:row:guild-1|#2RYGLU2UY"))).toHaveLength(2);
    expect(harness.lockEvents.filter((event) => event.startsWith("acquire:physical:"))).toHaveLength(2);

    const finalStartTime = (finalRow.startTime as Date).toISOString();
    const finalOpponentTag = normalizeTag(String(finalRow.opponentTag ?? ""));
    const firstShape =
      finalStartTime === "2026-07-12T15:22:26.000Z" &&
      finalOpponentTag === "LYPLQQUC";
    const secondShape =
      finalStartTime === "2026-07-13T15:22:26.000Z" &&
      finalOpponentTag === "DIFFOPP";

    expect(firstShape || secondShape).toBe(true);
    expect(firstShape && secondShape).toBe(false);
  });

  it("serializes preserve and reconcile on the same row without cross-wiring identity fields", async () => {
    const harness = makeHarness([
      {
        guildId: "guild-1",
        clanTag: "#2RYGLU2UY",
        row: makeRow({ warId: 1000610 }),
      },
    ]);
    harness.setSequence(1000611);
    const service = new ActiveWarIdentityService(harness.db as any);
    const reconcileCandidate = makeCandidate({
      warStartTime: "20260713T152226.000Z",
      preparationStartTime: "20260712T152226.000Z",
      warEndTime: "20260714T152226.000Z",
      opponentTag: "#DIFFOPP",
      opponentName: "Second Opponent",
    });

    const preservePromise = service.resolveCurrentWarId({
      policy: "preserve_persisted",
      guildId: "guild-1",
      clanTag: "2RYGLU2UY",
      candidateIdentity: null,
    });
    await Promise.resolve();
    const reconcilePromise = service.resolveCurrentWarId({
      policy: "poll_reconcile",
      guildId: "guild-1",
      clanTag: "2RYGLU2UY",
      candidateIdentity: reconcileCandidate,
    });

    const [preserved, reconciled] = await Promise.all([
      preservePromise,
      reconcilePromise,
    ]);
    const finalRow = harness.rows.get("guild-1|#2RYGLU2UY") as Record<string, unknown>;

    expect(preserved.status).toBe("resolved");
    expect(preserved.warId).toBe(1000610);
    expect(reconciled.status).toBe("resolved");
    expect(harness.lockEvents.filter((event) => event.startsWith("acquire:row:guild-1|#2RYGLU2UY"))).toHaveLength(2);

    const finalStartTime = (finalRow.startTime as Date).toISOString();
    const finalOpponentTag = normalizeTag(String(finalRow.opponentTag ?? ""));
    const preservedShape =
      finalStartTime === "2026-07-12T15:22:26.000Z" &&
      finalOpponentTag === "LYPLQQUC";
    const reconciledShape =
      finalStartTime === "2026-07-13T15:22:26.000Z" &&
      finalOpponentTag === "DIFFOPP";

    expect(preservedShape || reconciledShape).toBe(true);
    expect(preservedShape && reconciledShape).toBe(false);
  });

  it("clears stale optional metadata when poll_reconcile advances to a new physical war", async () => {
    const harness = makeHarness([
      {
        guildId: "guild-1",
        clanTag: "#2RYGLU2UY",
        row: makeRow({
          warId: 1000610,
          prepStartTime: new Date("2026-07-11T15:22:26.000Z"),
          startTime: new Date("2026-07-12T15:22:26.000Z"),
          endTime: new Date("2026-07-13T15:22:26.000Z"),
          opponentTag: "#LYPLQQUC",
          opponentName: "War Farmers x44",
          clanName: "Rocky Road",
        }),
      },
    ]);
    harness.setSequence(1000700);
    const service = new ActiveWarIdentityService(harness.db as any);

    const result = await service.resolveCurrentWarId({
      policy: "poll_reconcile",
      guildId: "guild-1",
      clanTag: "2RYGLU2UY",
      candidateIdentity: makeCandidate({
        warStartTime: "20260713T152226.000Z",
        opponentTag: "#DIFFOPP",
        preparationStartTime: null,
        warEndTime: null,
        opponentName: null,
        clanName: null,
      }),
    });

    const finalRow = harness.rows.get("guild-1|#2RYGLU2UY") as Record<string, unknown>;
    expect(result.status).toBe("resolved");
    expect(result.warId).toBe(1000700);
    expect(finalRow.startTime instanceof Date).toBe(true);
    expect((finalRow.startTime as Date).toISOString()).toBe("2026-07-13T15:22:26.000Z");
    expect(normalizeTag(String(finalRow.opponentTag ?? ""))).toBe("DIFFOPP");
    expect(finalRow.prepStartTime).toBeNull();
    expect(finalRow.endTime).toBeNull();
    expect(finalRow.opponentName).toBeNull();
    expect(finalRow.clanName).toBeNull();
  });

  it("blocks conflicting preexisting global ids for the same physical war", async () => {
    const harness = makeHarness([
      {
        guildId: "guild-1",
        clanTag: "#2RYGLU2UY",
        row: makeRow({ warId: 1000610 }),
      },
      {
        guildId: "guild-2",
        clanTag: "#2RYGLU2UY",
        row: makeRow({ warId: 1000611 }),
      },
    ]);
    const service = new ActiveWarIdentityService(harness.db as any);

    const result = await service.resolveCurrentWarId({
      policy: "poll_reconcile",
      guildId: "guild-1",
      clanTag: "2RYGLU2UY",
      candidateIdentity: makeCandidate(),
    });

    expect(result).toMatchObject({
      status: "blocked",
      reason: "conflicting_global_identity_ids",
      warId: null,
    });
    expect(harness.rows.get("guild-1|#2RYGLU2UY")).toMatchObject({ warId: 1000610 });
    expect(harness.rows.get("guild-2|#2RYGLU2UY")).toMatchObject({ warId: 1000611 });
  });
});
