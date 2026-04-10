import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCompoRefreshCustomIdForTest,
  handleCompoRefreshButton,
} from "../src/commands/Compo";
import { CompoWarStateService } from "../src/services/CompoWarStateService";
import * as SheetRefreshService from "../src/services/SheetRefreshService";

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

describe("compo war refresh button behavior", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("refreshes DB-backed war mode without calling the shared sheet refresh flow", async () => {
    const refreshStateSpy = vi
      .spyOn(CompoWarStateService.prototype, "refreshState")
      .mockResolvedValue({
        stateRows: [
          ["Clan", "Total", "Missing", "Players", "TH18", "TH17", "TH16", "TH15", "TH14", "<=TH13"],
          ["Alpha Clan", "7,000,000", "0", "50", "0", "0", "0", "0", "0", "0"],
        ],
        contentLines: [
          "Mode Displayed: **WAR**",
          "Persisted WAR data last refreshed: <t:1775817600:F>",
        ],
        trackedClanTags: ["#AAA111"],
        snapshotClanTags: ["#AAA111"],
        renderableClanTags: ["#AAA111"],
      });
    const sheetRefreshSpy = vi.spyOn(SheetRefreshService, "triggerSharedSheetRefresh");
    const customId = buildCompoRefreshCustomIdForTest({
      kind: "state",
      userId: "user-1",
      mode: "war",
    });
    const interaction = makeInteraction(customId);

    await handleCompoRefreshButton(interaction as any, {} as any);

    expect(refreshStateSpy).toHaveBeenCalledTimes(1);
    expect(sheetRefreshSpy).not.toHaveBeenCalled();
    const payload = interaction.editReply.mock.calls.at(-1)?.[0];
    expect(String(payload?.content ?? "")).toContain("Mode Displayed: **WAR**");
    expect(Array.isArray(payload?.files)).toBe(true);
    expect(interaction.followUp).not.toHaveBeenCalled();
  });
});
