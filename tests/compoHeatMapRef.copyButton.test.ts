import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCompoHeatMapRefCopyCustomIdForTest,
  buildCompoHeatMapRefCopyTextForTest,
  handleCompoHeatMapRefCopyButton,
} from "../src/commands/Compo";
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
      "WeightMin\tWeightMax\tTH18\tTH17\tTH16\tTH15\tTH14\tTH13\tTH12\tTH11+\tMatch%\t# Clans\n" +
      "0\t100\t1\t2\t3\t4\t5\t6\t7\t8\t83.42%\t11";
    vi.spyOn(HeatMapRefDisplayService.prototype, "readHeatMapRefDisplayTable").mockResolvedValue({
      rows: [
        ["Band", "TH18", "TH17", "TH16", "TH15", "TH14", "TH13", "TH12", "TH11+", "Match%", "Clans"],
        ["0 - 100", "1", "2", "3", "4", "5", "6", "7", "8", "83.42%", "11"],
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

  it("rejects copy clicks from other users", async () => {
    const interaction = makeInteraction(buildCompoHeatMapRefCopyCustomIdForTest("user-1"), "user-2");

    await handleCompoHeatMapRefCopyButton(interaction as any);

    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "Only the command requester can use this copy button.",
    });
  });
});
