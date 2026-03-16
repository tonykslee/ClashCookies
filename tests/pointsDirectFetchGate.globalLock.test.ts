import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  trackedClan: {
    findUnique: vi.fn(),
  },
  currentWar: {
    findFirst: vi.fn(),
  },
  clanPointsSync: {
    findFirst: vi.fn(),
  },
  warMailLifecycle: {
    findUnique: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import { PointsDirectFetchGateService } from "../src/services/PointsDirectFetchGateService";

function makeSettings() {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function mockCurrentWarQueries(input: { runtimeRow: any; hasGlobalActiveWar: boolean }) {
  prismaMock.currentWar.findFirst.mockImplementation(async (args: any) => {
    if (args?.where?.clanTag) {
      return input.runtimeRow;
    }
    if (Array.isArray(args?.where?.state?.in)) {
      return input.hasGlobalActiveWar ? { clanTag: "#AAA111" } : null;
    }
    return null;
  });
}

describe("PointsDirectFetchGateService global active-war lock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.trackedClan.findUnique.mockResolvedValue(null);
    prismaMock.clanPointsSync.findFirst.mockResolvedValue(null);
    prismaMock.warMailLifecycle.findUnique.mockResolvedValue(null);
    mockCurrentWarQueries({ runtimeRow: null, hasGlobalActiveWar: false });
  });

  it("blocks poller direct fetches under global active-war lock", async () => {
    mockCurrentWarQueries({ runtimeRow: null, hasGlobalActiveWar: true });
    const service = new PointsDirectFetchGateService(makeSettings());

    const decision = await service.evaluateFetchAccess({
      clanTag: "#2YJJY88YG",
      fetchReason: "post_war_reconciliation",
      caller: "poller",
    });

    expect(decision.allowed).toBe(false);
    expect(decision.outcome).toBe("blocked");
    expect(decision.decisionCode).toBe("global_active_war_lock");
  });

  it("blocks service direct fetches under global active-war lock", async () => {
    mockCurrentWarQueries({ runtimeRow: null, hasGlobalActiveWar: true });
    const service = new PointsDirectFetchGateService(makeSettings());

    const decision = await service.evaluateFetchAccess({
      clanTag: "#VVJCY9J",
      fetchReason: "post_war_reconciliation",
      caller: "service",
    });

    expect(decision.allowed).toBe(false);
    expect(decision.decisionCode).toBe("global_active_war_lock");
  });

  it("does not apply global lock to command caller", async () => {
    mockCurrentWarQueries({ runtimeRow: null, hasGlobalActiveWar: true });
    const service = new PointsDirectFetchGateService(makeSettings());

    const decision = await service.evaluateFetchAccess({
      clanTag: "#VVJCY9J",
      fetchReason: "post_war_reconciliation",
      caller: "command",
    });

    expect(decision.allowed).toBe(true);
    expect(decision.decisionCode).toBe("not_tracked");
  });

  it("keeps manual force bypass allowed for poller caller", async () => {
    mockCurrentWarQueries({ runtimeRow: null, hasGlobalActiveWar: true });
    const service = new PointsDirectFetchGateService(makeSettings());

    const decision = await service.evaluateFetchAccess({
      clanTag: "#VVJCY9J",
      fetchReason: "manual_refresh",
      caller: "poller",
      manualForceBypass: true,
    });

    expect(decision.allowed).toBe(true);
    expect(decision.decisionCode).toBe("manual_force_bypass");
  });
});

