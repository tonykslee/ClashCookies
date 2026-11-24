import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCompoHeatMapRefCopyCustomIdForTest,
  buildCompoHeatMapRefCopyPayloadForTest,
  buildCompoContentPayloadForTest,
  buildCompoHeatMapRefCopyTextForTest,
  handleCompoHeatMapRefCopyButton,
} from "../src/commands/Compo";
import { BlacklistHeatmapRefService } from "../src/services/BlacklistHeatmapRefService";
import { HeatMapRefDisplayService } from "../src/services/HeatMapRefDisplayService";

function makeInteraction(customId: string, userId = "user-1") {
  const interaction: any = {
    customId,
    user: { id: userId },
    replied: false,
    deferred: false,
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn(async () => {
      interaction.replied = true;
    }),
    reply: vi.fn(async () => {
      interaction.replied = true;
    }),
  };
  return interaction;
}

describe("compo heatmapref copy button", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns copy-ready table text for the requester", async () => {
    const copyText =
      "WeightMin,WeightMax,TH19,TH18,TH17,TH16,TH15,TH14,TH13,TH12,TH11+,Match%,# Clans\n" +
      "0,100,—,1,2,3,4,5,6,7,8,83.42%,11";
    vi.spyOn(HeatMapRefDisplayService.prototype, "readHeatMapRefDisplayTable").mockResolvedValue({
      rows: [
        ["Band", "TH19", "TH18", "TH17", "TH16", "TH15", "TH14", "TH13", "TH12", "TH11+", "Match%", "Clans"],
        ["0 - 100", "—", "1", "2", "3", "4", "5", "6", "7", "8", "83.42%", "11"],
      ],
      copyText,
    } as never);

    const interaction = makeInteraction(buildCompoHeatMapRefCopyCustomIdForTest("user-1"));

    await handleCompoHeatMapRefCopyButton(interaction as any);

    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: buildCompoHeatMapRefCopyTextForTest(copyText),
    });
  });

  it("returns blacklist copy-ready table text for the requester", async () => {
    const copyText =
      "WeightMin,WeightMax,TH19,TH18,TH17,TH16,TH15,TH14,TH13,TH12,TH11+,Samples,Src Clans,Opponents,Confidence,Generated\n" +
      "0,100000,—,10,9,8,7,6,5,4,3,12,4,5,high (92),2026-05-20 12:34Z";
    vi.spyOn(BlacklistHeatmapRefService.prototype, "readBlacklistHeatMapRefDisplayTable").mockResolvedValue({
      rows: [
        [
          "Band",
          "TH19",
          "TH18",
          "TH17",
          "TH16",
          "TH15",
          "TH14",
          "TH13",
          "TH12",
          "TH11+",
          "Samples",
          "Src Clans",
          "Opponents",
          "Confidence",
          "Generated",
        ],
        [
          "0 - 100000",
          "—",
          "10",
          "9",
          "8",
          "7",
          "6",
          "5",
          "4",
          "3",
          "12",
          "4",
          "5",
          "high (92)",
          "2026-05-20 12:34Z",
        ],
      ],
      copyText,
    } as never);

    const interaction = makeInteraction(buildCompoHeatMapRefCopyCustomIdForTest("user-1", "blacklist"));

    await handleCompoHeatMapRefCopyButton(interaction as any);

    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: buildCompoHeatMapRefCopyTextForTest(copyText),
    });
  });

  it("rejects copy clicks from other users", async () => {
    const interaction = makeInteraction(buildCompoHeatMapRefCopyCustomIdForTest("user-1"), "user-2");

    await handleCompoHeatMapRefCopyButton(interaction as any);

    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "Only the command requester can use this copy button.",
    });
  });

  it("attaches the complete copy table when Discord content would exceed 2000 characters", () => {
    const copyText = "WeightMin,WeightMax,TH19\n" + "0,100,5\n".repeat(500);
    const payload = buildCompoHeatMapRefCopyPayloadForTest(copyText);
    expect(payload.content).toContain("attached");
    expect(payload.content?.length).toBeLessThanOrEqual(2000);
    expect(payload.files?.[0]?.name).toBe("compo-heatmapref-copy.txt");
    expect(payload.files?.[0]?.attachment.toString("utf8")).toBe(copyText);
  });

  it("keeps large alliance state notes within Discord limits without truncation", () => {
    const notes = Array.from({ length: 400 }, (_, index) => `Clan ${index} native table row`);
    const payload = buildCompoContentPayloadForTest(notes);
    expect(payload.content?.length).toBeLessThanOrEqual(2000);
    expect(payload.files?.[0]?.name).toBe("compo-response.txt");
    expect(payload.files?.[0]?.attachment.toString("utf8")).toBe(notes.join("\n"));
  });
});
