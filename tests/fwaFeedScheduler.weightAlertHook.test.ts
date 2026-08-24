import { describe, expect, it, vi } from "vitest";
import { FwaFeedSchedulerService } from "../src/services/fwa-feeds/FwaFeedSchedulerService";

async function runSchedulerOnce(status: "SUCCESS" | "NOOP" | "SKIPPED", hook: ReturnType<typeof vi.fn>) {
  const scheduler = new FwaFeedSchedulerService({ onFreshClansCatalogSync: hook });
  const privateScheduler = scheduler as any;
  privateScheduler.clansSync.syncGlobalCatalog = vi.fn(async () => ({
    status,
    rowCount: 3,
    changedRowCount: status === "SUCCESS" ? 1 : 0,
    contentHash: "hash",
  }));
  privateScheduler.syncState.recordFailure = vi.fn();
  await scheduler.runClansJob();
  return privateScheduler;
}

describe("FwaFeedSchedulerService weight-alert hook", () => {
  it("evaluates after SUCCESS and NOOP, but not SKIPPED", async () => {
    const successHook = vi.fn();
    await runSchedulerOnce("SUCCESS", successHook);
    expect(successHook).toHaveBeenCalledWith({
      now: expect.any(Date),
      status: "SUCCESS",
      rowCount: 3,
      changedRowCount: 1,
    });

    const noopHook = vi.fn();
    await runSchedulerOnce("NOOP", noopHook);
    expect(noopHook).toHaveBeenCalledWith({
      now: expect.any(Date),
      status: "NOOP",
      rowCount: 3,
      changedRowCount: 0,
    });

    const skippedHook = vi.fn();
    await runSchedulerOnce("SKIPPED", skippedHook);
    expect(skippedHook).not.toHaveBeenCalled();
  });

  it("isolates evaluator failures from feed scheduler success", async () => {
    const hook = vi.fn(async () => {
      throw new Error("delivery unavailable");
    });
    const scheduler = await runSchedulerOnce("SUCCESS", hook);

    expect(hook).toHaveBeenCalledTimes(1);
    expect(scheduler.syncState.recordFailure).not.toHaveBeenCalled();
  });
});

