import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { botStartupStatusService } from "../src/services/BotStartupStatusService";

describe("BotStartupStatusService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-19T12:00:00.000Z"));
    botStartupStatusService.markPhase("ready_start", { boot: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("updates the phase and snapshot timestamps", () => {
    const snapshot = botStartupStatusService.markPhase("autorole_scheduler", {
      stage: "autorole_scheduler",
    });

    expect(snapshot.status).toBe("starting");
    expect(snapshot.phase).toBe("autorole_scheduler");
    expect(snapshot.startedAt).toEqual(new Date("2026-05-19T12:00:00.000Z"));
    expect(snapshot.updatedAt).toEqual(new Date("2026-05-19T12:00:00.000Z"));
    expect(snapshot.completedAt).toBeNull();
    expect(snapshot.metadata).toEqual({ stage: "autorole_scheduler" });
  });

  it("marks completion and completion time", () => {
    const snapshot = botStartupStatusService.markComplete({ pollingMode: "active" });

    expect(snapshot.status).toBe("online");
    expect(snapshot.phase).toBe("complete");
    expect(snapshot.completedAt).toEqual(new Date("2026-05-19T12:00:00.000Z"));
    expect(snapshot.updatedAt).toEqual(new Date("2026-05-19T12:00:00.000Z"));
    expect(snapshot.metadata).toEqual({ pollingMode: "active" });
  });

  it("stores a truncated failure message", () => {
    const snapshot = botStartupStatusService.markFailed(
      new Error("x".repeat(2000)),
      { phase: "war_event_poll" },
    );

    expect(snapshot.status).toBe("failed");
    expect(snapshot.phase).toBe("failed");
    expect(snapshot.lastError).toContain("...truncated");
    expect(snapshot.completedAt).toEqual(new Date("2026-05-19T12:00:00.000Z"));
    expect(snapshot.metadata).toEqual({ phase: "war_event_poll" });
  });
});
