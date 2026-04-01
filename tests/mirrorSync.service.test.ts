import { describe, expect, it, vi } from "vitest";
import { MIRRORED_RUNTIME_TABLES, MirrorSyncService } from "../src/services/MirrorSyncService";

type MirrorTableDataStore = Record<
  (typeof MIRRORED_RUNTIME_TABLES)[number],
  Array<Record<string, unknown>>
>;

type ColumnRow = {
  column_name: string;
  udt_name: string;
  is_nullable: "YES" | "NO";
  column_default: string | null;
};

function makeDefaultTableStore(): MirrorTableDataStore {
  return {
    TrackedClan: [{ id: 1, tag: "#AAA111", createdAt: new Date("2026-04-01T00:00:00.000Z") }],
    CurrentWar: [{ guildId: "g1", clanTag: "#AAA111", channelId: "c1", notify: true }],
    WarAttacks: [{ warId: 1, playerTag: "#P1", attackNumber: 1 }],
    ClanPointsSync: [{ id: "ps1", guildId: "g1", clanTag: "#AAA111", syncNum: 42 }],
    ClanWarHistory: [{ warId: 1, clanTag: "#AAA111", warStartTime: new Date("2026-03-30T00:00:00.000Z") }],
    ClanWarParticipation: [{ id: "p1", guildId: "g1", warId: "1", clanTag: "#AAA111", playerTag: "#P1" }],
    WarLookup: [{ warId: "1", clanTag: "#AAA111", startTime: new Date("2026-03-30T00:00:00.000Z"), payload: {} }],
  };
}

function makeSchemaColumns(
  override?: Partial<Record<(typeof MIRRORED_RUNTIME_TABLES)[number], ColumnRow[]>>,
): Record<(typeof MIRRORED_RUNTIME_TABLES)[number], ColumnRow[]> {
  const defaults = Object.fromEntries(
    MIRRORED_RUNTIME_TABLES.map((table) => [
      table,
      [
        {
          column_name: "id",
          udt_name: "text",
          is_nullable: "NO" as const,
          column_default: null,
        },
      ],
    ]),
  ) as Record<(typeof MIRRORED_RUNTIME_TABLES)[number], ColumnRow[]>;
  return {
    ...defaults,
    ...(override ?? {}),
  };
}

function cloneRows(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.map((row) => ({ ...row }));
}

function buildSourceClient(
  store: MirrorTableDataStore,
  schemaColumns: Record<(typeof MIRRORED_RUNTIME_TABLES)[number], ColumnRow[]>,
) {
  const disconnect = vi.fn(async () => undefined);
  return {
    trackedClan: {
      findMany: vi.fn(async () => cloneRows(store.TrackedClan)),
    },
    currentWar: {
      findMany: vi.fn(async () => cloneRows(store.CurrentWar)),
    },
    warAttacks: {
      findMany: vi.fn(async () => cloneRows(store.WarAttacks)),
    },
    clanPointsSync: {
      findMany: vi.fn(async () => cloneRows(store.ClanPointsSync)),
    },
    clanWarHistory: {
      findMany: vi.fn(async () => cloneRows(store.ClanWarHistory)),
    },
    clanWarParticipation: {
      findMany: vi.fn(async () => cloneRows(store.ClanWarParticipation)),
    },
    warLookup: {
      findMany: vi.fn(async () => cloneRows(store.WarLookup)),
    },
    $queryRawUnsafe: vi.fn(
      async (_query: string, table: (typeof MIRRORED_RUNTIME_TABLES)[number]) =>
        schemaColumns[table] ?? [],
    ),
    $disconnect: disconnect,
  };
}

function buildTargetClient(
  store: MirrorTableDataStore,
  schemaColumns: Record<(typeof MIRRORED_RUNTIME_TABLES)[number], ColumnRow[]>,
) {
  const deleteMany = (table: (typeof MIRRORED_RUNTIME_TABLES)[number]) =>
    vi.fn(async () => {
      const count = store[table].length;
      store[table] = [];
      return { count };
    });
  const createMany = (table: (typeof MIRRORED_RUNTIME_TABLES)[number]) =>
    vi.fn(async (args: { data: Array<Record<string, unknown>> }) => {
      store[table].push(...cloneRows(args.data));
      return { count: args.data.length };
    });

  const tx = {
    trackedClan: { deleteMany: deleteMany("TrackedClan"), createMany: createMany("TrackedClan") },
    currentWar: { deleteMany: deleteMany("CurrentWar"), createMany: createMany("CurrentWar") },
    warAttacks: { deleteMany: deleteMany("WarAttacks"), createMany: createMany("WarAttacks") },
    clanPointsSync: {
      deleteMany: deleteMany("ClanPointsSync"),
      createMany: createMany("ClanPointsSync"),
    },
    clanWarHistory: {
      deleteMany: deleteMany("ClanWarHistory"),
      createMany: createMany("ClanWarHistory"),
    },
    clanWarParticipation: {
      deleteMany: deleteMany("ClanWarParticipation"),
      createMany: createMany("ClanWarParticipation"),
    },
    warLookup: { deleteMany: deleteMany("WarLookup"), createMany: createMany("WarLookup") },
    $queryRawUnsafe: vi.fn(
      async (_query: string, table: (typeof MIRRORED_RUNTIME_TABLES)[number]) =>
        schemaColumns[table] ?? [],
    ),
    $executeRawUnsafe: vi.fn(async () => 1),
  };

  return {
    ...tx,
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
    __tx: tx,
  };
}

describe("MirrorSyncService", () => {
  it("runs full-overwrite sync for only the allowlisted runtime tables", async () => {
    const sourceStore = makeDefaultTableStore();
    const targetStore = makeDefaultTableStore();
    targetStore.TrackedClan = [{ id: 99, tag: "#OLD" }];
    const schemaColumns = makeSchemaColumns();
    const sourceClient = buildSourceClient(sourceStore, schemaColumns);
    const targetClient = buildTargetClient(targetStore, schemaColumns);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const service = new MirrorSyncService({
      env: {
        POLLING_MODE: "mirror",
        POLLING_ENV: "staging",
        MIRROR_SOURCE_DATABASE_URL:
          "postgresql://src:pass@127.0.0.1:5432/clashcookies?schema=public",
        DATABASE_URL:
          "postgresql://dst:pass@127.0.0.1:5432/clashcookies_staging?schema=public",
        MIRROR_SYNC_BATCH_SIZE: "2",
      } as NodeJS.ProcessEnv,
      logger,
      targetClient: targetClient as any,
      createSourceClient: () => sourceClient as any,
    });

    const result = await service.syncNow("manual");

    expect(result.trigger).toBe("manual");
    expect(result.tableSummaries).toHaveLength(MIRRORED_RUNTIME_TABLES.length);
    expect(targetStore.TrackedClan).toEqual(sourceStore.TrackedClan);
    expect(targetStore.CurrentWar).toEqual(sourceStore.CurrentWar);
    expect(targetStore.WarAttacks).toEqual(sourceStore.WarAttacks);
    expect(targetStore.ClanPointsSync).toEqual(sourceStore.ClanPointsSync);
    expect(targetStore.ClanWarHistory).toEqual(sourceStore.ClanWarHistory);
    expect(targetStore.ClanWarParticipation).toEqual(sourceStore.ClanWarParticipation);
    expect(targetStore.WarLookup).toEqual(sourceStore.WarLookup);
    expect(targetClient.$executeRawUnsafe).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("[mirror-sync] event=manual_completed"),
    );
  });

  it("blocks execution when polling mode is not mirror", async () => {
    const service = new MirrorSyncService({
      env: {
        POLLING_MODE: "active",
        POLLING_ENV: "staging",
        MIRROR_SOURCE_DATABASE_URL:
          "postgresql://src:pass@127.0.0.1:5432/clashcookies?schema=public",
        DATABASE_URL:
          "postgresql://dst:pass@127.0.0.1:5432/clashcookies_staging?schema=public",
      } as NodeJS.ProcessEnv,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await expect(service.syncNow("manual")).rejects.toThrow(
      "Mirror sync is only allowed when POLLING_MODE=mirror.",
    );
  });

  it("blocks mirror sync when runtime environment resolves to prod", async () => {
    const service = new MirrorSyncService({
      env: {
        POLLING_MODE: "mirror",
        POLLING_ENV: "prod",
        MIRROR_SOURCE_DATABASE_URL:
          "postgresql://src:pass@127.0.0.1:5432/clashcookies?schema=public",
        DATABASE_URL:
          "postgresql://dst:pass@127.0.0.1:5432/clashcookies_staging?schema=public",
      } as NodeJS.ProcessEnv,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await expect(service.syncNow("scheduled")).rejects.toThrow(
      "Mirror sync is blocked in production runtime environment.",
    );
  });

  it("fails fast on schema incompatibility before table overwrite begins", async () => {
    const sourceStore = makeDefaultTableStore();
    const targetStore = makeDefaultTableStore();
    const sourceSchema = makeSchemaColumns();
    const targetSchema = makeSchemaColumns({
      CurrentWar: [
        {
          column_name: "id",
          udt_name: "int4",
          is_nullable: "NO",
          column_default: null,
        },
      ],
    });
    const sourceClient = buildSourceClient(sourceStore, sourceSchema);
    const targetClient = buildTargetClient(targetStore, targetSchema);

    const service = new MirrorSyncService({
      env: {
        POLLING_MODE: "mirror",
        POLLING_ENV: "staging",
        MIRROR_SOURCE_DATABASE_URL:
          "postgresql://src:pass@127.0.0.1:5432/clashcookies?schema=public",
        DATABASE_URL:
          "postgresql://dst:pass@127.0.0.1:5432/clashcookies_staging?schema=public",
      } as NodeJS.ProcessEnv,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      targetClient: targetClient as any,
      createSourceClient: () => sourceClient as any,
    });

    await expect(service.syncNow("scheduled")).rejects.toThrow(
      "Schema compatibility check failed for CurrentWar",
    );
    expect(targetClient.$transaction).not.toHaveBeenCalled();
    expect(targetClient.__tx.currentWar.deleteMany).not.toHaveBeenCalled();
  });
});
