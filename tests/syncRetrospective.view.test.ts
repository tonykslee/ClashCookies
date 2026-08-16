import { describe, expect, it } from "vitest";
import type { SyncRetrospectiveResult } from "../src/services/SyncRetrospectiveService";
import {
  buildSyncRetrospectiveClanDetailEmbeds,
  buildSyncRetrospectiveComponents,
  buildSyncRetrospectiveEmbeds,
  sortSyncRetrospectiveClans,
} from "../src/services/SyncRetrospectiveViewService";

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

  it("builds one single-select menu for ten clans and keeps canonical ordering", () => {
    const clans = [
      clan({ identity: { clanTag: "#SNAP", clanName: "A Snapshot", warId: null } }),
      clan({ identity: { clanTag: "#WAR2", clanName: "Z War" } }),
      clan({ identity: { clanTag: "#WAR1", clanName: "A War" } }),
    ];
    const rows = buildSyncRetrospectiveComponents(result({ clans }));
    const menu = rows[0].toJSON().components[0];

    expect(rows).toHaveLength(1);
    expect(menu.custom_id).toBe("sync-retro:clan:545:0");
    expect(menu.min_values).toBe(1);
    expect(menu.max_values).toBe(1);
    expect(menu.options?.map((option) => option.value)).toEqual(["#WAR1", "#WAR2", "#SNAP"]);
    expect(menu.options?.[0]?.description).toBe("#WAR1");
  });

  it("splits one hundred clans into four non-empty menus", () => {
    const clans = Array.from({ length: 100 }, (_, index) => clan({
      identity: {
        clanTag: `#TAG${String(index).padStart(3, "0")}`,
        clanName: `Clan ${String(index).padStart(3, "0")}`,
      },
    }));
    const rows = buildSyncRetrospectiveComponents(result({ clans }));
    const menus = rows.map((row) => row.toJSON().components[0]);

    expect(rows).toHaveLength(4);
    expect(menus.every((menu) => (menu.options ?? []).length > 0 && (menu.options ?? []).length <= 25)).toBe(true);
    expect(menus.map((menu) => menu.custom_id)).toEqual([
      "sync-retro:clan:545:0",
      "sync-retro:clan:545:1",
      "sync-retro:clan:545:2",
      "sync-retro:clan:545:3",
    ]);
    expect(menus.flatMap((menu) => menu.options ?? [])).toHaveLength(100);
  });

  it("supports five menus and caps malformed input at Discord's 125-clan limit", () => {
    const clans = Array.from({ length: 126 }, (_, index) => clan({
      identity: {
        clanTag: `#TAG${String(index).padStart(3, "0")}`,
        clanName: `Clan ${String(index).padStart(3, "0")}`,
      },
    }));
    const rows = buildSyncRetrospectiveComponents(result({ clans }));
    const menus = rows.map((row) => row.toJSON().components[0]);

    expect(rows).toHaveLength(5);
    expect(menus.map((menu) => menu.custom_id)).toEqual([
      "sync-retro:clan:545:0",
      "sync-retro:clan:545:1",
      "sync-retro:clan:545:2",
      "sync-retro:clan:545:3",
      "sync-retro:clan:545:4",
    ]);
    expect(menus.every((menu) => (menu.options ?? []).length > 0 && (menu.options ?? []).length <= 25)).toBe(true);
    expect(menus.flatMap((menu) => menu.options ?? [])).toHaveLength(125);
    expect(menus.flatMap((menu) => menu.options ?? []).map((option) => option.value)).not.toContain("#TAG125");
  });

  it("renders persisted detail sections with explicit incomplete and not-applicable states", () => {
    const detailClan = clan({
      identity: { clanTag: "#DETAIL", clanName: "Detail Clan", matchType: "FWA" },
      war: { stars: null },
      missedAttacks: {
        total: 2,
        coverageComplete: true,
        players: [
          { playerTag: "#P2", playerName: "Zulu", attacksUsed: 0, attacksMissed: 2, starsEarned: 0 },
          { playerTag: "#P1", playerName: "Alpha", attacksUsed: 1, attacksMissed: 0, starsEarned: 3 },
        ],
      },
      violations: {
        total: 1,
        evaluationComplete: true,
        applicable: true,
        details: [{
          violationType: "missed_attack",
          playerTag: "#P2",
          playerName: "Zulu",
          reasonLabel: "Missed attack",
          expectedBehavior: "Use both attacks",
          actualBehavior: "Used none",
        }],
      },
      readiness: { memberCount: 49, deviationScore: null, projectionComplete: false, dataAvailable: true },
      fillers: { fillerCount: 1, fillerPlayerTags: ["#P2"], fillerCaptureComplete: true },
    });
    const fields = buildSyncRetrospectiveClanDetailEmbeds(result({ clans: [detailClan] }), detailClan)
      .flatMap((embed) => embed.toJSON().fields ?? []);
    const values = fields.map((field) => field.value).join("\n");

    expect(fields[0]?.name).toBe("War");
    expect(values).toContain("Stars: —");
    expect(values).toContain("Missed attacks: 2");
    expect(values).toContain("**Zulu** `#P2`");
    expect(values).toContain("Violations: 1");
    expect(values).toContain("Members: 49");
    expect(values).toContain("Deviation: —");
    expect(values).toContain("Fillers: 1");
    expect(values).not.toContain("#P1");
  });

  it("keeps pathological persisted detail text within Discord limits", () => {
    const longText = "X".repeat(5000);
    const detailClan = clan({
      identity: { clanTag: "#LONG", clanName: longText },
      missedAttacks: {
        total: 1,
        coverageComplete: true,
        players: [{ playerTag: longText, playerName: longText, attacksUsed: 0, attacksMissed: 1, starsEarned: 0 }],
      },
      violations: {
        total: 1,
        evaluationComplete: true,
        applicable: true,
        details: [{
          violationType: longText,
          playerTag: longText,
          playerName: longText,
          reasonLabel: longText,
          expectedBehavior: longText,
          actualBehavior: longText,
        }],
      },
      fillers: { fillerCount: 1, fillerPlayerTags: [longText], fillerCaptureComplete: true },
    });

    const embeds = buildSyncRetrospectiveClanDetailEmbeds(result({ clans: [detailClan] }), detailClan);
    const serialized = embeds.map((embed) => embed.toJSON());
    const fields = serialized.flatMap((embed) => embed.fields ?? []);
    const fieldValues = fields.map((field) => field.value);

    expect(serialized.length).toBeLessThanOrEqual(10);
    expect(fields.length).toBeGreaterThan(0);
    expect(fields.every((field) => field.value.length <= 1024)).toBe(true);
    expect(serialized.every((embed) => (embed.title?.length ?? 0) + (embed.description?.length ?? 0) +
      (embed.fields ?? []).reduce((total, field) => total + field.name.length + field.value.length, 0) <= 6000)).toBe(true);
    expect(fieldValues.join("\n")).toContain("Violations: 1");
    expect(fieldValues.join("\n")).toContain("Expected:");
    expect(fieldValues.join("\n")).toContain("Actual:");
    expect(fieldValues.join("\n")).toContain("\u2026");
    expect(fieldValues.every((value) => value.length <= 1024)).toBe(true);
  });

  it("returns the sorter result without mutating the source array", () => {
    const clans = [
      clan({ identity: { clanTag: "#SNAP", clanName: "Snapshot", warId: null } }),
      clan({ identity: { clanTag: "#WAR", clanName: "War" } }),
    ];
    const sorted = sortSyncRetrospectiveClans(clans);
    expect(sorted.map((row) => row.identity.clanTag)).toEqual(["#WAR", "#SNAP"]);
    expect(clans.map((row) => row.identity.clanTag)).toEqual(["#SNAP", "#WAR"]);
  });
});
