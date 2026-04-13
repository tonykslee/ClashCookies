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

  it("uses the DB-backed advice service and keeps sheet access out of the command layer", async () => {
    const readAdviceSpy = vi
      .spyOn(CompoAdviceService.prototype, "readAdvice")
      .mockResolvedValue({
        content:
          "RAW Data last refreshed: <t:1709900000:F>\nMode: **ACTUAL**\nAdvice View: **Auto-Detect Band**\nCurrent Score: **4**\nCurrent Band: **0 - 9999999**\nRecommendation: **Add TH17**\nResulting Score: **0**\nResulting Band: **0 - 9999999**",
        trackedClanTags: ["#AAA111"],
        selectedView: "auto",
        mode: "actual",
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
    expect(String(payload?.content ?? "")).toContain("Advice View: **Auto-Detect Band**");
    expect(getComponentCustomIds(payload)).toEqual(
      expect.arrayContaining([
        "compo-refresh:advice:user-1:actual:auto:LQQ99UV8",
        "compo-refresh:view:user-1:advice:raw:LQQ99UV8",
        "compo-refresh:view:user-1:advice:auto:LQQ99UV8",
        "compo-refresh:view:user-1:advice:best:LQQ99UV8",
      ]),
    );
  });

  it("renders WAR advice with only a refresh button", async () => {
    vi.spyOn(CompoAdviceService.prototype, "readAdvice").mockResolvedValue({
      content:
        "RAW Data last refreshed: <t:1709900000:F>\nMode: **WAR**\nAdvice View: **Raw Data**\nCurrent Score: **0**\nCurrent Band: **0 - 9999999**\nRecommendation: **No improvement found.**\nResulting Score: **n/a**\nResulting Band: **(no band)**",
      trackedClanTags: ["#AAA111"],
      selectedView: "raw",
      mode: "war",
    });

    const interaction = makeInteraction({
      subcommand: "advice",
      tag: "#LQQ99UV8",
      mode: "war",
    });
    await Compo.run({} as any, interaction as any, {} as any);

    const payload = interaction.editReply.mock.calls.at(-1)?.[0];
    expect(String(payload?.content ?? "")).toContain("Mode: **WAR**");
    expect(getComponentCustomIds(payload)).toEqual([
      "compo-refresh:advice:user-1:war:LQQ99UV8",
    ]);
  });
});
