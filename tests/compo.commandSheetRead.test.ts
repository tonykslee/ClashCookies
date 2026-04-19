import { beforeEach, describe, expect, it, vi } from "vitest";
import { Compo } from "../src/commands/Compo";
import { CompoAdviceService } from "../src/services/CompoAdviceService";
import { GoogleSheetsService } from "../src/services/GoogleSheetsService";

function makeInteraction(params: {
  subcommand: "advice";
  tag?: string;
  mode?: string | null;
}) {
  const interaction: any = {
    commandName: "compo",
    guildId: "guild-1",
    user: { id: "user-1" },
    deferred: false,
    replied: false,
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
    options: {
      getSubcommand: vi.fn(() => params.subcommand),
      getString: vi.fn((name: string) => {
        if (name === "tag") return params.tag ?? null;
        if (name === "mode") return params.mode ?? null;
        return null;
      }),
    },
  };
  return interaction;
}

function getComponentCustomIds(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const rows = Array.isArray((payload as { components?: unknown[] }).components)
    ? ((payload as { components: unknown[] }).components as unknown[])
    : [];
  return rows.flatMap((row) => {
    const normalized =
      row && typeof (row as { toJSON?: () => unknown }).toJSON === "function"
        ? (row as { toJSON: () => unknown }).toJSON()
        : row;
    if (!normalized || typeof normalized !== "object") return [];
    const components = Array.isArray((normalized as { components?: unknown[] }).components)
      ? ((normalized as { components: unknown[] }).components as unknown[])
      : [];
    return components
      .map((component) =>
        String(
          (component as { custom_id?: unknown; customId?: unknown }).custom_id ??
            (component as { custom_id?: unknown; customId?: unknown }).customId ??
            "",
        ),
      )
      .filter((value) => value.length > 0);
  });
}

describe("/compo advice command", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the DB-backed advice service and renders an embed without sheet access", async () => {
    const readAdviceSpy = vi
      .spyOn(CompoAdviceService.prototype, "readAdvice")
      .mockResolvedValue({
        kind: "ready",
        mode: "actual",
        selectedView: "auto",
        trackedClanTags: ["#AAA111"],
        trackedClanChoices: [{ tag: "#AAA111", name: "Alpha Clan-actual" }],
        clanTag: "#AAA111",
        clanName: "Alpha Clan-actual",
        memberCount: 50,
        rushedCount: 1,
        refreshLine: "RAW Data last refreshed: <t:1709900000:F>",
        summary: {
          mode: "actual",
          view: "auto",
          viewLabel: "Auto-Detect Band",
          heatMapRefs: [
            { weightMinInclusive: 0, weightMaxInclusive: 999_999 },
            { weightMinInclusive: 1_000_000, weightMaxInclusive: 2_000_000 },
            { weightMinInclusive: 2_000_001, weightMaxInclusive: 3_000_000 },
          ],
          bandMatchRatesByBandKey: new Map([
            ["0-999999", 0.7],
            ["1000000-2000000", 0.7214],
            ["2000001-3000000", 0.74],
          ]),
          currentProjection: {
            totalWeight: 1_500_000,
            memberCount: 50,
            missingWeights: 2,
            selectedHeatMapRef: {
              weightMinInclusive: 1_000_000,
              weightMaxInclusive: 2_000_000,
            },
            deltaByBucket: {
              TH18: 0,
              TH17: 0,
              TH16: 0,
              TH15: 0,
              TH14: 0,
              "<=TH13": 0,
            },
          } as any,
          currentMatchrate: 0.7214,
          targetBandMatchrate: 0.7214,
          resultingMatchrate: 0.7214,
          currentWeight: 1_500_000,
          targetBandMidpoint: 1_500_000,
          currentScore: 0,
          currentBandLabel: "1,000,000 - 2,000,000",
          targetBandLabel: "1,000,000 - 2,000,000",
          targetHeatMapRef: {
            weightMinInclusive: 1_000_000,
            weightMaxInclusive: 2_000_000,
          },
          recommendationText: "Add TH17",
          resultingScore: 0,
          resultingBandLabel: "1,000,000 - 2,000,000",
          alternateTexts: [],
          statusText: null,
          selectedCustomBandIndex: 0,
          customBandCount: 1,
        } as any,
      });
    const getCompoLinkedSheetSpy = vi.spyOn(
      GoogleSheetsService.prototype,
      "getCompoLinkedSheet",
    );
    const readCompoLinkedValuesSpy = vi.spyOn(
      GoogleSheetsService.prototype,
      "readCompoLinkedValues",
    );

    const interaction = makeInteraction({
      subcommand: "advice",
      tag: "#LQQ99UV8",
    });
    await Compo.run({} as any, interaction as any, {} as any);

    expect(readAdviceSpy).toHaveBeenCalledWith({
      guildId: "guild-1",
      targetTag: "LQQ99UV8",
      mode: "actual",
    });
    expect(getCompoLinkedSheetSpy).not.toHaveBeenCalled();
    expect(readCompoLinkedValuesSpy).not.toHaveBeenCalled();

    const payload = interaction.editReply.mock.calls.at(-1)?.[0];
    expect(String(payload?.content ?? "")).toBe("RAW Data last refreshed: <t:1709900000:F>");
    expect(Array.isArray(payload?.embeds)).toBe(true);
    const embed = payload?.embeds?.[0]?.data ?? {};
    expect(String(embed?.description ?? "")).toBe("");
    expect(
      (embed?.fields ?? []).map((field: { name?: unknown }) => String(field.name ?? "")),
    ).toEqual([
      "Overview",
      "Current",
      "Target",
      "Recommendation",
      "Result",
      "Current Deltas",
      "Adjacent Bands",
    ]);
    expect(JSON.stringify(embed?.fields ?? [])).toContain("Mode: **ACTUAL**");
    expect(JSON.stringify(embed?.fields ?? [])).toContain(
      "Advice View: **Auto-Detect Band**",
    );
    expect(JSON.stringify(embed?.fields ?? [])).toContain("Current Weight: 1,500,000");
    expect(JSON.stringify(embed?.fields ?? [])).toContain("Current Deviation Score: **0**");
    expect(JSON.stringify(embed?.fields ?? [])).toContain("Matchrate: 72.14%");
    expect(JSON.stringify(embed?.fields ?? [])).toContain(
      "Missing weights: 2 [FWA Stats](https://fwastats.com/Clan/AAA111/Weight)",
    );
    expect(JSON.stringify(embed?.fields ?? [])).toContain("Band matchrate: 72.14%");
    expect(JSON.stringify(embed?.fields ?? [])).toContain("Band midpoint: +0");
    expect(String(embed?.title ?? "")).toContain("Alpha Clan (#AAA111)");
    expect(JSON.stringify(embed?.fields ?? [])).not.toContain("Alternates");
    expect(JSON.stringify(embed?.fields ?? [])).not.toContain("Snapshot");
    expect(JSON.stringify(embed?.fields ?? [])).toContain(
      ":arrow_arrow: __Add TH17__",
    );
    expect(JSON.stringify(embed?.fields ?? [])).toContain("Deviation Score: **0**");
    expect(JSON.stringify(embed?.fields ?? [])).toContain("Lower band: **0 - 999,999**");
    expect(JSON.stringify(embed?.fields ?? [])).toContain(
      "Higher band: **2,000,001 - 3,000,000**",
    );
    expect(JSON.stringify(embed?.fields ?? [])).toContain("Matchrate: 70.00%");
    expect(JSON.stringify(embed?.fields ?? [])).toContain("Matchrate: 74.00%");
    expect(embed?.footer).toBeUndefined();
    expect(getComponentCustomIds(payload)).toEqual(
      expect.arrayContaining([
        "compo-refresh:advice:user-1:actual:auto:LQQ99UV8:1:0",
        "compo-refresh:advice-clan:user-1:actual:AAA111:auto:1:0",
        "compo-refresh:view:user-1:advice:raw:LQQ99UV8:1:0",
        "compo-refresh:view:user-1:advice:auto:LQQ99UV8:1:0",
        "compo-refresh:view:user-1:advice:best:LQQ99UV8:1:0",
        "compo-refresh:view:user-1:advice:custom:LQQ99UV8:1:0",
      ]),
    );
  });

  it("renders WAR advice with only a refresh button", async () => {
    vi.spyOn(CompoAdviceService.prototype, "readAdvice").mockResolvedValue({
      kind: "ready",
      mode: "war",
      selectedView: "raw",
      trackedClanTags: ["#AAA111"],
      trackedClanChoices: [{ tag: "#AAA111", name: "Alpha Clan-war" }],
      clanTag: "#AAA111",
      clanName: "Alpha Clan-war",
      memberCount: 50,
      rushedCount: 0,
      refreshLine: "RAW Data last refreshed: <t:1709900000:F>",
      summary: {
        mode: "war",
        view: "raw",
        viewLabel: "Raw Data",
        heatMapRefs: [
          { weightMinInclusive: 0, weightMaxInclusive: 9_999_999 },
        ],
        bandMatchRatesByBandKey: new Map([["0-9999999", 0.5]]),
        currentProjection: {
          totalWeight: 1_500_000,
          memberCount: 50,
          selectedHeatMapRef: {
            weightMinInclusive: 0,
            weightMaxInclusive: 9_999_999,
          },
          deltaByBucket: {
            TH18: 0,
            TH17: 0,
            TH16: 0,
            TH15: 0,
            TH14: 0,
            "<=TH13": 0,
          },
        } as any,
        currentMatchrate: 0.5,
        targetBandMatchrate: 0.5,
        resultingMatchrate: 0.5,
        currentWeight: 1_500_000,
        targetBandMidpoint: 1_500_000,
        currentScore: 0,
        currentBandLabel: "0 - 9999999",
        targetBandLabel: "0 - 9999999",
        targetHeatMapRef: {
          weightMinInclusive: 0,
          weightMaxInclusive: 9_999_999,
        },
        recommendationText: "No improvement found.",
        resultingScore: null,
        resultingBandLabel: "(no band)",
        alternateTexts: [],
        statusText: "No improvement found.",
        selectedCustomBandIndex: 0,
        customBandCount: 1,
      } as any,
    });

    const interaction = makeInteraction({
      subcommand: "advice",
      tag: "#LQQ99UV8",
      mode: "war",
    });
    await Compo.run({} as any, interaction as any, {} as any);

    const payload = interaction.editReply.mock.calls.at(-1)?.[0];
    expect(String(payload?.content ?? "")).toBe("RAW Data last refreshed: <t:1709900000:F>");
    expect(JSON.stringify(payload?.embeds?.[0]?.data?.fields ?? [])).toContain(
      "Advice View: **Raw Data**",
    );
    expect(payload?.embeds?.[0]?.data?.footer).toBeUndefined();
    expect(getComponentCustomIds(payload)).toEqual([
      "compo-refresh:advice:user-1:war:LQQ99UV8",
      "compo-refresh:advice-clan:user-1:war:AAA111",
    ]);
  });

  it("renders empty advice with refresh content below the embed and no footer note", async () => {
    vi.spyOn(CompoAdviceService.prototype, "readAdvice").mockResolvedValue({
      kind: "empty",
      mode: "actual",
      selectedView: "auto",
      trackedClanTags: ["#AAA111"],
      trackedClanChoices: [{ tag: "#AAA111", name: "Alpha Clan-actual" }],
      clanTag: null,
      clanName: null,
      message: "No tracked clan matched tag `#LQQ99UV8`.",
      refreshLine: "RAW Data last refreshed: <t:1709900000:F>",
    });

    const interaction = makeInteraction({
      subcommand: "advice",
      tag: "#LQQ99UV8",
    });
    await Compo.run({} as any, interaction as any, {} as any);

    const payload = interaction.editReply.mock.calls.at(-1)?.[0];
    expect(String(payload?.content ?? "")).toBe("RAW Data last refreshed: <t:1709900000:F>");
    expect(String(payload?.embeds?.[0]?.data?.description ?? "")).toContain(
      "No tracked clan matched tag `#LQQ99UV8`.",
    );
    expect(payload?.embeds?.[0]?.data?.footer).toBeUndefined();
  });
});
