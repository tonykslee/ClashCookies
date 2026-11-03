import { describe, expect, it } from "vitest";
import { CompoRefreshGuard } from "../src/services/CompoRefreshGuard";

describe("CompoRefreshGuard", () => {
  it("serializes concurrent refreshes and keeps the mode cooldown after completion", () => {
    let now = 1_000;
    const guard = new CompoRefreshGuard({ clock: () => now });

    const first = guard.tryStart("actual");
    const concurrent = guard.tryStart("actual");

    expect(first).toMatchObject({
      accepted: true,
      mode: "actual",
      startedAt: 1_000,
      availableAt: 301_000,
    });
    expect(concurrent).toMatchObject({
      accepted: false,
      reason: "busy",
      availableAt: 301_000,
    });

    guard.finish("actual");
    expect(guard.tryStart("actual")).toMatchObject({
      accepted: false,
      reason: "cooldown",
      availableAt: 301_000,
    });
    expect(guard.tryStart("war")).toMatchObject({ accepted: true, mode: "war" });

    now = 301_000;
    expect(guard.tryStart("actual")).toMatchObject({ accepted: true, mode: "actual" });
  });

  it("starts cooldown before a failed caller can retry", () => {
    let now = 10_000;
    const guard = new CompoRefreshGuard({ clock: () => now });

    expect(guard.tryStart("war").accepted).toBe(true);
    guard.finish("war");
    now += 5 * 60 * 1000 - 1;

    expect(guard.tryStart("war")).toMatchObject({
      accepted: false,
      reason: "cooldown",
      availableAt: 310_000,
    });
  });
});
