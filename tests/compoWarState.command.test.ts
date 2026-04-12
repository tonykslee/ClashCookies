import { beforeEach, describe, expect, it, vi } from "vitest";
import { Compo } from "../src/commands/Compo";
import { CompoActualStateService } from "../src/services/CompoActualStateService";
import { CompoWarStateService } from "../src/services/CompoWarStateService";
import { GoogleSheetsService } from "../src/services/GoogleSheetsService";

function makeInteraction(params: {
  subcommand: "state";
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
        if (name === "mode") return params.mode ?? null;
        return null;
      }),
    },
  };
  return interaction;
}

describe("/compo state mode:war DB cutover", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders mode:war from the DB-backed war state service without sheet reads", async () => {
    const readStateSpy = vi
      .spyOn(CompoWarStateService.prototype, "readState")
      .mockResolvedValue({
        stateRows: [
          ["Clan", "Total", "Missing", "Players", "TH18", "TH17", "TH16", "TH15", "TH14", "<=TH13"],
          ["Alpha Clan", "7,000,000", "0", "50", "0", "1", "0", "-1", "0", "0"],
        ],
        contentLines: [
          "Mode Displayed: **WAR**",
          "Persisted WAR data last refreshed: <t:1775817600:F>",
        ],
        trackedClanTags: ["#AAA111"],
        snapshotClanTags: ["#AAA111"],
        renderableClanTags: ["#AAA111"],
      });
    const getSheetSpy = vi.spyOn(GoogleSheetsService.prototype, "getCompoLinkedSheet");
    const readSheetSpy = vi.spyOn(GoogleSheetsService.prototype, "readCompoLinkedValues");

    const interaction = makeInteraction({ subcommand: "state", mode: "war" });
    await Compo.run({} as any, interaction as any, {} as any);

    expect(readStateSpy).toHaveBeenCalledTimes(1);
    expect(getSheetSpy).not.toHaveBeenCalled();
    expect(readSheetSpy).not.toHaveBeenCalled();
    const payload = interaction.editReply.mock.calls.at(-1)?.[0];
    expect(String(payload?.content ?? "")).toContain("Mode Displayed: **WAR**");
    expect(Array.isArray(payload?.files)).toBe(true);
    expect(payload?.files?.[0]?.name).toBe("compo-state-war.png");
  });

  it("returns an honest text response when no DB-backed war snapshots are renderable", async () => {
    vi.spyOn(CompoWarStateService.prototype, "readState").mockResolvedValue({
      stateRows: null,
      contentLines: [
        "Mode Displayed: **WAR**",
        "Persisted WAR data last refreshed: (not available)",
        "Skipped ineligible clans: Alpha Clan (roster size 45/50)",
        "No DB-backed WAR roster snapshots are currently renderable.",
      ],
      trackedClanTags: ["#AAA111"],
      snapshotClanTags: ["#AAA111"],
      renderableClanTags: [],
    });

    const interaction = makeInteraction({ subcommand: "state", mode: "war" });
    await Compo.run({} as any, interaction as any, {} as any);

    const payload = interaction.editReply.mock.calls.at(-1)?.[0];
    expect(String(payload?.content ?? "")).toContain("No DB-backed WAR roster snapshots are currently renderable.");
    expect(Object.prototype.hasOwnProperty.call(payload, "files")).toBe(false);
  });

  it("renders mode:actual from the DB-backed ACTUAL state service without sheet reads", async () => {
    const readStateSpy = vi.spyOn(CompoWarStateService.prototype, "readState");
    const actualReadStateSpy = vi
      .spyOn(CompoActualStateService.prototype, "readState")
      .mockResolvedValue({
        stateRows: [
          ["Clan", "Total", "Missing", "Players", "TH18", "TH17", "TH16", "TH15", "TH14", "<=TH13"],
          ["Alpha Clan", "1,500,000", "0", "50", "0", "0", "0", "0", "0", "0"],
        ],
        contentLines: ["RAW Data last refreshed: <t:1775817600:F>"],
        trackedClanTags: ["#AAA111"],
        renderableClanTags: ["#AAA111"],
        view: "raw",
      });
    const getSheetSpy = vi.spyOn(GoogleSheetsService.prototype, "getCompoLinkedSheet");
    const readSheetSpy = vi.spyOn(GoogleSheetsService.prototype, "readCompoLinkedValues");

    const interaction = makeInteraction({ subcommand: "state", mode: "actual" });
    await Compo.run({} as any, interaction as any, {} as any);

    expect(readStateSpy).not.toHaveBeenCalled();
    expect(actualReadStateSpy).toHaveBeenCalledTimes(1);
    expect(getSheetSpy).not.toHaveBeenCalled();
    expect(readSheetSpy).not.toHaveBeenCalled();
    const payload = interaction.editReply.mock.calls.at(-1)?.[0];
    expect(String(payload?.content ?? "")).toContain("RAW Data last refreshed:");
    expect(Array.isArray(payload?.files)).toBe(true);
  });
});
