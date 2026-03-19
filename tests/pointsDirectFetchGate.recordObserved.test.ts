import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PointsDirectFetchGateService,
  type PointsLockStateRecord,
} from "../src/services/PointsDirectFetchGateService";

function buildState(
  overrides?: Partial<PointsLockStateRecord>,
): PointsLockStateRecord {
  return {
    lifecycleState: "post_war_unlocked_waiting_for_point_change",
    clanTag: "#9GLGQCCU",
    guildId: "guild-1",
    warId: "1001383",
    warStartMs: new Date("2026-03-18T22:12:43.000Z").getTime(),
    warEndMs: new Date("2026-03-19T22:39:26.000Z").getTime(),
    matchType: "BL",
    baselinePoints: 6,
    pointValueChangedAtMs: null,
    postedSyncAtMs: new Date("2026-03-18T07:05:00.000Z").getTime(),
    lockUntilMs: null,
    updatedAtMs: new Date("2026-03-19T22:43:00.000Z").getTime(),
    ...overrides,
  };
}

describe("PointsDirectFetchGateService.recordObservedPointValue", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps non-MM post-war wait state unchanged when observed points equal baseline (#9GLGQCCU scenario)", async () => {
    const service = new PointsDirectFetchGateService({} as never);
    let persisted = buildState({ baselinePoints: 6, matchType: "BL" });
    const readSpy = vi
      .spyOn(service as any, "readPersistedState")
      .mockImplementation(async () => persisted);
    const writeSpy = vi
      .spyOn(service as any, "writePersistedState")
      .mockImplementation(async (next: PointsLockStateRecord) => {
        persisted = next;
      });
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);

    await service.recordObservedPointValue({
      clanTag: "#9GLGQCCU",
      observedPoints: 6,
      nowMs: new Date("2026-03-19T22:48:43.000Z").getTime(),
    });

    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy.mock.calls[0]?.[0]).toContain(
      "guard_code=equal_points_blocked",
    );
    expect(persisted.lifecycleState).toBe(
      "post_war_unlocked_waiting_for_point_change",
    );
    expect(persisted.baselinePoints).toBe(6);
  });

  it("transitions non-MM post-war state on changed points and logs pre/post baselines", async () => {
    const service = new PointsDirectFetchGateService({} as never);
    let persisted = buildState({ baselinePoints: 5, matchType: "BL" });
    const writeSpy = vi
      .spyOn(service as any, "writePersistedState")
      .mockImplementation(async (next: PointsLockStateRecord) => {
        persisted = next;
      });
    vi.spyOn(service as any, "readPersistedState").mockImplementation(
      async () => persisted,
    );
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    await service.recordObservedPointValue({
      clanTag: "#9GLGQCCU",
      observedPoints: 6,
      nowMs: new Date("2026-03-19T22:48:43.000Z").getTime(),
    });

    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(persisted.lifecycleState).toBe("unlocked");
    expect(persisted.baselinePoints).toBe(6);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    const line = String(infoSpy.mock.calls[0]?.[0] ?? "");
    expect(line).toContain("from=post_war_unlocked_waiting_for_point_change");
    expect(line).toContain("to=unlocked");
    expect(line).toContain("baseline_before=5");
    expect(line).toContain("baseline_after=6");
    expect(line).toContain("equality_guard=allowed");
    expect(line).toContain("guard_code=point_change_allowed");
  });

  it("does not unlock MM post-war wait state when observed points change", async () => {
    const service = new PointsDirectFetchGateService({} as never);
    let persisted = buildState({ baselinePoints: 6, matchType: "MM" });
    const writeSpy = vi
      .spyOn(service as any, "writePersistedState")
      .mockImplementation(async (next: PointsLockStateRecord) => {
        persisted = next;
      });
    vi.spyOn(service as any, "readPersistedState").mockImplementation(
      async () => persisted,
    );
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    await service.recordObservedPointValue({
      clanTag: "#9GLGQCCU",
      observedPoints: 7,
      nowMs: new Date("2026-03-19T22:48:43.000Z").getTime(),
    });

    expect(writeSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(persisted.lifecycleState).toBe(
      "post_war_unlocked_waiting_for_point_change",
    );
    expect(persisted.baselinePoints).toBe(6);
  });

  it("serializes repeated reconciliation updates for the same clan and avoids duplicate transitions", async () => {
    const service = new PointsDirectFetchGateService({} as never);
    let persisted = buildState({ baselinePoints: 5, matchType: "BL" });
    const writeSpy = vi
      .spyOn(service as any, "writePersistedState")
      .mockImplementation(async (next: PointsLockStateRecord) => {
        persisted = next;
      });
    vi.spyOn(service as any, "readPersistedState").mockImplementation(
      async () => persisted,
    );
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    await Promise.all([
      service.recordObservedPointValue({
        clanTag: "#9GLGQCCU",
        observedPoints: 6,
        nowMs: new Date("2026-03-19T22:48:43.100Z").getTime(),
      }),
      service.recordObservedPointValue({
        clanTag: "#9GLGQCCU",
        observedPoints: 6,
        nowMs: new Date("2026-03-19T22:48:43.200Z").getTime(),
      }),
    ]);

    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(persisted.lifecycleState).toBe("unlocked");
    expect(persisted.baselinePoints).toBe(6);
  });
});

