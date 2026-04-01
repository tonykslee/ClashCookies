import { describe, expect, it, vi } from "vitest";
import { PollCycleGuardService } from "../src/services/PollCycleGuardService";

describe("PollCycleGuardService", () => {
  it("skips overlapping executions for the same job key", async () => {
    const logger = { warn: vi.fn() };
    const guard = new PollCycleGuardService(logger);

    let releaseFirst: (() => void) | null = null;
    const firstRun = guard.run("war_event_poll_cycle", async () => {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      return "first";
    });
    await Promise.resolve();

    const secondRun = await guard.run("war_event_poll_cycle", async () => "second");
    expect(secondRun).toEqual({ ran: false });
    expect(guard.isRunning("war_event_poll_cycle")).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      "[poll-cycle] event=overlap_skipped job=war_event_poll_cycle",
    );

    releaseFirst?.();
    await expect(firstRun).resolves.toEqual({ ran: true, value: "first" });
    expect(guard.isRunning("war_event_poll_cycle")).toBe(false);

    await expect(
      guard.run("war_event_poll_cycle", async () => "third"),
    ).resolves.toEqual({ ran: true, value: "third" });
  });
});

