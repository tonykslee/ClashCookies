import { beforeEach, describe, expect, it, vi } from "vitest";
import { FwaClanMatchStatsCurrentSyncService } from "../src/services/fwa-feeds/FwaClanMatchStatsCurrentSyncService";
import { FwaClanWarsSyncService } from "../src/services/fwa-feeds/FwaClanWarsSyncService";
import { FwaFeedOpsService } from "../src/services/fwa-feeds/FwaFeedOpsService";

describe("FwaFeedOpsService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rebuilds clan-match stats after a direct clan-wars sync changes source rows", async () => {
    const syncSpy = vi
      .spyOn(FwaClanWarsSyncService.prototype, "syncClan")
      .mockResolvedValue({
        rowCount: 2,
        changedRowCount: 2,
        contentHash: "abc123",
        status: "SUCCESS",
      });
    const rebuildSpy = vi
      .spyOn(FwaClanMatchStatsCurrentSyncService.prototype, "rebuildCurrentStats")
      .mockResolvedValue({ clanCount: 1, sourceRowCount: 2, evaluatedWarCount: 2 } as any);

    const ops = new FwaFeedOpsService();
    const result = await ops.runTracked("clan-wars", "#aaa111");

    expect(syncSpy).toHaveBeenCalledWith("#AAA111", { force: true });
    expect(rebuildSpy).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      rowCount: 2,
      changedRowCount: 2,
      contentHash: "abc123",
      status: "SUCCESS",
    });
  });
});
