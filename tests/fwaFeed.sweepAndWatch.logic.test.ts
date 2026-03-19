import { describe, expect, it } from "vitest";
import { selectDistributedSweepChunkForTest as selectWarMembersChunk } from "../src/services/fwa-feeds/FwaWarMembersSyncService";
import { selectDistributedSweepChunkForTest as selectClanWarsChunk } from "../src/services/fwa-feeds/FwaClanWarsSyncService";
import {
  buildWatchWindowForTest,
  computeNextDailySyncTimeForTest,
} from "../src/services/fwa-feeds/FwaClanWarsWatchService";

describe("fwa feed sweep chunking", () => {
  it("advances from cursor and wraps around deterministically", () => {
    const tags = ["#A", "#B", "#C", "#D"];
    expect(selectWarMembersChunk(tags, "#B", 2)).toEqual(["#C", "#D"]);
    expect(selectWarMembersChunk(tags, "#D", 2)).toEqual(["#A", "#B"]);
    expect(selectClanWarsChunk(tags, null, 3)).toEqual(["#A", "#B", "#C"]);
  });
});

describe("tracked clan wars watch timing", () => {
  it("computes next daily sync time in the future", () => {
    const base = Date.parse("2026-03-19T12:00:00.000Z");
    const nowBefore = Date.parse("2026-03-19T11:59:00.000Z");
    const nowAfter = Date.parse("2026-03-19T12:01:00.000Z");

    expect(computeNextDailySyncTimeForTest(base, nowBefore)).toBe(base);
    expect(computeNextDailySyncTimeForTest(base, nowAfter)).toBe(base + 24 * 60 * 60 * 1000);
  });

  it("starts watch window five minutes before next sync", () => {
    const nextSyncMs = Date.parse("2026-03-19T12:00:00.000Z");
    const window = buildWatchWindowForTest(nextSyncMs);
    expect(window.nextSyncTimeAt.toISOString()).toBe("2026-03-19T12:00:00.000Z");
    expect(window.pollWindowStartAt.toISOString()).toBe("2026-03-19T11:55:00.000Z");
  });
});
