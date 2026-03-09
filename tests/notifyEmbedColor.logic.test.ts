import { describe, expect, it } from "vitest";
import { resolveNotifyEventEmbedColor } from "../src/services/WarEventLogService";

describe("notify embed color regression", () => {
  it("keeps notify war_started color unchanged", () => {
    expect(resolveNotifyEventEmbedColor("war_started")).toBe(0x3498db);
  });

  it("keeps notify battle_day color unchanged", () => {
    expect(resolveNotifyEventEmbedColor("battle_day")).toBe(0xf1c40f);
  });

  it("keeps notify war_ended color unchanged", () => {
    expect(resolveNotifyEventEmbedColor("war_ended")).toBe(0x2ecc71);
  });
});
