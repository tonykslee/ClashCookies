import { describe, expect, it } from "vitest";
import {
  selectWarScopedReuseRow,
  type WarScopedSyncReuseRow,
} from "../src/commands/fwa/warScopedReuse";

function buildRow(overrides?: Partial<WarScopedSyncReuseRow>): WarScopedSyncReuseRow {
  return {
    warId: "1234",
    warStartTime: new Date("2026-03-08T00:00:00.000Z"),
    syncNum: 42,
    opponentTag: "#ABC123",
    clanPoints: 1111,
    opponentPoints: 999,
    isFwa: true,
    needsValidation: false,
    lastSuccessfulPointsApiFetchAt: new Date("2026-03-08T01:00:00.000Z"),
    syncFetchedAt: new Date("2026-03-08T01:00:00.000Z"),
    ...overrides,
  };
}

describe("war scoped points reuse selection", () => {
  it("selects lock row when war identity, opponent, and sync align", () => {
    const row = buildRow();
    const selected = selectWarScopedReuseRow({
      rows: [row],
      warId: "1234",
      warStartTime: row.warStartTime,
      opponentTag: "abc123",
      currentSyncNumber: 42,
      sourceSyncNumber: 41,
    });

    expect(selected).not.toBeNull();
    expect(selected?.syncNum).toBe(42);
    expect(selected?.clanPoints).toBe(1111);
  });

  it("reuses by sync progression when current sync is unknown but row sync is newer than source", () => {
    const selected = selectWarScopedReuseRow({
      rows: [buildRow({ syncNum: 19 })],
      warId: "1234",
      warStartTime: new Date("2026-03-08T00:00:00.000Z"),
      opponentTag: "#ABC123",
      currentSyncNumber: null,
      sourceSyncNumber: 18,
    });

    expect(selected).not.toBeNull();
    expect(selected?.syncNum).toBe(19);
  });

  it("does not reuse when lifecycle requires validation", () => {
    const selected = selectWarScopedReuseRow({
      rows: [buildRow({ needsValidation: true })],
      warId: "1234",
      warStartTime: new Date("2026-03-08T00:00:00.000Z"),
      opponentTag: "#ABC123",
      currentSyncNumber: 42,
      sourceSyncNumber: 41,
    });

    expect(selected).toBeNull();
  });

  it("does not reuse when war identity changes", () => {
    const selected = selectWarScopedReuseRow({
      rows: [
        buildRow({
          warId: "2222",
          warStartTime: new Date("2026-03-06T00:00:00.000Z"),
        }),
      ],
      warId: "1234",
      warStartTime: new Date("2026-03-08T00:00:00.000Z"),
      opponentTag: "#ABC123",
      currentSyncNumber: 42,
      sourceSyncNumber: 41,
    });

    expect(selected).toBeNull();
  });

  it("prefers warStartTime over a matching stale warId when both are available", () => {
    const currentStartTime = new Date("2026-03-08T00:00:00.000Z");
    const selected = selectWarScopedReuseRow({
      rows: [
        buildRow({
          warId: "1234",
          warStartTime: new Date("2026-03-06T00:00:00.000Z"),
        }),
        buildRow({
          warId: "1234",
          warStartTime: currentStartTime,
        }),
      ],
      warId: "1234",
      warStartTime: currentStartTime,
      opponentTag: "#ABC123",
      currentSyncNumber: 42,
      sourceSyncNumber: 41,
    });

    expect(selected).not.toBeNull();
    expect(selected?.warStartTime.toISOString()).toBe(
      currentStartTime.toISOString(),
    );
  });

  it("does not reuse when opponent alignment differs", () => {
    const selected = selectWarScopedReuseRow({
      rows: [buildRow({ opponentTag: "#ZZZ999" })],
      warId: "1234",
      warStartTime: new Date("2026-03-08T00:00:00.000Z"),
      opponentTag: "#ABC123",
      currentSyncNumber: 42,
      sourceSyncNumber: 41,
    });

    expect(selected).toBeNull();
  });

  it("does not reuse when sync is stale for the source sync context", () => {
    const selected = selectWarScopedReuseRow({
      rows: [buildRow({ syncNum: 17 })],
      warId: "1234",
      warStartTime: new Date("2026-03-08T00:00:00.000Z"),
      opponentTag: "#ABC123",
      currentSyncNumber: null,
      sourceSyncNumber: 17,
    });

    expect(selected).toBeNull();
  });

  it("does not reuse when sync context is unavailable", () => {
    const selected = selectWarScopedReuseRow({
      rows: [buildRow()],
      warId: "1234",
      warStartTime: new Date("2026-03-08T00:00:00.000Z"),
      opponentTag: "#ABC123",
      currentSyncNumber: null,
      sourceSyncNumber: null,
    });

    expect(selected).toBeNull();
  });
});
