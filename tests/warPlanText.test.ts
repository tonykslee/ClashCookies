import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/prisma";
import { WarEventHistoryService } from "../src/services/war-events/history";

describe("WarEventHistoryService.buildWarPlanText", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns WIN plan with header and expected instructions", async () => {
    const svc = new WarEventHistoryService({} as never);
    const out = await svc.buildWarPlanText(
      "FWA",
      "WIN",
      "ABC123",
      "OPPONENT_NAME",
      undefined,
      "battle",
      "CLAN_NAME"
    );
    expect(out).toBeTruthy();
    const lines = String(out).split("\n");
    expect(lines[0]).toContain("# ");
    expect(lines[0]).toContain("CLAN_NAME vs OPPONENT_NAME");
    expect(out).toContain("1st Attack");
    expect(out).toContain("2nd Attack");
    expect(out).toContain("Only after 101+ stars");
  });

  it("returns LOSE TRIPLE_TOP_30 plan with header and expected instructions", async () => {
    const svc = new WarEventHistoryService({} as never);
    (svc as any).getLoseStyleForClan = vi.fn().mockResolvedValue("TRIPLE_TOP_30");
    const out = await svc.buildWarPlanText(
      "FWA",
      "LOSE",
      "ABC123",
      "OPPONENT_NAME",
      undefined,
      "battle",
      "CLAN_NAME"
    );
    expect(out).toBeTruthy();
    const lines = String(out).split("\n");
    expect(lines[0]).toContain("# ");
    expect(lines[0]).toContain("CLAN_NAME vs OPPONENT_NAME");
    expect(out).toContain("top 30");
    expect(out).toContain("Do NOT attack the bottom 20 bases");
    expect(out).toContain("Goal is 90 stars");
  });

  it("returns LOSE TRADITIONAL plan with header and expected instructions", async () => {
    const svc = new WarEventHistoryService({} as never);
    (svc as any).getLoseStyleForClan = vi.fn().mockResolvedValue("TRADITIONAL");
    const out = await svc.buildWarPlanText(
      "FWA",
      "LOSE",
      "ABC123",
      "OPPONENT_NAME",
      undefined,
      "battle",
      "CLAN_NAME"
    );
    expect(out).toBeTruthy();
    const lines = String(out).split("\n");
    expect(lines[0]).toContain("# ");
    expect(lines[0]).toContain("CLAN_NAME vs OPPONENT_NAME");
    expect(out).toContain("1st Attack");
    expect(out).toContain("2nd Attack");
    expect(out).toContain("Last 12hrs");
    expect(out).toContain("Do NOT surpass 100");
  });

  it("resolves lose style when tracked clan tag is stored without #", async () => {
    const svc = new WarEventHistoryService({} as never);
    vi.spyOn(prisma.trackedClan, "findFirst").mockImplementation(async (args: any) => {
      const candidates = (args?.where?.OR ?? [])
        .map((entry: any) => String(entry?.tag?.equals ?? "").toUpperCase())
        .filter(Boolean);
      if (candidates.includes("29PCQGUV0")) {
        return { loseStyle: "TRADITIONAL" } as any;
      }
      return null as any;
    });

    const out = await svc.buildWarPlanText(
      "FWA",
      "LOSE",
      "29PCQGUV0",
      "OPPONENT_NAME",
      undefined,
      "battle",
      "CLAN_NAME"
    );

    expect(out).toContain("Last 12hrs");
    expect(out).toContain("Do NOT surpass 100");
    expect(out).not.toContain("top 30");
  });

  it("returns BL default with header format in first line", async () => {
    const svc = new WarEventHistoryService({} as never);
    const out = await svc.buildWarPlanText(
      "BL",
      null,
      "ABC123",
      "OPPONENT_NAME",
      undefined,
      "battle",
      "CLAN_NAME"
    );

    expect(out).toBeTruthy();
    const firstLine = String(out).split("\n")[0] ?? "";
    expect(firstLine).toContain("# ");
    expect(firstLine).toContain("CLAN_NAME vs OPPONENT_NAME");
  });

  it("returns MM default with header format in first line", async () => {
    const svc = new WarEventHistoryService({} as never);
    const out = await svc.buildWarPlanText(
      "MM",
      null,
      "ABC123",
      "OPPONENT_NAME",
      undefined,
      "battle",
      "CLAN_NAME"
    );

    expect(out).toBeTruthy();
    const firstLine = String(out).split("\n")[0] ?? "";
    expect(firstLine).toContain("# ");
    expect(firstLine).toContain("CLAN_NAME vs OPPONENT_NAME");
  });

  it("prefers clan custom plan text for guild-scoped lookups", async () => {
    const svc = new WarEventHistoryService({} as never);
    const planSpy = vi.spyOn(prisma.clanWarPlan, "findFirst");
    planSpy.mockResolvedValueOnce({ planText: "MM custom plan {clan} vs {opponent}" } as any);

    const out = await svc.buildWarPlanText(
      "123456789012345678",
      "MM",
      null,
      "ABC123",
      "OPPONENT_NAME"
    );

    expect(out).toBe("MM custom plan #ABC123 vs OPPONENT_NAME");
    expect(planSpy).toHaveBeenCalledTimes(1);
    expect(planSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          guildId: "123456789012345678",
          scope: "CUSTOM",
          matchType: "MM",
          outcome: "ANY",
        }),
      })
    );
  });

  it("falls back to editable guild default when clan custom is missing", async () => {
    const svc = new WarEventHistoryService({} as never);
    const planSpy = vi.spyOn(prisma.clanWarPlan, "findFirst");
    planSpy
      .mockResolvedValueOnce(null as any)
      .mockResolvedValueOnce({ planText: "BL default plan {clan} vs {opponent}" } as any);

    const out = await svc.buildWarPlanText(
      "123456789012345678",
      "BL",
      null,
      "ABC123",
      "OPPONENT_NAME"
    );

    expect(out).toBe("BL default plan #ABC123 vs OPPONENT_NAME");
    expect(planSpy).toHaveBeenCalledTimes(2);
    expect(planSpy.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        where: expect.objectContaining({
          guildId: "123456789012345678",
          scope: "DEFAULT",
          matchType: "BL",
          outcome: "ANY",
        }),
      })
    );
  });

  it("uses forced traditional lose style for editable default lookup", async () => {
    const svc = new WarEventHistoryService({} as never);
    const planSpy = vi.spyOn(prisma.clanWarPlan, "findFirst");
    planSpy
      .mockResolvedValueOnce(null as any)
      .mockResolvedValueOnce({ planText: "Traditional default {clan} vs {opponent}" } as any);

    const out = await svc.buildWarPlanText(
      "123456789012345678",
      "FWA",
      "LOSE",
      "",
      "OPPONENT_NAME",
      "battle",
      "CLAN_NAME",
      { forcedLoseStyle: "TRADITIONAL" }
    );

    expect(out).toBe("Traditional default CLAN_NAME vs OPPONENT_NAME");
    expect(planSpy).toHaveBeenCalledTimes(2);
    expect(planSpy.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        where: expect.objectContaining({
          guildId: "123456789012345678",
          scope: "DEFAULT",
          matchType: "FWA",
          outcome: "LOSE",
          loseStyle: { in: ["TRADITIONAL", "ANY"] },
        }),
      })
    );
  });

  it("uses forced triple-top-30 lose style for editable default lookup", async () => {
    const svc = new WarEventHistoryService({} as never);
    const planSpy = vi.spyOn(prisma.clanWarPlan, "findFirst");
    planSpy
      .mockResolvedValueOnce(null as any)
      .mockResolvedValueOnce({ planText: "Triple default {clan} vs {opponent}" } as any);

    const out = await svc.buildWarPlanText(
      "123456789012345678",
      "FWA",
      "LOSE",
      "",
      "OPPONENT_NAME",
      "battle",
      "CLAN_NAME",
      { forcedLoseStyle: "TRIPLE_TOP_30" }
    );

    expect(out).toBe("Triple default CLAN_NAME vs OPPONENT_NAME");
    expect(planSpy).toHaveBeenCalledTimes(2);
    expect(planSpy.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        where: expect.objectContaining({
          guildId: "123456789012345678",
          scope: "DEFAULT",
          matchType: "FWA",
          outcome: "LOSE",
          loseStyle: { in: ["TRIPLE_TOP_30", "ANY"] },
        }),
      })
    );
  });

  it("uses forced traditional lose style for built-in fallback when no db plan exists", async () => {
    const svc = new WarEventHistoryService({} as never);
    const planSpy = vi.spyOn(prisma.clanWarPlan, "findFirst");
    planSpy.mockResolvedValueOnce(null as any).mockResolvedValueOnce(null as any);

    const out = await svc.buildWarPlanText(
      "123456789012345678",
      "FWA",
      "LOSE",
      "",
      "OPPONENT_NAME",
      "battle",
      "CLAN_NAME",
      { forcedLoseStyle: "TRADITIONAL" }
    );

    expect(out).toContain("Last 12hrs");
    expect(out).toContain("Do NOT surpass 100");
  });

  it("uses forced triple-top-30 lose style for built-in fallback when no db plan exists", async () => {
    const svc = new WarEventHistoryService({} as never);
    const planSpy = vi.spyOn(prisma.clanWarPlan, "findFirst");
    planSpy.mockResolvedValueOnce(null as any).mockResolvedValueOnce(null as any);

    const out = await svc.buildWarPlanText(
      "123456789012345678",
      "FWA",
      "LOSE",
      "",
      "OPPONENT_NAME",
      "battle",
      "CLAN_NAME",
      { forcedLoseStyle: "TRIPLE_TOP_30" }
    );

    expect(out).toContain("top 30");
    expect(out).toContain("Do NOT attack the bottom 20 bases");
  });
});
