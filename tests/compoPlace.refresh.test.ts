import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCompoRefreshCustomIdForTest,
  handleCompoRefreshButton,
} from "../src/commands/Compo";
import { CompoPlaceService } from "../src/services/CompoPlaceService";
import * as SheetRefreshService from "../src/services/SheetRefreshService";

function makeMessageRow(customId: string, label: string, disabled = false): {
  toJSON: () => unknown;
} {
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

function makeInteraction(customId: string) {
  const interaction: any = {
    customId,
    guildId: "guild-1",
    channelId: "channel-1",
    user: { id: "user-1" },
    message: {
      id: "message-1",
      components: [makeMessageRow(customId, "Refresh Data")],
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

describe("compo place refresh button behavior", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("refreshes DB-backed place suggestions without calling the shared sheet refresh flow", async () => {
    const refreshPlaceSpy = vi
      .spyOn(CompoPlaceService.prototype, "refreshPlace")
      .mockResolvedValue({
        content: "Mode Displayed: **PLACE**",
        embeds: [],
        trackedClanTags: ["#AAA111"],
        eligibleClanTags: ["#AAA111"],
        candidateCount: 1,
        recommendedCount: 0,
        vacancyCount: 0,
        compositionCount: 1,
      });
    const sheetRefreshSpy = vi.spyOn(
      SheetRefreshService,
      "triggerSharedSheetRefresh",
    );
    const customId = buildCompoRefreshCustomIdForTest({
      kind: "place",
      userId: "user-1",
      weight: 145000,
    });
    const interaction = makeInteraction(customId);

    await handleCompoRefreshButton(interaction as any, {} as any);

    expect(refreshPlaceSpy).toHaveBeenCalledWith(145000, "TH15");
    expect(sheetRefreshSpy).not.toHaveBeenCalled();
    const payload = interaction.editReply.mock.calls.at(-1)?.[0];
    expect(String(payload?.content ?? "")).toContain("Mode Displayed: **PLACE**");
    expect(interaction.followUp).not.toHaveBeenCalled();
  });
});
