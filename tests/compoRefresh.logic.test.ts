import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCompoRefreshCustomIdForTest,
  handleCompoRefreshButton,
} from "../src/commands/Compo";
import { CompoAdviceService } from "../src/services/CompoAdviceService";
import { CompoActualStateService } from "../src/services/CompoActualStateService";

function makeMessageRow(customId: string, label: string, disabled = false): { toJSON: () => unknown } {
  return {
    toJSON: () => ({
      type: 1,
      components: [
        {
          type: 2,
          style: 2,
          label,
          custom_id: customId,
          disabled,
        },
      ],
    }),
  };
}

function readFirstButton(payload: unknown): { label: string; disabled: boolean } | null {
  if (!payload || typeof payload !== "object") return null;
  const rows = Array.isArray((payload as { components?: unknown[] }).components)
    ? ((payload as { components: unknown[] }).components as unknown[])
    : [];
  const firstRow = rows[0];
  const normalized =
    firstRow && typeof (firstRow as { toJSON?: () => unknown }).toJSON === "function"
      ? (firstRow as { toJSON: () => unknown }).toJSON()
      : firstRow;
  if (!normalized || typeof normalized !== "object") return null;
  const firstComponent = Array.isArray((normalized as { components?: unknown[] }).components)
    ? (normalized as { components: unknown[] }).components[0]
    : null;
  if (!firstComponent || typeof firstComponent !== "object") return null;
  return {
    label: String((firstComponent as { label?: unknown }).label ?? ""),
    disabled: Boolean((firstComponent as { disabled?: unknown }).disabled),
  };
}

function collectButtonCustomIds(payload: unknown): string[] {
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
      .map((component) => String((component as { custom_id?: unknown }).custom_id ?? ""))
      .filter((customId) => customId.length > 0);
  });
}

function makeInteraction(customId: string) {
  const interaction: any = {
    customId,
    guildId: "guild-1",
    channelId: "channel-1",
    user: { id: "user-1" },
    message: {
      id: "message-1",
      components: [
        makeMessageRow(customId, "Refresh Data"),
        makeMessageRow("post-channel:user-1", "Post to Channel"),
      ],
    },
    replied: false,
    deferred: false,
    update: vi.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
  };
  return interaction;
}

describe("compo refresh button behavior", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("shows loading state, refreshes DB-backed ACTUAL state, and rerenders state output", async () => {
    vi.spyOn(CompoActualStateService.prototype, "refreshState").mockResolvedValue({
      stateRows: [
        ["Clan", "Total", "Missing", "Players", "TH18", "TH17", "TH16", "TH15", "TH14", "<=TH13"],
        ["ACTUAL CLAN", "1,500,000", "2", "50", "0", "-1", "0", "0", "0", "0"],
      ],
      contentLines: ["RAW Data last refreshed: <t:1709900000:F>"],
      trackedClanTags: ["#AAA111"],
      renderableClanTags: ["#AAA111"],
      view: "raw",
    });

    const customId = buildCompoRefreshCustomIdForTest({
      kind: "state",
      userId: "user-1",
      mode: "actual",
    });
    const interaction = makeInteraction(customId);

    await handleCompoRefreshButton(interaction as any, {} as any);

    expect(CompoActualStateService.prototype.refreshState).toHaveBeenCalledWith(
      "guild-1",
      { view: "raw" },
    );
    const loadingPayload = interaction.update.mock.calls[0]?.[0];
    expect(readFirstButton(loadingPayload)).toEqual({
      label: "Refreshing...",
      disabled: true,
    });
    const refreshedPayload = interaction.editReply.mock.calls.at(-1)?.[0];
    expect(readFirstButton(refreshedPayload)).toEqual({
      label: "Refresh Data",
      disabled: false,
    });
    expect(Array.isArray(refreshedPayload.files)).toBe(true);
    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  it("restores non-loading state and keeps previous output on DB-backed ACTUAL refresh failure", async () => {
    vi.spyOn(CompoActualStateService.prototype, "refreshState").mockRejectedValue(
      new Error("boom"),
    );
    const customId = buildCompoRefreshCustomIdForTest({
      kind: "state",
      userId: "user-1",
      mode: "actual",
    });
    const interaction = makeInteraction(customId);

    await handleCompoRefreshButton(interaction as any, {} as any);

    const loadingPayload = interaction.update.mock.calls[0]?.[0];
    expect(readFirstButton(loadingPayload)).toEqual({
      label: "Refreshing...",
      disabled: true,
    });
    const recoveryPayload = interaction.editReply.mock.calls.at(-1)?.[0];
    expect(readFirstButton(recoveryPayload)).toEqual({
      label: "Refresh Data",
      disabled: false,
    });
    expect(Object.prototype.hasOwnProperty.call(recoveryPayload, "content")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(recoveryPayload, "embeds")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(recoveryPayload, "files")).toBe(false);
    expect(interaction.followUp).toHaveBeenCalledTimes(1);
    expect(String(interaction.followUp.mock.calls[0]?.[0]?.content ?? "")).toContain(
      "Failed to refresh DB-backed ACTUAL state."
    );
  });

  it("rerenders into the selected ACTUAL view and preserves that view on refresh", async () => {
    vi.spyOn(CompoActualStateService.prototype, "readState").mockResolvedValue({
      stateRows: [
        ["Clan", "Total", "Missing", "Players", "TH18", "TH17", "TH16", "TH15", "TH14", "<=TH13"],
        ["ACTUAL CLAN", "1,635,000", "2", "49", "1", "0", "-1", "0", "0", "0"],
      ],
      contentLines: [
        "RAW Data last refreshed: <t:1709900000:F>",
        "ACTUAL View: **Auto-Detect Band**",
      ],
      trackedClanTags: ["#AAA111"],
      renderableClanTags: ["#AAA111"],
      view: "auto",
    });
    vi.spyOn(CompoActualStateService.prototype, "refreshState").mockResolvedValue({
      stateRows: [
        ["Clan", "Total", "Missing", "Players", "TH18", "TH17", "TH16", "TH15", "TH14", "<=TH13"],
        ["ACTUAL CLAN", "1,635,000", "2", "49", "1", "0", "-1", "0", "0", "0"],
      ],
      contentLines: [
        "RAW Data last refreshed: <t:1709900001:F>",
        "ACTUAL View: **Auto-Detect Band**",
      ],
      trackedClanTags: ["#AAA111"],
      renderableClanTags: ["#AAA111"],
      view: "auto",
    });

    const viewInteraction = makeInteraction(
      buildCompoRefreshCustomIdForTest({
        kind: "view",
        userId: "user-1",
        actualView: "auto",
      }),
    );
    viewInteraction.message.components = [
      makeMessageRow("compo-refresh:state:user-1:actual:raw", "Refresh Data"),
      makeMessageRow("compo-refresh:view:user-1:raw", "Raw Data"),
      makeMessageRow("post-channel:user-1", "Post to Channel"),
    ];

    await handleCompoRefreshButton(viewInteraction as any, {} as any);

    expect(CompoActualStateService.prototype.readState).toHaveBeenCalledWith(
      "guild-1",
      { view: "auto" },
    );
    const viewPayload = viewInteraction.editReply.mock.calls.at(-1)?.[0];
    expect(collectButtonCustomIds(viewPayload)).toEqual(
      expect.arrayContaining([
        "compo-refresh:state:user-1:actual:auto",
        "compo-refresh:view:user-1:state:raw",
        "compo-refresh:view:user-1:state:auto",
        "compo-refresh:view:user-1:state:best",
      ]),
    );

    const refreshInteraction = makeInteraction("compo-refresh:state:user-1:actual:auto");
    refreshInteraction.message.components = (viewPayload.components as unknown[]).map(
      (row) =>
        row && typeof (row as { toJSON?: () => unknown }).toJSON === "function"
          ? row
          : { toJSON: () => row },
    );

    await handleCompoRefreshButton(refreshInteraction as any, {} as any);

    expect(CompoActualStateService.prototype.refreshState).toHaveBeenCalledWith(
      "guild-1",
      { view: "auto" },
    );
  });

  it("keeps the selected ACTUAL advice view across view switches and refreshes", async () => {
    vi.spyOn(CompoAdviceService.prototype, "refreshAdvice").mockResolvedValue({
      kind: "ready",
      mode: "actual",
      selectedView: "best",
      trackedClanTags: ["#AAA111"],
      trackedClanChoices: [{ tag: "#AAA111", name: "Alpha Clan" }],
      clanTag: "#AAA111",
      clanName: "Alpha Clan-actual",
      memberCount: 49,
      rushedCount: 0,
      refreshLine: "RAW Data last refreshed: <t:1709900001:F>",
      summary: {
        mode: "actual",
        view: "best",
        viewLabel: "Best Fit",
        heatMapRefs: [
          { weightMinInclusive: 0, weightMaxInclusive: 9_999_999 },
        ],
        bandMatchRatesByBandKey: new Map([["0-9999999", 0.5]]),
        currentProjection: {
          memberCount: 49,
          selectedHeatMapRef: {
            weightMinInclusive: 0,
            weightMaxInclusive: 9_999_999,
          },
          deltaByBucket: {
            TH18: 1,
            TH17: 0,
            TH16: -1,
            TH15: 0,
            TH14: 0,
            "<=TH13": 0,
          },
        } as any,
        currentScore: 4,
        currentBandLabel: "0 - 9999999",
        recommendationText: "Add TH17",
        resultingScore: 0,
        resultingBandLabel: "0 - 9999999",
        alternateTexts: [],
        statusText: null,
        selectedCustomBandIndex: 0,
        customBandCount: 1,
      } as any,
    });

    const viewInteraction = makeInteraction(
      buildCompoRefreshCustomIdForTest({
        kind: "view",
        userId: "user-1",
        target: "advice",
        adviceView: "best",
        targetTag: "AAA111",
        customBandIndex: 0,
        customBandCount: 1,
      }),
    );
    viewInteraction.message.components = [
      makeMessageRow("compo-refresh:advice:user-1:actual:auto:AAA111:1:0", "Refresh Data"),
      makeMessageRow("post-channel:user-1", "Post to Channel"),
    ];

    await handleCompoRefreshButton(viewInteraction as any, {} as any);

    expect(CompoAdviceService.prototype.refreshAdvice).toHaveBeenCalledWith({
      guildId: "guild-1",
      targetTag: "AAA111",
      mode: "actual",
      view: "best",
      customBandIndex: 0,
    });
    const viewPayload = viewInteraction.editReply.mock.calls.at(-1)?.[0];
    expect(collectButtonCustomIds(viewPayload)).toEqual(
      expect.arrayContaining([
        "compo-refresh:advice:user-1:actual:best:AAA111:1:0",
        "compo-refresh:advice-clan:user-1:actual:AAA111:best:1:0",
        "compo-refresh:view:user-1:advice:raw:AAA111:1:0",
        "compo-refresh:view:user-1:advice:auto:AAA111:1:0",
        "compo-refresh:view:user-1:advice:best:AAA111:1:0",
        "compo-refresh:view:user-1:advice:custom:AAA111:1:0",
      ]),
    );

    const refreshInteraction = makeInteraction(
      "compo-refresh:advice:user-1:actual:best:AAA111:1:0",
    );
    refreshInteraction.message.components = (viewPayload.components as unknown[]).map(
      (row) =>
        row && typeof (row as { toJSON?: () => unknown }).toJSON === "function"
          ? row
          : { toJSON: () => row },
    );

    await handleCompoRefreshButton(refreshInteraction as any, {} as any);

    expect(CompoAdviceService.prototype.refreshAdvice).toHaveBeenCalledWith({
      guildId: "guild-1",
      targetTag: "AAA111",
      mode: "actual",
      view: "best",
      customBandIndex: 0,
    });
  });

  it("steps the ACTUAL custom band and preserves the new selection through refresh", async () => {
    vi.spyOn(CompoAdviceService.prototype, "refreshAdvice").mockResolvedValue({
      kind: "ready",
      mode: "actual",
      selectedView: "custom",
      trackedClanTags: ["#AAA111"],
      trackedClanChoices: [{ tag: "#AAA111", name: "Alpha Clan" }],
      clanTag: "#AAA111",
      clanName: "Alpha Clan-actual",
      memberCount: 50,
      rushedCount: 1,
      refreshLine: "RAW Data last refreshed: <t:1709900002:F>",
      summary: {
        mode: "actual",
        view: "custom",
        viewLabel: "Custom",
        heatMapRefs: [
          { weightMinInclusive: 1_500_000, weightMaxInclusive: 1_999_999 },
          { weightMinInclusive: 2_000_000, weightMaxInclusive: 2_499_999 },
        ],
        bandMatchRatesByBandKey: new Map([
          ["1500000-1999999", 0.5],
          ["2000000-2499999", 0.55],
        ]),
        currentProjection: {
          memberCount: 50,
          selectedHeatMapRef: {
            weightMinInclusive: 1_500_000,
            weightMaxInclusive: 1_999_999,
          },
          deltaByBucket: {
            TH18: 0,
            TH17: -1,
            TH16: 0,
            TH15: 0,
            TH14: 1,
            "<=TH13": 0,
          },
        } as any,
        currentScore: 3,
        currentBandLabel: "1,500,000 - 1,999,999",
        recommendationText: "Replace one TH14 with one TH17",
        resultingScore: 1,
        resultingBandLabel: "1,500,000 - 1,999,999",
        alternateTexts: ["Add TH17"],
        statusText: null,
        selectedCustomBandIndex: 1,
        customBandCount: 2,
      } as any,
    });

    const stepInteraction = makeInteraction(
      buildCompoRefreshCustomIdForTest({
        kind: "advice-band",
        userId: "user-1",
        targetTag: "AAA111",
        customBandIndex: 0,
        customBandCount: 2,
        direction: "next",
      }),
    );
    stepInteraction.message.components = [
      makeMessageRow("compo-refresh:advice:user-1:actual:custom:AAA111:2:0", "Refresh Data"),
      makeMessageRow("post-channel:user-1", "Post to Channel"),
    ];

    await handleCompoRefreshButton(stepInteraction as any, {} as any);

    expect(CompoAdviceService.prototype.refreshAdvice).toHaveBeenCalledWith({
      guildId: "guild-1",
      targetTag: "AAA111",
      mode: "actual",
      view: "custom",
      customBandIndex: 1,
    });
    const payload = stepInteraction.editReply.mock.calls.at(-1)?.[0];
    expect(collectButtonCustomIds(payload)).toEqual(
      expect.arrayContaining([
        "compo-refresh:advice:user-1:actual:custom:AAA111:2:1",
        "compo-refresh:advice-clan:user-1:actual:AAA111:custom:2:1",
        "compo-refresh:advice-band:user-1:AAA111:2:1:prev",
        "compo-refresh:advice-band:user-1:AAA111:2:1:next",
      ]),
    );
  });
});
