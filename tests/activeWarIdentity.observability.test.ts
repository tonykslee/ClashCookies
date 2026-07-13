import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  $executeRaw: vi.fn(),
  $transaction: vi.fn(),
  currentWar: {
    update: vi.fn(),
  },
}));

const dozzleLogMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const telemetryIngestMock = vi.hoisted(() => ({
  recordStageTiming: vi.fn(),
}));

const telemetryContextMock = vi.hoisted(() => ({
  getTelemetryContext: vi.fn(),
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/helper/dozzleLogger", () => ({
  dozzleLog: dozzleLogMock,
}));

vi.mock("../src/services/telemetry/ingest", () => ({
  TelemetryIngestService: {
    getInstance: vi.fn(() => telemetryIngestMock),
  },
}));

vi.mock("../src/services/telemetry/context", () => ({
  getTelemetryContext: telemetryContextMock.getTelemetryContext,
}));

import { ActiveWarIdentityService } from "../src/services/ActiveWarIdentityService";

function querySqlText(query: any): string {
  if (query && Array.isArray(query.strings)) {
    return query.strings.join("?");
  }
  return String(query ?? "");
}

function installTransactionHarness(params: {
  currentWarRow: Record<string, unknown> | null;
  exactGlobalRows?: Array<{ warId: number | null }>;
  nextWarId?: number | null;
  updateRow?: boolean;
}) {
  const currentWarRow = params.currentWarRow;
  const exactGlobalRows = params.exactGlobalRows ?? [];
  const nextWarId = params.nextWarId ?? 1001;
  prismaMock.$transaction.mockImplementation(async (callback: any) =>
    callback(prismaMock),
  );
  prismaMock.$queryRaw.mockImplementation(async (query: any) => {
    const sql = querySqlText(query);
    if (sql.includes('FOR UPDATE') && sql.includes('"CurrentWar"')) {
      return currentWarRow ? [{ ...currentWarRow }] : [];
    }
    if (sql.includes('SELECT cw."warId"') && sql.includes('FROM "CurrentWar" cw')) {
      return exactGlobalRows;
    }
    if (sql.includes('SELECT nextval(\'"CurrentWar_warId_seq"\'::regclass)')) {
      return nextWarId === null ? [{ warId: null }] : [{ warId: BigInt(nextWarId) }];
    }
    return [];
  });
  prismaMock.currentWar.update.mockImplementation(async ({ data }: any) => ({
    ...(currentWarRow ?? {}),
    warId: data.warId ?? currentWarRow?.warId ?? null,
    state: data.state ?? currentWarRow?.state ?? null,
    prepStartTime: data.prepStartTime ?? currentWarRow?.prepStartTime ?? null,
    startTime: data.startTime ?? currentWarRow?.startTime ?? null,
    endTime: data.endTime ?? currentWarRow?.endTime ?? null,
    opponentTag: data.opponentTag ?? currentWarRow?.opponentTag ?? null,
    opponentName: data.opponentName ?? currentWarRow?.opponentName ?? null,
    clanName: data.clanName ?? currentWarRow?.clanName ?? null,
  }));
}

function parseActiveWarIdentityLog() {
  const calls = [
    ...dozzleLogMock.debug.mock.calls,
    ...dozzleLogMock.info.mock.calls,
    ...dozzleLogMock.warn.mock.calls,
    ...dozzleLogMock.error.mock.calls,
  ];
  return calls
    .map(([message]) => {
      const text = String(message ?? "");
      const payloadText = text.replace(/^\[active-war-identity\]\s*/, "");
      try {
        return JSON.parse(payloadText);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

describe("ActiveWarIdentityService observability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dozzleLogMock.debug.mockReset();
    dozzleLogMock.info.mockReset();
    dozzleLogMock.warn.mockReset();
    dozzleLogMock.error.mockReset();
    telemetryIngestMock.recordStageTiming.mockReset();
    prismaMock.$queryRaw.mockReset();
    prismaMock.$executeRaw.mockReset();
    prismaMock.$transaction.mockReset();
    prismaMock.currentWar.update.mockReset();
    telemetryContextMock.getTelemetryContext.mockReturnValue({
      runId: "run-1",
      guildId: "guild-1",
      userId: "user-1",
      commandName: "fwa",
      subcommand: "match",
      interactionId: "interaction-1",
    });
    prismaMock.$queryRaw.mockResolvedValue([]);
    prismaMock.$executeRaw.mockResolvedValue(0);
    prismaMock.currentWar.update.mockResolvedValue({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("records a successful stage timing and bounded structured log for an existing exact row", async () => {
    installTransactionHarness({
      currentWarRow: {
        warId: 1001,
        state: "preparation",
        prepStartTime: new Date("2026-03-11T00:00:00.000Z"),
        startTime: new Date("2026-03-12T00:00:00.000Z"),
        endTime: new Date("2026-03-12T01:00:00.000Z"),
        opponentTag: "#OPP123",
        opponentName: "Enemy",
        clanName: "Clan",
      },
      exactGlobalRows: [{ warId: 1001 }],
    });

    const service = new ActiveWarIdentityService();
    const result = await service.resolveCurrentWarId({
      policy: "interactive_materialize",
      guildId: "guild-1",
      clanTag: "#AAA111",
      candidateIdentity: {
        state: "preparation",
        warStartTime: "20260312T000000.000Z",
        preparationStartTime: "20260311T000000.000Z",
        warEndTime: "20260312T010000.000Z",
        opponentTag: "#OPP123",
        opponentName: "Enemy",
        clanName: "Clan",
      },
      observabilityContext: {
        caller: "fwa_mail_render",
        runId: "run-1",
        interactionId: "interaction-1",
      },
    });

    expect(result).toMatchObject({
      status: "resolved",
      warId: 1001,
      source: "existing_exact_row",
      liveValidated: true,
      identityPersisted: true,
    });
    expect(telemetryIngestMock.recordStageTiming).toHaveBeenCalledTimes(1);
    expect(telemetryIngestMock.recordStageTiming).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "active_war_identity_resolution",
        status: "success",
        guildId: "guild-1",
        commandName: "fwa",
        subcommand: "match",
        runId: "run-1",
      }),
    );
    const payloads = parseActiveWarIdentityLog();
    expect(payloads[0]).toEqual(
      expect.objectContaining({
        kind: "active_war_identity_resolution",
        status: "resolved",
        policy: "interactive_materialize",
        caller: "fwa_mail_render",
        guildId: "guild-1",
        clanTag: "#AAA111",
        persistedWarId: 1001,
        persistedState: "preparation",
        persistedWarStartTime: "2026-03-12T00:00:00.000Z",
        persistedOpponentTag: "OPP123",
        postPersistedWarId: 1001,
        postPersistedState: "preparation",
        postPersistedWarStartTime: "2026-03-12T00:00:00.000Z",
        postPersistedOpponentTag: "OPP123",
        source: "existing_exact_row",
        reasonCode: null,
        allocationOccurred: false,
        identityPersisted: true,
        identityPreserved: false,
        liveValidated: true,
        runId: "run-1",
        interactionId: "interaction-1",
      }),
    );
    expect(payloads[0]?.resolvedWarId).toBe(1001);
  });

  it("records a failed stage timing and blocked reason for a partial live identity", async () => {
    installTransactionHarness({
      currentWarRow: {
        warId: 1001,
        state: "preparation",
        prepStartTime: new Date("2026-03-11T00:00:00.000Z"),
        startTime: new Date("2026-03-12T00:00:00.000Z"),
        endTime: new Date("2026-03-12T01:00:00.000Z"),
        opponentTag: "#OPP123",
        opponentName: "Enemy",
        clanName: "Clan",
      },
    });

    const service = new ActiveWarIdentityService();
    const result = await service.resolveCurrentWarId({
      policy: "interactive_materialize",
      guildId: "guild-1",
      clanTag: "#AAA111",
      candidateIdentity: {
        state: "preparation",
        warStartTime: null,
        opponentTag: "#OPP123",
        clanName: "Clan",
      },
      observabilityContext: {
        caller: "war_event_poll",
      },
    });

    expect(result).toEqual({
      status: "blocked",
      warId: null,
      reason: "partial_live_identity",
    });
    expect(telemetryIngestMock.recordStageTiming).toHaveBeenCalledTimes(1);
    expect(telemetryIngestMock.recordStageTiming).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "active_war_identity_resolution",
        status: "failure",
        guildId: "guild-1",
        commandName: "fwa",
        subcommand: "match",
      }),
    );
    const payloads = parseActiveWarIdentityLog();
    expect(payloads[0]).toEqual(
      expect.objectContaining({
        kind: "active_war_identity_resolution",
        status: "blocked",
        reasonCode: "partial_live_identity",
        resolvedWarId: null,
      }),
    );
    expect(dozzleLogMock.warn).toHaveBeenCalled();
  });

  it("samples repeated existing exact-row successes without hiding mutations or blocks", async () => {
    const service = new ActiveWarIdentityService();

    installTransactionHarness({
      currentWarRow: {
        warId: 1001,
        state: "preparation",
        prepStartTime: new Date("2026-03-11T00:00:00.000Z"),
        startTime: new Date("2026-03-12T00:00:00.000Z"),
        endTime: new Date("2026-03-12T01:00:00.000Z"),
        opponentTag: "#OPP123",
        opponentName: "Enemy",
        clanName: "Clan",
      },
      exactGlobalRows: [{ warId: 1001 }],
    });
    await service.resolveCurrentWarId({
      policy: "interactive_materialize",
      guildId: "guild-1",
      clanTag: "#AAA111",
      candidateIdentity: {
        state: "preparation",
        warStartTime: "20260312T000000.000Z",
        opponentTag: "#OPP123",
        clanName: "Clan",
      },
      observabilityContext: {
        caller: "fwa_mail_render",
      },
    });

    installTransactionHarness({
      currentWarRow: {
        warId: 1001,
        state: "preparation",
        prepStartTime: new Date("2026-03-11T00:00:00.000Z"),
        startTime: new Date("2026-03-12T00:00:00.000Z"),
        endTime: new Date("2026-03-12T01:00:00.000Z"),
        opponentTag: "#OPP123",
        opponentName: "Enemy",
        clanName: "Clan",
      },
      exactGlobalRows: [{ warId: 1001 }],
    });
    await service.resolveCurrentWarId({
      policy: "interactive_materialize",
      guildId: "guild-1",
      clanTag: "#AAA111",
      candidateIdentity: {
        state: "preparation",
        warStartTime: "20260312T000000.000Z",
        opponentTag: "#OPP123",
        clanName: "Clan",
      },
      observabilityContext: {
        caller: "fwa_mail_render",
      },
    });

    expect(dozzleLogMock.info).toHaveBeenCalledTimes(1);
    expect(dozzleLogMock.debug).toHaveBeenCalledTimes(1);
    expect(parseActiveWarIdentityLog()[0]).toEqual(
      expect.objectContaining({
        source: "existing_exact_row",
        persistedWarId: 1001,
        persistedWarStartTime: "2026-03-12T00:00:00.000Z",
        persistedOpponentTag: "OPP123",
        postPersistedWarId: 1001,
      }),
    );
  });

  it("keeps telemetry and logging failures from changing the resolver output", async () => {
    installTransactionHarness({
      currentWarRow: {
        warId: 1001,
        state: "preparation",
        prepStartTime: new Date("2026-03-11T00:00:00.000Z"),
        startTime: new Date("2026-03-12T00:00:00.000Z"),
        endTime: new Date("2026-03-12T01:00:00.000Z"),
        opponentTag: "#OPP123",
        opponentName: "Enemy",
        clanName: "Clan",
      },
      exactGlobalRows: [{ warId: 1001 }],
    });
    telemetryIngestMock.recordStageTiming.mockImplementation(() => {
      throw new Error("telemetry boom");
    });
    dozzleLogMock.info.mockImplementation(() => {
      throw new Error("log boom");
    });

    const service = new ActiveWarIdentityService();
    const result = await service.resolveCurrentWarId({
      policy: "interactive_materialize",
      guildId: "guild-1",
      clanTag: "#AAA111",
      candidateIdentity: {
        state: "preparation",
        warStartTime: "20260312T000000.000Z",
        opponentTag: "#OPP123",
        clanName: "Clan",
      },
      observabilityContext: {
        caller: "fwa_mail_render",
      },
    });

    expect(result).toMatchObject({
      status: "resolved",
      warId: 1001,
      source: "existing_exact_row",
    });
  });

  it("reports allocation, reuse, and preservation accurately in the structured log", async () => {
    const service = new ActiveWarIdentityService();

    installTransactionHarness({
      currentWarRow: {
        warId: null,
        state: "preparation",
        prepStartTime: new Date("2026-03-11T00:00:00.000Z"),
        startTime: new Date("2026-03-12T00:00:00.000Z"),
        endTime: new Date("2026-03-12T01:00:00.000Z"),
        opponentTag: "#OPP123",
        opponentName: "Enemy",
        clanName: "Clan",
      },
      exactGlobalRows: [],
      nextWarId: 2002,
    });
    await service.resolveCurrentWarId({
      policy: "interactive_materialize",
      guildId: "guild-1",
      clanTag: "#AAA111",
      candidateIdentity: {
        state: "preparation",
        warStartTime: "20260312T000000.000Z",
        opponentTag: "#OPP123",
        clanName: "Clan",
      },
      observabilityContext: {
        caller: "fwa_mail_render",
      },
    });
    const allocationPayload = parseActiveWarIdentityLog().at(-1);
    expect(allocationPayload).toEqual(
      expect.objectContaining({
        source: "materialized_missing_id",
        allocationOccurred: true,
        identityPreserved: false,
        persistedWarId: null,
        persistedState: "preparation",
        persistedWarStartTime: "2026-03-12T00:00:00.000Z",
        persistedOpponentTag: "OPP123",
        postPersistedWarId: 2002,
        postPersistedState: "preparation",
        postPersistedWarStartTime: "2026-03-12T00:00:00.000Z",
        postPersistedOpponentTag: "OPP123",
        resolvedWarId: 2002,
      }),
    );

    vi.clearAllMocks();
    telemetryContextMock.getTelemetryContext.mockReturnValue({
      runId: "run-1",
      guildId: "guild-1",
      userId: "user-1",
      commandName: "fwa",
      subcommand: "match",
      interactionId: "interaction-1",
    });
    prismaMock.currentWar.update.mockResolvedValue({});
    installTransactionHarness({
      currentWarRow: {
        warId: null,
        state: "preparation",
        prepStartTime: new Date("2026-03-11T00:00:00.000Z"),
        startTime: new Date("2026-03-12T00:00:00.000Z"),
        endTime: new Date("2026-03-12T01:00:00.000Z"),
        opponentTag: "#OPP123",
        opponentName: "Enemy",
        clanName: "Clan",
      },
      exactGlobalRows: [{ warId: 1001 }],
    });
    await service.resolveCurrentWarId({
      policy: "interactive_materialize",
      guildId: "guild-1",
      clanTag: "#AAA111",
      candidateIdentity: {
        state: "preparation",
        warStartTime: "20260312T000000.000Z",
        opponentTag: "#OPP123",
        clanName: "Clan",
      },
      observabilityContext: {
        caller: "fwa_mail_render",
      },
    });
    const reusePayload = parseActiveWarIdentityLog().at(-1);
    expect(reusePayload).toEqual(
      expect.objectContaining({
        source: "reused_global_exact_identity",
        allocationOccurred: false,
        identityPreserved: false,
        persistedWarId: null,
        persistedState: "preparation",
        persistedWarStartTime: "2026-03-12T00:00:00.000Z",
        persistedOpponentTag: "OPP123",
        postPersistedWarId: 1001,
        postPersistedState: "preparation",
        postPersistedWarStartTime: "2026-03-12T00:00:00.000Z",
        postPersistedOpponentTag: "OPP123",
        resolvedWarId: 1001,
      }),
    );

    vi.clearAllMocks();
    telemetryContextMock.getTelemetryContext.mockReturnValue({
      runId: "run-1",
      guildId: "guild-1",
      userId: "user-1",
      commandName: "fwa",
      subcommand: "match",
      interactionId: "interaction-1",
    });
    installTransactionHarness({
      currentWarRow: {
        warId: 1001,
        state: "preparation",
        prepStartTime: new Date("2026-03-11T00:00:00.000Z"),
        startTime: new Date("2026-03-12T00:00:00.000Z"),
        endTime: new Date("2026-03-12T01:00:00.000Z"),
        opponentTag: "#OPP123",
        opponentName: "Enemy",
        clanName: "Clan",
      },
    });
    await service.resolveCurrentWarId({
      policy: "preserve_persisted",
      guildId: "guild-1",
      clanTag: "#AAA111",
      observabilityContext: {
        caller: "war_event_poll",
      },
    });
    const preservedPayload = parseActiveWarIdentityLog().at(-1);
    expect(preservedPayload).toEqual(
      expect.objectContaining({
        source: "preserved_during_outage_recovery",
        allocationOccurred: false,
        identityPreserved: true,
        persistedWarId: 1001,
        persistedState: "preparation",
        persistedWarStartTime: "2026-03-12T00:00:00.000Z",
        persistedOpponentTag: "OPP123",
        postPersistedWarId: 1001,
        postPersistedState: "preparation",
        postPersistedWarStartTime: "2026-03-12T00:00:00.000Z",
        postPersistedOpponentTag: "OPP123",
        resolvedWarId: 1001,
      }),
    );
  });

  it("keeps the pre-resolution persisted identity when a later step fails", async () => {
    installTransactionHarness({
      currentWarRow: {
        warId: 1001,
        state: "preparation",
        prepStartTime: new Date("2026-03-11T00:00:00.000Z"),
        startTime: new Date("2026-03-12T00:00:00.000Z"),
        endTime: new Date("2026-03-12T01:00:00.000Z"),
        opponentTag: "#OPP123",
        opponentName: "Enemy",
        clanName: "Clan",
      },
    });
    prismaMock.$executeRaw.mockImplementation(async () => {
      throw new Error("SELECT * FROM CurrentWar failed\nstack trace");
    });
    const service = new ActiveWarIdentityService();
    const result = await service.resolveCurrentWarId({
      policy: "poll_reconcile",
      guildId: "guild-1",
      clanTag: "#AAA111",
      candidateIdentity: {
        state: "preparation",
        warStartTime: "20260312T000000.000Z",
        opponentTag: "#OPP123",
        clanName: "Clan",
      },
      observabilityContext: {
        caller: "war_event_poll",
      },
    });

    expect(result).toEqual({
      status: "blocked",
      warId: null,
      reason: "persistence_failure",
    });
    const payload = parseActiveWarIdentityLog().at(-1);
    expect(payload).toEqual(
      expect.objectContaining({
        persistedWarId: 1001,
        persistedState: "preparation",
        persistedWarStartTime: "2026-03-12T00:00:00.000Z",
        persistedOpponentTag: "OPP123",
        reasonCode: "persistence_failure",
      }),
    );
    expect(String(JSON.stringify(payload))).not.toContain("SELECT * FROM CurrentWar");
    expect(String(JSON.stringify(payload))).not.toContain("stack trace");
  });
});
