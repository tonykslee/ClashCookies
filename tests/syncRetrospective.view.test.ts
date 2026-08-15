import { describe, expect, it } from "vitest";
import type { SyncRetrospectiveResult } from "../src/services/SyncRetrospectiveService";
import { buildSyncRetrospectiveEmbeds } from "../src/services/SyncRetrospectiveViewService";

function result(overrides: Partial<SyncRetrospectiveResult> = {}): SyncRetrospectiveResult {
  return {
    identity: {
      guildId: "guild-1",
      syncNumber: 545,
      syncTime: new Date("2026-08-15T11:00:00.000Z"),
      cycleMapped: true,
    },
    warSummary: {
      clanWarCount: 9,
      totalStarsKnown: 947,
      starsCoverage: { known: 9, total: 9 },
    },
    missedAttacks: {
      missedAttacksKnownTotal: 4,
      coverage: { completeClans: 8, warClans: 9 },
    },
    fwaViolations: {
      violationKnownTotal: 2,
      coverage: { completedFwaEvaluations: 8, fwaWars: 9 },
    },
    readiness: {
      averageDeviation: 3.7,
      deviationCoverage: { valid: 9, totalSnapshots: 9 },
    },
    fillers: {
      fillerKnownTotal: 7,
      fillerCoverage: { complete: 9, totalSnapshots: 9 },
    },
    clans: [],
    ...overrides,
  };
}

function clan(overrides: Record<string, unknown> = {}) {
  return {
    identity: {
      clanTag: "#2QG2C08UP",
      clanName: "Rising Dawn",
      warId: 545,
      matchType: "FWA",
      expectedOutcome: "WIN",
      actualOutcome: "WIN",
      ...((overrides.identity ?? {}) as Record<string, unknown>),
    },
    war: { stars: 108, ...((overrides.war ?? {}) as Record<string, unknown>) },
    missedAttacks: {
      total: 0,
      coverageComplete: true,
      players: [],
      ...((overrides.missedAttacks ?? {}) as Record<string, unknown>),
    },
    violations: {
      total: 0,
      evaluationComplete: true,
      applicable: true,
      details: [],
      ...((overrides.violations ?? {}) as Record<string, unknown>),
    },
    readiness: {
      memberCount: 50,
      deviationScore: 0,
      projectionComplete: true,
      dataAvailable: true,
      ...((overrides.readiness ?? {}) as Record<string, unknown>),
    },
    fillers: {
      fillerCount: 1,
      fillerPlayerTags: ["#PLAYER1"],
      fillerCaptureComplete: true,
      ...((overrides.fillers ?? {}) as Record<string, unknown>),
    },
  } as SyncRetrospectiveResult["clans"][number];
}

describe("SyncRetrospectiveViewService", () => {
  it("renders known zeros, unknowns, and coverage without collapsing them", () => {
    const embeds = buildSyncRetrospectiveEmbeds(result({
      missedAttacks: { missedAttacksKnownTotal: 0, coverage: { completeClans: 9, warClans: 9 } },
      fwaViolations: { violationKnownTotal: 0, coverage: { completedFwaEvaluations: 9, fwaWars: 9 } },
      readiness: { averageDeviation: 0, deviationCoverage: { valid: 9, totalSnapshots: 9 } },
      fillers: { fillerKnownTotal: 0, fillerCoverage: { complete: 9, totalSnapshots: 9 } },
    }));
    const fields = embeds[0].toJSON().fields ?? [];
    const values = new Map(fields.map((field) => [field.name, field.value]));

    expect(values.get("Stars")).toBe("947 ★ · 9/9 clans");
    expect(values.get("Missed attacks")).toBe("0 · 9/9 complete");
    expect(values.get("FWA violations")).toBe("0 · 9/9 finalized");
    expect(values.get("Average deviation")).toBe("0 · 9/9 captured");
    expect(values.get("Fillers")).toBe("0 · 9/9 captured");

    const unknownFields = buildSyncRetrospectiveEmbeds(result({
      warSummary: { clanWarCount: 9, totalStarsKnown: null, starsCoverage: { known: 0, total: 9 } },
      missedAttacks: { missedAttacksKnownTotal: null, coverage: { completeClans: 0, warClans: 9 } },
      fwaViolations: { violationKnownTotal: null, coverage: { completedFwaEvaluations: 0, fwaWars: 0 } },
      readiness: { averageDeviation: null, deviationCoverage: { valid: 0, totalSnapshots: 9 } },
      fillers: { fillerKnownTotal: null, fillerCoverage: { complete: 0, totalSnapshots: 9 } },
    }))[0].toJSON().fields ?? [];
    const unknownValues = new Map(unknownFields.map((field) => [field.name, field.value]));
    expect(unknownValues.get("Stars")).toBe("— · 0/9 clans");
    expect(unknownValues.get("Missed attacks")).toBe("— · 0/9 complete");
    expect(unknownValues.get("FWA violations")).toBe("N/A · no FWA wars");
    expect(unknownValues.get("Average deviation")).toBe("— · 0/9 captured");
    expect(unknownValues.get("Fillers")).toBe("— · 0/9 captured");
  });

  it("orders war rows before snapshot-only rows and renders applicability", () => {
    const embeds = buildSyncRetrospectiveEmbeds(result({
      clans: [
        clan({ identity: { clanTag: "#SNAP", clanName: "A Snapshot", warId: null }, violations: { total: null, evaluationComplete: false, applicable: false }, readiness: { deviationScore: null }, fillers: { fillerCount: null, fillerCaptureComplete: false } }),
        clan({ identity: { clanTag: "#WAR2", clanName: "Z War" }, violations: { total: null, evaluationComplete: false, applicable: false } }),
        clan({ identity: { clanTag: "#WAR1", clanName: "A War" }, violations: { total: 0, evaluationComplete: true, applicable: false } }),
      ],
    }));
    const clanFieldText = (embeds[0].toJSON().fields ?? [])
      .filter((field) => field.name.startsWith("Clans"))
      .map((field) => field.value)
      .join("\n");

    expect(clanFieldText.indexOf("A War")).toBeLessThan(clanFieldText.indexOf("Z War"));
    expect(clanFieldText.indexOf("Z War")).toBeLessThan(clanFieldText.indexOf("A Snapshot"));
    expect(clanFieldText).toContain("N/A viol");
    expect(clanFieldText).toContain("— viol");
  });

  it("chunks long alliance lists within Discord field limits", () => {
    const clans = Array.from({ length: 100 }, (_, index) => clan({
      identity: { clanTag: `#TAG${String(index).padStart(4, "0")}`, clanName: `Clan ${String(index).padStart(3, "0")}` },
    }));
    const embeds = buildSyncRetrospectiveEmbeds(result({ clans }));
    const clanFields = embeds.flatMap((embed) => (embed.toJSON().fields ?? []))
      .filter((field) => field.name.startsWith("Clans"));

    expect(embeds.length).toBeGreaterThan(1);
    expect(clanFields.length).toBeGreaterThan(1);
    expect(clanFields.every((field) => field.value.length <= 1024)).toBe(true);
    expect(clanFields.map((field) => field.value).join("\n")).toContain("Clan 099");
  });
});
